/**
 * dsh-model-rotation — 有序多 provider / 多账号模型轮询 + 额度用尽自动切换
 *
 * 需求：Gemini Flash → Claude → GPT 这样按顺序排队；前一个额度用完 / 报错时
 * 自动切到下一个；成功的那档继续用；失败的那档进冷却、冷却期内跳过；
 * 全部冷却时 fail-open（仍然按链顺序试一遍），保证不把请求直接打死。
 *
 * v0.2 新增：
 *   - 手动排序：`/rotation order 3,1,2` / `move` / `up` / `down`，顺序即优先级。
 *   - 自动排序：`/rotation sort auto`，每次调用前按「健康度 + 延迟」给候选打分重排
 *     （偏好可选 speed / reliability / balanced）。
 *   - 预设：`presets` 里预先把「用哪个模型 + 思考强度」配好，`/rotation preset use <id>`
 *     一键切换；`/rotation preset save <id>` 把当前链存成新预设。
 *   - 运行期用命令改过的链 / 排序模式 / 预设会落到状态文件，重启后还在。
 *
 * 实现方式：注册一个「虚拟 provider」，它自己不是真实模型，而是一个分发器。
 * 会话里选中 `rotation/auto` 后，每次模型调用都由本插件在 `stream()` 里
 * 按链顺序把请求委托给真实的 provider/model（ctx.llm.stream），
 * 在「还没向调用方吐出任何内容」之前失败就换下一档，已经吐过内容就只能报错。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-model-rotation'
export const inject = ['llm', 'commands']

const TAG = '[dsh-model-rotation] '

/**
 * 「硬失败」：重试也不会好，按「额度冷却」处理（默认 15 分钟），换下一档。
 * 除了额度/鉴权，还包含地区资格类失败 —— 实测 agy 的 Gemini 会因「账号/地区不适用」
 * 每次都先失败 10~30 秒才轮到下一档，必须一次性拉长冷却，不能 30 秒后又试一遍。
 */
const QUOTA_CODES = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'QUOTA_EXCEEDED',
  'RATE_LIMIT',
  'AUTH',
  'INVALID_CREDENTIAL',
  'PAYMENT_REQUIRED',
  'CREDITS_EXHAUSTED',
  'ELIGIBILITY',
  'NOT_ELIGIBLE',
  'LOCATION_NOT_SUPPORTED',
])
/** 中止不算失败：直接透传，不切换、不冷却 */
const ABORT_CODES = new Set(['ABORTED', 'CANCELLED'])

/** 思考强度写法：这些值表示「不覆盖 / 交给候选模型默认」 */
const EFFORT_INHERIT = new Set(['', 'inherit', 'default', 'auto', '-'])
/** 这些值表示「强制不带思考强度」 */
const EFFORT_NONE = new Set(['none', 'off', 'no'])

const SORT_MODES = new Set(['manual', 'auto'])
const AUTO_PREFERENCES = new Set(['balanced', 'speed', 'reliability'])

/** 自动排序里健康度/延迟的指数加权系数（越大越看重最近一次） */
const EWMA_ALPHA = 0.35

/**
 * 分组名：一个 provider 就是一个「分组」。
 * 用户装了 agy / Codex 两个账号插件、又配了两家 DeepSeek API，再算上内置 DeepSeek，
 * 这些在 provider id 上是天然分开的；这里只是给它们一个好认的中文名。
 */
const KNOWN_GROUPS = {
  antigravity: { label: 'agy 账号池（Gemini / Claude / GPT-OSS）', order: 10 },
  'openai-codex': { label: 'Codex 订阅（ChatGPT 账号）', order: 20 },
  'xiao-deepseek': { label: 'DeepSeek API（xiao-deepseek）', order: 30 },
  apixiao: { label: 'GPT API（apixiao）', order: 40 },
  'deepseek-official': { label: 'DeepSeek 内置（官方账号）', order: 50 },
  'deepseek-account': { label: 'DeepSeek 账号池（API Key 账号）', order: 60 },
}

/** 某一档候选属于哪个分组（`group` 字段可覆盖，默认就是 provider id） */
function groupIdOf(cand) {
  const override = asString(cand?.group)
  if (override) return override
  return asString(cand?.provider) || 'unknown'
}

/** 分组显示名；已知 provider 用中文名，未知 provider 用 provider 名 */
function groupLabelOf(cand, providerNames) {
  const id = groupIdOf(cand)
  if (providerNames && providerNames instanceof Map && providerNames.has(id)) {
    const live = providerNames.get(id)
    const known = KNOWN_GROUPS[id]
    return known ? `${known.label} · ${live}` : live
  }
  const known = KNOWN_GROUPS[id]
  return known ? known.label : id
}

/** 分组短名（去掉括号里的说明），给状态行做前缀用 */
function groupShortLabelOf(cand) {
  const label = groupLabelOf(cand)
  return label.split('（')[0].trim()
}

/**
 * 默认轮询链 —— 用户举的例子，从第一性出发就是「先贵后便宜、先外部订阅后自有 API 再兜底」：
 *   1. agy 的 Gemini 3.8 Flash，思考强度 high（账号池里最不值钱、上下文最大的一档）
 *   2. Codex 订阅的 GPT-6.1 Sol，high（订阅额度，质量高）
 *   3. xiao-DeepSeek 的 deepseek-flash（按量 API，便宜）
 *   4. 内置 DeepSeek 的 deepseek-flash（官方账号兜底，最后一道保险）
 */
const DEFAULT_CHAIN = [
  {
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    reasoningEffort: 'high',
    enabled: true,
  },
  {
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    label: 'Codex GPT-6.1 Sol',
    reasoningEffort: 'high',
    enabled: true,
  },
  { provider: 'xiao-deepseek', model: 'deepseek-flash', label: 'xiao-DeepSeek Flash', enabled: true },
  { provider: 'deepseek-official', model: 'deepseek-flash', label: '内置 DeepSeek Flash（兜底）', enabled: true },
]

/** 内置预设：模型 + 思考强度一次配好，`/rotation preset use <id>` 直接切 */
const BUILTIN_PRESETS = [
  {
    id: 'example',
    label: '示例链（Gemini 3.8 high → Codex 6.1 Sol high → xiao-DeepSeek → 内置 DeepSeek）',
    chain: DEFAULT_CHAIN.map((item) => ({ ...item })),
  },
  {
    id: 'fast',
    label: '速度优先（Flash / Luna 打头）',
    chain: [
      { provider: 'antigravity', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', reasoningEffort: 'low' },
      { provider: 'antigravity', model: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B' },
      { provider: 'apixiao', model: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { provider: 'xiao-deepseek', model: 'deepseek-flash', label: 'xiao-DeepSeek Flash' },
      { provider: 'deepseek-official', model: 'deepseek-flash', label: '内置 DeepSeek Flash（兜底）' },
    ],
  },
  {
    id: 'coding',
    label: '代码优先（Claude / GPT Sol 打头）',
    chain: [
      { provider: 'antigravity', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { provider: 'openai-codex', model: 'gpt-6.1-sol', label: 'Codex GPT-6.1 Sol', reasoningEffort: 'high' },
      { provider: 'apixiao', model: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { provider: 'xiao-deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', reasoningEffort: 'high' },
      { provider: 'deepseek-official', model: 'deepseek-flash', label: '内置 DeepSeek Flash（兜底）' },
    ],
  },
  {
    id: 'quality',
    label: '质量优先（Opus / GPT-6.1 打头）',
    chain: [
      { provider: 'antigravity', model: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
      { provider: 'openai-codex', model: 'gpt-6.1-sol', label: 'Codex GPT-6.1 Sol', reasoningEffort: 'high' },
      { provider: 'apixiao', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol（API）' },
      { provider: 'xiao-deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', reasoningEffort: 'high' },
      { provider: 'deepseek-official', model: 'deepseek-flash', label: '内置 DeepSeek Flash（兜底）' },
    ],
  },
]

const CandidateSchema = Schema.object({
  provider: Schema.string()
    .required()
    .description(
      '模型 provider ID，也就是「分组」：antigravity / openai-codex / xiao-deepseek / apixiao / deepseek-official / deepseek-account',
    ),
  model: Schema.string().required().description('模型 ID，例如 gemini-3.8-flash / gpt-6.1-sol / deepseek-flash'),
  group: Schema.string().description('分组显示名（可选；留空=按 provider 分组，用于把多个同源 provider 合并成一组）'),
  label: Schema.string().description('显示名（可选，仅用于展示）'),
  enabled: Schema.boolean().default(true).description('是否参与轮询'),
  reasoningEffort: Schema.string().description(
    '思考强度（如 low/medium/high/xhigh）；留空=沿用会话当前值，填 none=强制不带',
  ),
})

const PresetSchema = Schema.object({
  id: Schema.string().required().description('预设 ID，用于 /rotation preset use <id>'),
  label: Schema.string().description('显示名'),
  chain: Schema.array(CandidateSchema).default([]).description('该预设的完整轮询链（顺序即优先级）'),
})

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  virtualProviderId: Schema.string().default('rotation').description('虚拟 provider ID（模型选择器里显示的那个）'),
  virtualModelId: Schema.string().default('auto').description('虚拟模型 ID'),
  displayName: Schema.string().default('Model Rotation').description('虚拟 provider 显示名'),

  sortMode: Schema.string()
    .default('manual')
    .description('排序模式：manual=严格按 chain 顺序；auto=每次调用按健康度/延迟自动排序'),
  autoPrefer: Schema.string()
    .default('balanced')
    .description('自动排序偏好：balanced=均衡 / speed=更快 / reliability=更稳'),
  autoAssumeLatencyMs: Schema.number()
    .default(1500)
    .description('自动排序里「还没测过」的候选的假想延迟（毫秒），只影响首次排序'),

  chain: Schema.array(CandidateSchema).default(DEFAULT_CHAIN).description('有序轮询链：靠前的优先，失败自动往后切'),
  presets: Schema.array(PresetSchema).default(BUILTIN_PRESETS).description('模型 + 思考强度预设，可一键切换'),
  activePreset: Schema.string().default('').description('启用哪个预设；留空=使用上面的 chain'),

  quotaCooldownMs: Schema.number().default(15 * 60 * 1000).description('额度/鉴权类失败后的冷却时长（毫秒）'),
  errorCooldownMs: Schema.number().default(30 * 1000).description('其它失败后的冷却时长（毫秒）'),
  passReasoningEffort: Schema.boolean().default(true).description('未在候选上指定思考强度时，是否沿用会话当前值'),
  contextWindow: Schema.number().default(1048576).description('对外声明的上下文窗口（虚拟模型用）'),
  maxTokens: Schema.number().default(0).description('对外声明的单次最大输出 token（0=不声明，由候选模型决定）'),
  logSwitches: Schema.boolean().default(true).description('切换 / 失败时打印日志'),

  autoResend: Schema.boolean()
    .default(true)
    .description('额度用尽等失败后，在 agent 循环里自动用下一档「重新发送」同一步请求（相当于再发一次消息）'),
  maxAutoResends: Schema.number().default(2).description('同一步里最多自动重发几次（每个不同模型算一档）'),
  stateFile: Schema.string().description('状态文件路径（留空=自动放在 DSH 的 state 目录下）'),
})

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function toNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function fmtRemaining(ms) {
  if (!(ms > 0)) return '0s'
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h${rm}m` : `${h}h`
}

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtPct(ratio) {
  if (!Number.isFinite(ratio)) return '—'
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
}

function errCode(err) {
  const code = err && typeof err === 'object' ? err.code : undefined
  return typeof code === 'string' && code ? code : 'ERROR'
}

function errMessage(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return String(err.message ?? err)
}

/** 常见失败码的处理建议（只用于展示，帮用户判断该换账号还是等额度） */
const FAILURE_HINTS = {
  ELIGIBILITY: '该账号/地区不适用，可换 agy 账号或代理，或把这一档停用',
  NOT_ELIGIBLE: '该账号/地区不适用，可换 agy 账号或代理，或把这一档停用',
  LOCATION_NOT_SUPPORTED: '网络地区不受支持，换代理节点或停用这一档',
  AUTH: '登录失效，重新登录该 provider',
  INVALID_CREDENTIAL: '凭据无效，重新登录该 provider',
  QUOTA: '额度用尽，等重置或换下一档',
  ACCOUNT_QUOTA: '账号额度用尽，等重置或换下一档',
  QUOTA_EXCEEDED: '额度用尽，等重置或换下一档',
  RATE_LIMIT: '请求过快，已自动冷却',
  CONTEXT_WINDOW_EXCEEDED: '上下文超了，这档不会被重试',
}

/** 失败码 → 一行建议（没有对应建议就返回空串） */
function failureHint(code) {
  return FAILURE_HINTS[code] ?? ''
}

function toLlmError(failure) {
  if (failure instanceof Error) return failure
  const code = typeof failure?.code === 'string' && failure.code ? failure.code : 'ERROR'
  return new LlmError(failure?.message ? String(failure.message) : '模型轮询链全部失败', code)
}

function abortError(signal) {
  const reason = signal?.reason
  // DOMException(AbortError) 的 code 是数字 20，这里统一成 dsh 认识的 ABORTED
  if (reason && typeof reason === 'object' && reason.name === 'AbortError') {
    return new LlmError('aborted', 'ABORTED')
  }
  if (reason instanceof Error) return reason
  return new LlmError('aborted', 'ABORTED')
}

function candidateKey(cand) {
  return `${cand.provider}/${cand.model}`
}

function candidateLabel(cand, index) {
  const name = cand.label || candidateKey(cand)
  const effort = cand.reasoningEffort && !EFFORT_NONE.has(cand.reasoningEffort) ? ` [${cand.reasoningEffort}]` : ''
  const disabled = cand.enabled === false ? '（已停用）' : ''
  return `${index == null ? '' : `#${index + 1} `}${name}${effort}${disabled}`.trim()
}

/** 规范思考强度：inherit / none / 具体值 */
function normalizeEffort(value) {
  const text = asString(value)
  if (!text) return ''
  const lower = text.toLowerCase()
  if (EFFORT_INHERIT.has(lower)) return ''
  if (EFFORT_NONE.has(lower)) return 'none'
  return text
}

function cloneEntry(entry) {
  return {
    provider: entry.provider,
    model: entry.model,
    group: entry.group ?? '',
    label: entry.label ?? '',
    enabled: entry.enabled !== false,
    reasoningEffort: entry.reasoningEffort ?? '',
  }
}

function normalizeChainEntry(item) {
  if (!item || typeof item !== 'object') return null
  const provider = asString(item.provider)
  const model = asString(item.model)
  if (!provider || !model) return null
  return {
    provider,
    model,
    group: asString(item.group),
    label: asString(item.label),
    enabled: item.enabled !== false,
    reasoningEffort: normalizeEffort(item.reasoningEffort),
  }
}

function normalizeChain(source) {
  if (!Array.isArray(source)) return []
  const out = []
  for (const item of source) {
    const entry = normalizeChainEntry(item)
    if (entry) out.push(entry)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 配置归一化（防手改 YAML 时字段缺失 / 类型不对）                       */
/* ------------------------------------------------------------------ */

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const entries = normalizeChain(cfg.chain)
  const presets = []
  const seen = new Set()
  for (const item of Array.isArray(cfg.presets) ? cfg.presets : []) {
    if (!item || typeof item !== 'object') continue
    const id = asString(item.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    presets.push({ id, label: asString(item.label), chain: normalizeChain(item.chain) })
  }
  const sortMode = asString(cfg.sortMode).toLowerCase()
  const autoPrefer = asString(cfg.autoPrefer).toLowerCase()
  return {
    enabled: cfg.enabled !== false,
    virtualProviderId: asString(cfg.virtualProviderId) || 'rotation',
    virtualModelId: asString(cfg.virtualModelId) || 'auto',
    displayName: asString(cfg.displayName) || 'Model Rotation',
    entries: entries.length ? entries : normalizeChain(DEFAULT_CHAIN),
    presets: presets.length ? presets : normalizePresets(BUILTIN_PRESETS),
    sortMode: SORT_MODES.has(sortMode) ? sortMode : 'manual',
    autoPrefer: AUTO_PREFERENCES.has(autoPrefer) ? autoPrefer : 'balanced',
    autoAssumeLatencyMs: Math.max(1, toNumber(cfg.autoAssumeLatencyMs, 1500)),
    activePreset: asString(cfg.activePreset),
    quotaCooldownMs: Math.max(0, toNumber(cfg.quotaCooldownMs, 15 * 60 * 1000)),
    errorCooldownMs: Math.max(0, toNumber(cfg.errorCooldownMs, 30 * 1000)),
    passReasoningEffort: cfg.passReasoningEffort !== false,
    contextWindow: Math.max(1, toNumber(cfg.contextWindow, 1048576)),
    maxTokens: Math.max(0, toNumber(cfg.maxTokens, 0)),
    logSwitches: cfg.logSwitches !== false,
    autoResend: cfg.autoResend !== false,
    maxAutoResends: Math.max(0, toNumber(cfg.maxAutoResends, 2)),
    stateFile: asString(cfg.stateFile),
  }
}

function normalizePresets(source) {
  const out = []
  for (const item of Array.isArray(source) ? source : []) {
    if (!item || typeof item !== 'object') continue
    const id = asString(item.id)
    if (!id) continue
    out.push({ id, label: asString(item.label), chain: normalizeChain(item.chain) })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 状态文件：命令改过的链 / 排序模式 / 预设，重启后仍然有效              */
/* ------------------------------------------------------------------ */

function defaultStateFile(cfg) {
  if (cfg.stateFile) return cfg.stateFile
  const home =
    process.env.DSH_HOME ||
    (process.env.APPDATA
      ? join(process.env.APPDATA, 'dsh-desktop', 'harness')
      : join(homedir(), '.dsh-desktop', 'harness'))
  return join(home, 'state', name, 'state.json')
}

function loadState(file, warn) {
  const empty = {
    sortMode: null,
    autoPrefer: null,
    activePreset: null,
    chainOverride: null,
    customPresets: [],
    cooldowns: [],
  }
  if (!file || !existsSync(file)) return empty
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return empty
    const sortMode = asString(parsed.sortMode).toLowerCase()
    const autoPrefer = asString(parsed.autoPrefer).toLowerCase()
    const chainOverride = normalizeChain(parsed.chainOverride)
    // 冷却表也落盘：DSH 重启后不用再拿一次 Gemini 的 10~30 秒地区失败
    const now = Date.now()
    const cooldowns = []
    for (const item of Array.isArray(parsed.cooldowns) ? parsed.cooldowns : []) {
      if (!item || typeof item !== 'object') continue
      const key = asString(item.key)
      const until = toNumber(item.until, 0)
      if (!key || !(until > now)) continue
      cooldowns.push({ key, until, code: asString(item.code), message: asString(item.message), at: toNumber(item.at, 0) })
    }
    return {
      sortMode: SORT_MODES.has(sortMode) ? sortMode : null,
      autoPrefer: AUTO_PREFERENCES.has(autoPrefer) ? autoPrefer : null,
      activePreset: typeof parsed.activePreset === 'string' ? parsed.activePreset.trim() : null,
      chainOverride: chainOverride.length ? chainOverride : null,
      customPresets: normalizePresets(parsed.customPresets),
      cooldowns,
    }
  } catch (error) {
    warn(`读取状态文件失败（已忽略）：${errMessage(error)}`)
    return empty
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, entryConfig) {
  const cfg = normalizeConfig(entryConfig)
  const log = (msg) => {
    if (!cfg.logSwitches) return
    try {
      ctx.logger?.info?.(TAG + msg)
    } catch {}
  }
  const warn = (msg) => {
    try {
      ctx.logger?.warn?.(TAG + msg)
    } catch {}
  }

  if (!cfg.enabled) {
    log('配置里 enabled=false，跳过注册')
    return
  }

  const stateFile = defaultStateFile(cfg)
  const stored = loadState(stateFile, warn)
  const runtime = {
    sortMode: stored.sortMode ?? cfg.sortMode,
    autoPrefer: stored.autoPrefer ?? cfg.autoPrefer,
    activePreset: stored.activePreset ?? cfg.activePreset,
    chainOverride: stored.chainOverride,
    customPresets: stored.customPresets,
  }

  /** key -> 健康度统计（自动排序用，也用于 status 展示） */
  const health = new Map()
  const stats = {
    calls: 0,
    switches: 0,
    lastSwitch: null,
    lastFailure: null,
    lastSuccess: null,
  }

  /**
   * 最近一次「真正回答了问题」的模型。会话头徽章（client.js）和
   * `/rotation status` 都读它，用来回答「这次回答是哪个模型给的」。
   */
  let lastAnswer = null
  /** 最近一次调用的完整尝试轨迹（成功或失败都记） */
  let lastRun = null
  // 不同会话并行调用不能互相覆盖；后台压缩/标题调用不冒充用户回答。
  const answersBySession = new Map()
  const rememberAnswer = (answer) => {
    lastAnswer = answer
    if (!answer.sessionId) return
    answersBySession.delete(answer.sessionId)
    answersBySession.set(answer.sessionId, answer)
    while (answersBySession.size > 100) answersBySession.delete(answersBySession.keys().next().value)
  }

  /** client.js 报上来的诊断/渲染事件（浏览器 console 拿不到，只能自己回传） */
  const clientReports = []
  const clientReportFile = join(dirname(stateFile), 'client-report.jsonl')
  const recordClientReport = (body) => {
    const entry = {
      at: Date.now(),
      event: asString(body?.event) || 'unknown',
      detail: body?.detail === undefined ? null : body.detail,
      page: asString(body?.page),
      agent: asString(body?.agent),
    }
    clientReports.push(entry)
    while (clientReports.length > 40) clientReports.shift()
    try {
      mkdirSync(dirname(clientReportFile), { recursive: true })
      appendFileSync(clientReportFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      /* 诊断落盘失败不影响主流程 */
    }
    return entry
  }

  /* ---------------- 生效链 ---------------- */

  const allPresets = () => {
    const map = new Map()
    for (const preset of cfg.presets) map.set(preset.id, preset)
    for (const preset of runtime.customPresets) map.set(preset.id, preset)
    return [...map.values()]
  }

  const findPreset = (id) => allPresets().find((preset) => preset.id === id)

  /** 当前生效的链（含 disabled 的条目，方便按序号 enable/disable） */
  const currentChain = () => {
    if (runtime.activePreset) {
      const preset = findPreset(runtime.activePreset)
      if (preset && preset.chain.length) return preset.chain.map(cloneEntry)
      warn(`预设「${runtime.activePreset}」不存在或为空，回退到默认链`)
    }
    if (runtime.chainOverride && runtime.chainOverride.length) return runtime.chainOverride.map(cloneEntry)
    return cfg.entries.map(cloneEntry)
  }

  const activeEntries = () => currentChain().filter((entry) => entry.enabled !== false)

  const chainSummary = () =>
    activeEntries()
      .map((entry, i) => candidateLabel(entry, i))
      .join(' → ')

  /* ---------------- 持久化 ---------------- */

  const saveState = () => {
    const now = Date.now()
    const payload = {
      version: 1,
      sortMode: runtime.sortMode,
      autoPrefer: runtime.autoPrefer,
      activePreset: runtime.activePreset ?? '',
      chainOverride: runtime.chainOverride ? runtime.chainOverride.map(cloneEntry) : null,
      customPresets: runtime.customPresets,
      // 仍有效的冷却也一起存：重启后不用再白等一次地区/额度失败
      cooldowns: [...stateCooldowns.entries()]
        .filter(([, entry]) => entry && entry.until > now)
        .map(([key, entry]) => ({ key, until: entry.until, code: entry.code, message: entry.message, at: entry.at })),
      updatedAt: new Date().toISOString(),
    }
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      warn(`写入状态文件失败：${errMessage(error)}`)
      return false
    }
  }

  /** 任何「改链」操作：快照成 override 并退出预设模式 */
  const commitChain = (entries) => {
    runtime.chainOverride = entries.map(cloneEntry)
    runtime.activePreset = ''
    saveState()
  }

  /* ---------------- 冷却 / 健康度 ---------------- */

  /** key -> { until, code, message, at } */
  const stateCooldowns = new Map()
  for (const item of stored.cooldowns ?? []) {
    stateCooldowns.set(item.key, { until: item.until, code: item.code, message: item.message, at: item.at })
  }
  if (stateCooldowns.size) log(`从状态文件恢复 ${stateCooldowns.size} 档冷却`)

  const cooldownOf = (cand) => stateCooldowns.get(candidateKey(cand))

  const isCooling = (cand, now = Date.now()) => {
    const entry = cooldownOf(cand)
    return !!entry && entry.until > now
  }

  const healthOf = (cand) => {
    const key = candidateKey(cand)
    let entry = health.get(key)
    if (!entry) {
      entry = {
        attempts: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        relEwma: 0.8,
        latEwma: cfg.autoAssumeLatencyMs,
        lastOkAt: 0,
        lastErrorAt: 0,
      }
      health.set(key, entry)
    }
    return entry
  }

  const markFailure = (cand, failure) => {
    const code = errCode(failure)
    const ms = QUOTA_CODES.has(code) ? cfg.quotaCooldownMs : cfg.errorCooldownMs
    const at = Date.now()
    stats.lastFailure = { key: candidateKey(cand), code, message: errMessage(failure), at }
    const entry = healthOf(cand)
    entry.attempts += 1
    entry.failures += 1
    entry.consecutiveFailures += 1
    entry.relEwma = (1 - EWMA_ALPHA) * entry.relEwma
    entry.lastErrorAt = at
    if (ms <= 0) return
    stateCooldowns.set(candidateKey(cand), { until: at + ms, code, message: errMessage(failure), at })
    // 冷却落盘：DSH 重启后仍跳过这一档，不再白等一次地区/额度失败
    saveState()
  }

  const markSuccess = (cand, latencyMs) => {
    const key = candidateKey(cand)
    if (stateCooldowns.delete(key)) {
      log(`${key} 恢复正常，清除冷却`)
      saveState()
    }
    const entry = healthOf(cand)
    entry.attempts += 1
    entry.successes += 1
    entry.consecutiveFailures = 0
    entry.relEwma = EWMA_ALPHA + (1 - EWMA_ALPHA) * entry.relEwma
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      entry.latEwma = entry.attempts <= 1 ? latencyMs : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * entry.latEwma
    }
    entry.lastOkAt = Date.now()
    stats.lastSuccess = { key, at: Date.now() }
  }

  /* ---------------- 排序 ---------------- */

  /** 自动排序里的候选打分（越大越优先） */
  const scoreOf = (cand) => {
    const entry = healthOf(cand)
    const rel = entry.attempts > 0 ? entry.relEwma : 0.8
    const lat = entry.attempts > 0 ? entry.latEwma : cfg.autoAssumeLatencyMs
    const speed = 1 - Math.min(lat, 30_000) / 30_000
    let score
    if (runtime.autoPrefer === 'speed') score = 0.2 * rel + 0.8 * speed
    else if (runtime.autoPrefer === 'reliability') score = 0.85 * rel + 0.15 * speed
    else score = 0.5 * rel + 0.5 * speed
    score -= Math.min(entry.consecutiveFailures, 3) * 0.12
    return score
  }

  /**
   * 链排序：
   *  - manual：完全按链顺序（冷却中的挪到最后，按到期时间排）
   *  - auto：先分「健康 / 冷却中」，健康组按打分降序、同分按链序
   *  全部都在冷却时按到期时间排序（fail-open，保证总有一档会被尝试）
   */
  const orderedCandidates = () => {
    const now = Date.now()
    const chain = currentChain()
    const live = []
    const cooling = []
    chain.forEach((cand, index) => {
      if (cand.enabled === false) return
      const cd = cooldownOf(cand)
      if (cd && cd.until > now) cooling.push({ cand, index, until: cd.until })
      else live.push({ cand, index })
    })
    if (runtime.sortMode === 'auto') {
      live.sort((a, b) => scoreOf(b.cand) - scoreOf(a.cand) || a.index - b.index)
    } else {
      live.sort((a, b) => a.index - b.index)
    }
    cooling.sort((a, b) => a.until - b.until)
    const ordered = live.concat(cooling).map((item) => item.cand)
    if (!ordered.length) {
      // 链里全部被停用：退化成「所有条目都试一遍」，避免直接 NO_CANDIDATE
      return chain.map(cloneEntry)
    }
    return ordered
  }

  /* ---------------- 委托参数 ---------------- */

  const delegationOf = (options, cand) => {
    const out = { ...options, provider: cand.provider, model: cand.model }
    if (!cfg.passReasoningEffort) delete out.reasoningEffort
    const effort = cand.reasoningEffort
    if (effort && EFFORT_NONE.has(effort)) delete out.reasoningEffort
    else if (effort) out.reasoningEffort = effort
    return out
  }

  /* ---------------------------------------------------------------- */
  /* 适配器：把请求按链顺序委托给真实 provider                          */
  /* ---------------------------------------------------------------- */

  class RotationAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: cfg.displayName }
    }

    /** 外层不要再重试：重试由本插件的链 + 冷却自己做，避免延迟翻倍 */
    providerRetryPolicy() {
      return {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: [],
        initialDelayMs: 500,
        maxDelayMs: 500,
        jitterRatio: 0,
      }
    }

    async listModels(provider) {
      return [
        {
          provider,
          id: cfg.virtualModelId,
          name: 'Auto（自动轮询）',
          description:
            `排序=${runtime.sortMode}${runtime.sortMode === 'auto' ? `/${runtime.autoPrefer}` : ''}` +
            `${runtime.activePreset ? ` · 预设=${runtime.activePreset}` : ''}。尝试顺序：${chainSummary()}`,
          inputModalities: ['text', 'image'],
        },
      ]
    }

    async resolveModel(provider, model /*, signal */) {
      const info = {
        provider,
        id: model,
        name: 'Auto（自动轮询）',
        description: `排序=${runtime.sortMode}；尝试顺序：${chainSummary()}`,
        inputModalities: ['text', 'image'],
        context: { contextWindow: cfg.contextWindow },
      }
      if (cfg.maxTokens > 0) info.defaultMaxTokens = cfg.maxTokens
      return info
    }

    async prepareCall(provider, model, signal) {
      if (signal?.aborted) throw abortError(signal)
      const self = this
      return {
        model: await self.resolveModel(provider, model, signal),
        stream: (options) => self.stream({ ...options, signal: options.signal ?? signal }),
      }
    }

    async *stream(options) {
      stats.calls += 1
      const attempts = orderedCandidates()
      const chain = currentChain()
      const runStartedAt = Date.now()
      const sessionId = options.sessionId === undefined ? null : String(options.sessionId)
      const trail = []
      let lastFailure = null
      let attempted = 0

      const closeRun = (ok, final) => {
        lastRun = {
          ok,
          at: Date.now(),
          elapsedMs: Date.now() - runStartedAt,
          sessionId,
          attempts: trail.slice(),
          final,
        }
      }

      for (const cand of attempts) {
        if (options.signal?.aborted) throw abortError(options.signal)

        const delegation = delegationOf(options, cand)

        // 自我保护：候选不能指回虚拟 provider 自己
        if (delegation.provider === cfg.virtualProviderId) {
          warn('轮询链里出现了虚拟 provider 自身，已跳过')
          continue
        }

        attempted += 1
        const index = chain.findIndex((entry) => candidateKey(entry) === candidateKey(cand))
        const startedAt = Date.now()
        let committed = false
        let firstChunkAt = 0
        let failure = null

        try {
          for await (const chunk of ctx.llm.stream(delegation)) {
            if (chunk && chunk.type === 'finish') {
              const kind = chunk.reason?.kind
              if (kind === 'error' || kind === 'aborted') {
                failure =
                  chunk.reason?.failure ?? {
                    code: kind === 'aborted' ? 'ABORTED' : 'ERROR',
                    message: `模型调用失败（${candidateKey(cand)}）`,
                  }
                break
              }
            }
            if (chunk && chunk.type !== 'usage') {
              committed = true
              if (!firstChunkAt) firstChunkAt = Date.now()
            }
            yield chunk
          }
          if (!failure) {
            const latencyMs = firstChunkAt ? firstChunkAt - startedAt : Date.now() - startedAt
            markSuccess(cand, latencyMs)
            trail.push({
              key: candidateKey(cand),
              label: candidateLabel(cand, index),
              group: groupShortLabelOf(cand),
              provider: cand.provider,
              model: cand.model,
              reasoningEffort: cand.reasoningEffort || '',
              ok: true,
              latencyMs,
              ttftMs: firstChunkAt ? firstChunkAt - startedAt : 0,
              totalMs: Date.now() - startedAt,
            })
            if (!options.purpose) rememberAnswer({
              at: Date.now(),
              mode: 'rotation',
              sessionId,
              provider: cand.provider,
              model: cand.model,
              key: candidateKey(cand),
              label: candidateLabel(cand, index),
              group: groupIdOf(cand),
              groupLabel: groupLabelOf(cand),
              groupShort: groupShortLabelOf(cand),
              reasoningEffort: delegation.reasoningEffort || '',
              latencyMs,
              elapsedMs: Date.now() - runStartedAt,
              switched: trail.length - 1,
              attempts: trail.slice(),
              sortMode: runtime.sortMode,
              preset: runtime.activePreset || '',
            })
            closeRun(true, {
              provider: cand.provider,
              model: cand.model,
              key: candidateKey(cand),
              label: candidateLabel(cand, index),
              latencyMs,
            })
            return
          }
        } catch (error) {
          failure = error
        }

        const code = errCode(failure)

        // 用户主动中止：不切换、不冷却
        if (ABORT_CODES.has(code) || options.signal?.aborted) {
          trail.push({
            key: candidateKey(cand),
            label: candidateLabel(cand, index),
            group: groupShortLabelOf(cand),
            provider: cand.provider,
            model: cand.model,
            ok: false,
            code,
            message: errMessage(failure),
            totalMs: Date.now() - startedAt,
          })
          closeRun(false, { code, message: errMessage(failure) })
          throw toLlmError(failure)
        }

        markFailure(cand, failure)
        stats.switches += 1
        stats.lastSwitch = {
          from: candidateKey(cand),
          code,
          message: errMessage(failure),
          at: Date.now(),
        }
        lastFailure = failure
        trail.push({
          key: candidateKey(cand),
          label: candidateLabel(cand, index),
          group: groupShortLabelOf(cand),
          provider: cand.provider,
          model: cand.model,
          ok: false,
          code,
          message: errMessage(failure),
          hint: failureHint(code) || '',
          committed,
          totalMs: Date.now() - startedAt,
        })

        if (committed) {
          // 已经吐过内容，会话侧无法安全重来
          log(`${candidateLabel(cand, index)} 失败（${code}），但已输出部分内容，不再切换`)
          closeRun(false, { code, message: errMessage(failure), committed: true })
          throw toLlmError(failure)
        }

        const hint = failureHint(code)
        log(
          `${candidateLabel(cand, index)} 失败（${code}${hint ? '，' + hint : ''}：${errMessage(failure)}），切换下一档`,
        )
      }

      if (!attempted) {
        closeRun(false, { code: 'NO_CANDIDATE', message: '轮询链里没有可用的候选模型' })
        throw new LlmError('轮询链里没有可用的候选模型', 'NO_CANDIDATE')
      }
      closeRun(false, { code: errCode(lastFailure), message: errMessage(lastFailure) })
      throw toLlmError(lastFailure)
    }
  }

  const adapter = new RotationAdapter()

  /* ------------------------------------------------------------------ */
  /* 「这次是谁答的」——对所有直连 provider 也生效                          */
  /* ------------------------------------------------------------------ */
  // 轮询模式下的回答由 adapter.stream 自己记录（带完整切换轨迹）。但用户切到
  // 某个具体模型直连时，adapter 不参与，徽章就空了。这里挂一层 `llm/stream`
  // waterfall：只观察、不改写，把真正完成的那次调用记进同一个 lastAnswer 表。
  // 轮询内部委托出去的叶子调用也会经过这里，但随后被 adapter 的记录覆盖（信息更全）。
  const observeStream = (options, next) => {
    const provider = options?.provider
    if (!provider || options?.purpose) return next()
    if (provider === cfg.virtualProviderId) return next()
    const inner = next()
    return (async function* pause() {
      const startedAt = Date.now()
      let firstAt = 0
      let finishKind = 'stop'
      try {
        for await (const chunk of inner) {
          if (chunk && chunk.type === 'finish') finishKind = chunk.reason?.kind ?? 'stop'
          else if (chunk && chunk.type !== 'usage' && !firstAt) firstAt = Date.now()
          yield chunk
        }
      } finally {
        if (finishKind !== 'error' && finishKind !== 'aborted') {
          try {
            const latencyMs = firstAt ? firstAt - startedAt : Date.now() - startedAt
            const cand = { provider, group: options.group }
            rememberAnswer({
              at: Date.now(),
              mode: 'direct',
              sessionId: options.sessionId === undefined ? null : String(options.sessionId),
              provider,
              model: options.model,
              key: `${provider}/${options.model}`,
              label: options.model,
              group: groupIdOf(cand),
              groupLabel: groupLabelOf(cand),
              groupShort: groupShortLabelOf(cand),
              reasoningEffort: options.reasoningEffort || '',
              latencyMs,
              elapsedMs: Date.now() - startedAt,
              switched: 0,
              attempts: [],
              sortMode: runtime.sortMode,
              preset: runtime.activePreset || '',
            })
          } catch {}
        }
      }
    })()
  }

  try {
    ctx.on('llm/stream', observeStream)
  } catch (error) {
    warn(`监听 llm/stream 失败（直连模型的徽章会缺失）：${errMessage(error)}`)
  }

  /* ------------------------------------------------------------------ */
  /* 额度用尽 → 自动「再发一次」：在 agent 循环里重跑这一步，换下一档模型   */
  /* ------------------------------------------------------------------ */
  // adapter 内部的切换只在「还没吐出任何内容」时安全；若已经在输出中失败
  // （或失败发生在 step 级），这里让 agent 循环把这一步整段重发。
  // 失败的档位在 adapter 里已经进了冷却，所以重发时自然落在下一档。
  const resendBudget = new Map()
  const requestErrorHandler = async (payload, next) => {
    try {
      if (!cfg.autoResend || cfg.maxAutoResends <= 0) return next()
      if (!payload || payload.provider !== cfg.virtualProviderId) return next()
      if (payload.signal?.aborted) return next()
      if (ABORT_CODES.has(errCode(payload.failure))) return next()
      if (!lastRun || lastRun.ok) return next()
      const usable = currentChain().filter((entry) => entry.enabled !== false && !isCooling(entry))
      if (!usable.length) {
        log('自动重发跳过：链里已经没有可用档（全在冷却）')
        return next()
      }
      const key = `${payload.turn ?? 0}:${payload.step ?? 0}`
      const used = resendBudget.get(key) || 0
      if (used >= cfg.maxAutoResends) {
        resendBudget.delete(key)
        log(`自动重发已达上限（${cfg.maxAutoResends} 次），交给 agent 循环处理`)
        return next()
      }
      resendBudget.set(key, used + 1)
      while (resendBudget.size > 200) resendBudget.delete(resendBudget.keys().next().value)
      log(`自动重发第 ${used + 1}/${cfg.maxAutoResends} 次：下次用 ${candidateKey(usable[0])}`)
      return { kind: 'retry' }
    } catch {
      return next()
    }
  }
  try {
    ctx.on('agent/request-error', requestErrorHandler)
  } catch (error) {
    warn(`监听 agent/request-error 失败（自动重发不可用）：${errMessage(error)}`)
  }

  let registration
  try {
    registration = ctx.llm.registerAdapter([cfg.virtualProviderId], adapter)
    log(
      `已注册 provider「${cfg.virtualProviderId}」（模型 ${cfg.virtualModelId}），` +
        `排序=${runtime.sortMode}${runtime.activePreset ? `，预设=${runtime.activePreset}` : ''}，链：${chainSummary()}`,
    )
  } catch (error) {
    warn(`注册 provider 失败：${errMessage(error)}`)
    return
  }

  ctx.effect(() => () => {
    try {
      if (typeof registration === 'function') registration()
    } catch {}
  })

  try {
    ctx.emit('llm/adapters-updated')
  } catch {}

  /* ---------------------------------------------------------------- */
  /* 状态文本 / 探活                                                   */
  /* ---------------------------------------------------------------- */

  const chainLines = () => {
    const now = Date.now()
    const chain = currentChain()
    const preferred = runtime.sortMode === 'auto' ? orderedCandidates() : null
    return chain.map((cand, i) => {
      const cd = cooldownOf(cand)
      const entry = healthOf(cand)
      let mark = '✅'
      if (cand.enabled === false) mark = '⚪'
      else if (cd && cd.until > now) mark = '⏸️'
      const bits = [`[${groupShortLabelOf(cand)}] ${candidateLabel(cand, i)}`, `· ${candidateKey(cand)}`]
      if (cand.enabled === false) bits.push('· 已停用')
      else if (cd && cd.until > now) bits.push(`· 冷却 ${fmtRemaining(cd.until - now)}（${cd.code}）`)
      if (entry.attempts > 0) {
        bits.push(`· 成功 ${fmtPct(entry.relEwma)}`, `· 延迟 ${fmtMs(entry.latEwma)}`, `· 尝试 ${entry.attempts} 次`)
      } else {
        bits.push('· 未测')
      }
      if (preferred && cand.enabled !== false && !(cd && cd.until > now)) {
        const rank = preferred.findIndex((item) => candidateKey(item) === candidateKey(cand))
        if (rank >= 0) bits.push(`· 自动序 #${rank + 1}`)
      }
      return `  ${mark} ${bits.join(' ')}`
    })
  }

  const statusText = () => {
    const lines = []
    lines.push(`provider: ${cfg.virtualProviderId} · 模型: ${cfg.virtualModelId} · ${cfg.displayName}`)
    const modeText =
      runtime.sortMode === 'auto'
        ? `auto（自动排序 · 偏好 ${runtime.autoPrefer}）`
        : 'manual（手动，严格按链顺序）'
    const presetText = runtime.activePreset ? ` · 预设: ${runtime.activePreset}` : ' · 预设: 无（用 chain）'
    lines.push(`排序模式: ${modeText}${presetText}`)
    lines.push(`轮询链（${activeEntries().length}/${currentChain().length} 档启用，靠前优先）：`)
    lines.push(...chainLines())
    lines.push(
      `统计：调用 ${stats.calls} 次，切换 ${stats.switches} 次` +
        (stats.lastSuccess ? `；最近成功 ${stats.lastSuccess.key}` : '') +
        (stats.lastSwitch ? `；最近切换 ${stats.lastSwitch.from}（${stats.lastSwitch.code}）` : ''),
    )
    lines.push(
      '常用命令：/rotation sort auto|manual · /rotation order 2,1,3 · /rotation effort 1 high · ' +
        '/rotation preset use coding · /rotation models',
    )
    return lines.join('\n')
  }

  const presetsText = () => {
    const lines = ['预设（模型 + 思考强度）：']
    for (const preset of allPresets()) {
      const active = runtime.activePreset === preset.id ? ' ← 使用中' : ''
      const chain = preset.chain.length
        ? preset.chain.map((entry, i) => candidateLabel(entry, i)).join(' → ')
        : '（空）'
      lines.push(`  ${preset.id}${preset.label ? ` — ${preset.label}` : ''}${active}`)
      lines.push(`     ${chain}`)
    }
    lines.push('切换：/rotation preset use <id>；把当前链存成预设：/rotation preset save <id>')
    return lines.join('\n')
  }

  const reset = () => {
    const count = stateCooldowns.size
    stateCooldowns.clear()
    health.clear()
    stats.switches = 0
    stats.lastSwitch = null
    stats.lastFailure = null
    stats.lastSuccess = null
    saveState()
    return `已清除 ${count} 条冷却记录，健康度统计已重置`
  }

  const resetAll = () => {
    runtime.sortMode = cfg.sortMode
    runtime.autoPrefer = cfg.autoPrefer
    runtime.activePreset = cfg.activePreset
    runtime.chainOverride = null
    runtime.customPresets = []
    stateCooldowns.clear()
    health.clear()
    try {
      if (existsSync(stateFile)) rmSync(stateFile, { force: true })
    } catch (error) {
      warn(`删除状态文件失败：${errMessage(error)}`)
    }
    return `已恢复配置默认：排序=${runtime.sortMode}，预设=${runtime.activePreset || '无'}，链：${chainSummary()}`
  }

  const PROBE_PROMPT = '这是连通性检测，请只回复两个字母：ok'
  const promptOf = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : ''
    return text || PROBE_PROMPT
  }

  /** 直连某一档候选（绕过轮询链），返回一行结果 */
  const probeOne = async (cand, prompt, signal) => {
    const started = Date.now()
    let text = ''
    let failure = null
    try {
      for await (const chunk of ctx.llm.stream({
        ...delegationOf({}, cand),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 128,
        signal,
      })) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
        if (chunk && chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            failure = chunk.reason?.failure ?? { code: 'ABORTED', message: 'aborted' }
            break
          }
        }
      }
    } catch (error) {
      failure = error
    }
    const ms = Date.now() - started
    if (failure) {
      const code = errCode(failure)
      const hint = failureHint(code)
      return `  ❌ [${groupShortLabelOf(cand)}] ${candidateLabel(cand)} — ${code}：${errMessage(failure)}（${ms}ms）${
        hint ? `\n       ↳ ${hint}` : ''
      }`
    }
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 40)
    return `  ✅ [${groupShortLabelOf(cand)}] ${candidateLabel(cand)} — ${ms}ms${preview ? ` · ${preview}` : ''}`
  }

  const probeAll = async (prompt, signal, onlyIndex, onlyGroup) => {
    const chain = currentChain()
    let targets
    let label = ''
    if (onlyGroup) {
      targets = chain.filter((entry) => groupIdOf(entry) === onlyGroup || groupShortLabelOf(entry) === onlyGroup)
      label = `分组 ${onlyGroup} `
    } else if (onlyIndex == null) {
      targets = chain.filter((entry) => entry.enabled !== false)
    } else {
      targets = [chain[onlyIndex]].filter(Boolean)
    }
    if (!targets.length) return `没有可探测的候选（${label}检查分组 id / 序号 / 是否被停用）`
    const lines = [`逐个直连探测（${label}${targets.length} 档，绕过冷却与轮询）：`]
    for (const cand of targets) {
      if (signal?.aborted) {
        lines.push('  （已中止）')
        break
      }
      lines.push(await probeOne(cand, prompt, signal))
    }
    return lines.join('\n')
  }

  /** 端到端走一遍虚拟 provider（验证切换逻辑本身） */
  const probeAuto = async (prompt, signal) => {
    const started = Date.now()
    let text = ''
    let failure = null
    try {
      for await (const chunk of ctx.llm.stream({
        provider: cfg.virtualProviderId,
        model: cfg.virtualModelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 128,
        signal,
      })) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
        if (chunk && chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            failure = chunk.reason?.failure ?? { code: 'ABORTED', message: 'aborted' }
            break
          }
        }
      }
    } catch (error) {
      failure = error
    }
    const ms = Date.now() - started
    if (failure) {
      return `❌ 端到端（${cfg.virtualProviderId}/${cfg.virtualModelId}）失败 — ${errCode(failure)}：${errMessage(failure)}（${ms}ms）`
    }
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 60)
    return `✅ 端到端（${cfg.virtualProviderId}/${cfg.virtualModelId}）成功 — ${ms}ms${preview ? ` · ${preview}` : ''}`
  }

  /** 模型目录缓存：{ key -> { effortIds, defaultEffort, contextWindow, at } }，5 分钟过期 */
  const infoCache = new Map()
  const INFO_TTL_MS = 5 * 60 * 1000
  const resolveInfo = async (provider, model, signal) => {
    const key = `${provider}/${model}`
    const hit = infoCache.get(key)
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit
    let efforts = []
    let defaultEffort = ''
    let contextWindow = 0
    try {
      const resolved = await ctx.llm.resolveModelInfo(provider, model, signal)
      efforts = (resolved?.reasoning?.efforts ?? []).map((item) => item.id)
      defaultEffort = resolved?.reasoning?.defaultEffort ?? ''
      contextWindow = Number(resolved?.context?.contextWindow ?? 0) || 0
    } catch {
      /* 拿不到强度就当没有 */
    }
    const value = { provider, model, efforts, defaultEffort, contextWindow, at: Date.now() }
    infoCache.set(key, value)
    return value
  }

  /** 列出所有 provider / 模型 / 可用思考强度（按来源分组），方便挑模型组链 */
  const modelsText = async (signal) => {
    let providers = []
    try {
      providers = await ctx.llm.listProviders()
    } catch (error) {
      return `无法列出 provider：${errMessage(error)}`
    }
    const inChain = new Set(currentChain().map(candidateKey))
    const groups = new Map()
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!provider?.id) continue
      if (provider.id === cfg.virtualProviderId) continue
      const id = provider.id
      const known = KNOWN_GROUPS[id]
      const label = known ? known.label : id
      if (!groups.has(label)) groups.set(label, { label, order: known?.order ?? 999, items: [] })
      groups.get(label).items.push(provider)
    }
    const sorted = [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    const lines = ['可用 provider / 模型（按来源分组，* = 已在当前链里）：']
    for (const group of sorted) {
      lines.push(`  ▸ ${group.label}`)
      for (const provider of group.items) {
        lines.push(`      ${provider.id}${provider.name ? ` — ${provider.name}` : ''}`)
        let models = []
        try {
          models = await ctx.llm.listModels(provider.id)
        } catch (error) {
          lines.push(`        （listModels 失败：${errMessage(error)}）`)
          continue
        }
        for (const model of (Array.isArray(models) ? models : []).slice(0, 40)) {
          const key = `${provider.id}/${model.id}`
          const info = await resolveInfo(provider.id, model.id, signal)
          let effort = ''
          if (info.efforts.length) {
            effort = ` · 强度: ${info.efforts.join('/')}`
            if (info.defaultEffort) effort += `（默认 ${info.defaultEffort}）`
          }
          lines.push(`        ${inChain.has(key) ? '*' : ' '} ${key} — ${model.name ?? model.id}${effort}`)
        }
      }
    }
    lines.push('按分组筛选查看：/rotation groups；加进链：/rotation add <provider>/<model> [强度]')
    return lines.join('\n')
  }

  /** 只看分组：每组有哪些 provider、多少模型、链里占几档 */
  const groupsText = async (signal) => {
    let providers = []
    try {
      providers = await ctx.llm.listProviders()
    } catch (error) {
      return `无法列出 provider：${errMessage(error)}`
    }
    const chain = currentChain()
    const byProvider = new Map()
    for (const cand of chain) {
      const list = byProvider.get(cand.provider) ?? []
      list.push(candidateKey(cand))
      byProvider.set(cand.provider, list)
    }
    const rows = []
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!provider?.id || provider.id === cfg.virtualProviderId) continue
      const known = KNOWN_GROUPS[provider.id]
      let count = 0
      let note = ''
      try {
        count = ((await ctx.llm.listModels(provider.id)) ?? []).length
      } catch (error) {
        note = `（失败：${errMessage(error)}）`
      }
      rows.push({
        id: provider.id,
        label: known ? known.label : `${provider.id}`,
        order: known?.order ?? 999,
        name: provider.name ?? provider.id,
        count,
        note,
        inChain: byProvider.get(provider.id) ?? [],
      })
    }
    rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const lines = ['分组（= 来源 provider）：']
    for (const row of rows) {
      const chainText = row.inChain.length ? ` · 链里 ${row.inChain.length} 档：${row.inChain.join('、')}` : ' · 链里没有'
      lines.push(`  ▸ ${row.label}（${row.id} — ${row.name}）`)
      lines.push(`      模型 ${row.count} 个${row.note}${chainText}`)
    }
    lines.push('加进链：/rotation add <provider>/<model> [强度]；看每组的模型：/rotation models')
    return lines.join('\n')
  }

  /* ---------------------------------------------------------------- */
  /* 排序 / 链编辑                                                     */
  /* ---------------------------------------------------------------- */

  const sortText = () => {
    const modeText =
      runtime.sortMode === 'auto'
        ? `auto（自动排序 · 偏好 ${runtime.autoPrefer}）`
        : 'manual（手动，严格按链顺序）'
    return `当前排序模式：${modeText}\n${runtime.sortMode === 'auto' ? `当前自动顺序：${orderedCandidates().map((c) => candidateKey(c)).join(' → ')}` : `当前链顺序：${chainSummary()}`}\n自动排序按「健康度 + 延迟」打分，偏好可用 /rotation sort auto speed|reliability|balanced 调。`
  }

  const applySort = (modeArg, preferArg) => {
    if (!modeArg) return sortText()
    const mode = modeArg.toLowerCase()
    if (!SORT_MODES.has(mode)) return { error: `未知排序模式：${modeArg}（manual | auto）` }
    runtime.sortMode = mode
    if (preferArg) {
      const prefer = preferArg.toLowerCase()
      if (!AUTO_PREFERENCES.has(prefer)) return { error: `未知偏好：${preferArg}（balanced | speed | reliability）` }
      runtime.autoPrefer = prefer
    }
    saveState()
    return sortText()
  }

  const parseIndex = (token, chain) => {
    const n = Number.parseInt(String(token ?? ''), 10)
    if (!Number.isFinite(n) || n < 1 || n > chain.length) {
      return { error: `序号无效：${token}（范围 1-${chain.length}）` }
    }
    return { index: n - 1 }
  }

  const reorderByIndices = (raw) => {
    const chain = currentChain()
    const tokens = String(raw ?? '')
      .split(/[\s,，]+/)
      .filter(Boolean)
    if (!tokens.length) return { error: '用法：/rotation order 2,1,3（写全 1..N 的排列，或只写要前置的那几档）' }
    const picked = []
    for (const token of tokens) {
      const parsed = parseIndex(token, chain)
      if (parsed.error) return { error: parsed.error }
      if (picked.includes(parsed.index)) return { error: `序号重复：${token}` }
      picked.push(parsed.index)
    }
    const rest = chain.map((_, i) => i).filter((i) => !picked.includes(i))
    const next = [...picked, ...rest].map((i) => cloneEntry(chain[i]))
    commitChain(next)
    return `已按新顺序保存（${runtime.sortMode === 'auto' ? '当前是自动排序，链序作为同分/回退顺序' : '手动排序立即生效'}）：\n${chainSummary()}`
  }

  const moveEntry = (fromToken, toToken) => {
    const chain = currentChain()
    const from = parseIndex(fromToken, chain)
    if (from.error) return { error: from.error }
    const to = parseIndex(toToken, chain)
    if (to.error) return { error: to.error }
    const next = chain.map(cloneEntry)
    const [item] = next.splice(from.index, 1)
    next.splice(to.index, 0, item)
    commitChain(next)
    return `已移动 #${from.index + 1} → #${to.index + 1}：\n${chainSummary()}`
  }

  const shiftEntry = (token, delta) => {
    const chain = currentChain()
    const parsed = parseIndex(token, chain)
    if (parsed.error) return { error: parsed.error }
    const target = parsed.index + delta
    if (target < 0 || target >= chain.length) return { error: '已经到边界，无法再移动' }
    const next = chain.map(cloneEntry)
    const [item] = next.splice(parsed.index, 1)
    next.splice(target, 0, item)
    commitChain(next)
    return `已移动 #${parsed.index + 1} → #${target + 1}：\n${chainSummary()}`
  }

  const setEntry = (token, spec, effort) => {
    const chain = currentChain()
    const parsed = parseIndex(token, chain)
    if (parsed.error) return { error: parsed.error }
    const text = String(spec ?? '').trim()
    const slash = text.indexOf('/')
    if (slash <= 0 || slash === text.length - 1) {
      return { error: `用法：/rotation set <序号> <provider>/<model> [强度]，例如 /rotation set 2 apixiao/gpt-6-sol high` }
    }
    const provider = text.slice(0, slash).trim()
    const model = text.slice(slash + 1).trim()
    const next = chain.map(cloneEntry)
    next[parsed.index] = {
      ...next[parsed.index],
      provider,
      model,
      label: '',
      enabled: true,
      reasoningEffort: effort === undefined ? next[parsed.index].reasoningEffort : normalizeEffort(effort),
    }
    commitChain(next)
    return `已更新 #${parsed.index + 1} → ${candidateKey(next[parsed.index])}${next[parsed.index].reasoningEffort ? `（强度 ${next[parsed.index].reasoningEffort}）` : ''}\n${chainSummary()}`
  }

  const setEffort = (token, effort) => {
    const chain = currentChain()
    const parsed = parseIndex(token, chain)
    if (parsed.error) return { error: parsed.error }
    const next = chain.map(cloneEntry)
    next[parsed.index] = { ...next[parsed.index], reasoningEffort: normalizeEffort(effort) }
    commitChain(next)
    const value = next[parsed.index].reasoningEffort
    return `已设置 #${parsed.index + 1} 的思考强度：${value ? value : 'inherit（沿用会话）'}`
  }

  const setEnabled = (token, enabled) => {
    const chain = currentChain()
    const parsed = parseIndex(token, chain)
    if (parsed.error) return { error: parsed.error }
    const next = chain.map(cloneEntry)
    next[parsed.index] = { ...next[parsed.index], enabled }
    commitChain(next)
    return `已${enabled ? '启用' : '停用'} #${parsed.index + 1} ${candidateKey(next[parsed.index])}\n启用档：${chainSummary()}`
  }

  const addEntry = (spec, effort) => {
    const text = String(spec ?? '').trim()
    const slash = text.indexOf('/')
    if (slash <= 0 || slash === text.length - 1) {
      return { error: '用法：/rotation add <provider>/<model> [强度]，例如 /rotation add apixiao/gpt-6.1-sol high' }
    }
    const chain = currentChain()
    if (chain.length >= 32) return { error: '链最多 32 档，先删掉不用的再添加' }
    const provider = text.slice(0, slash).trim()
    const model = text.slice(slash + 1).trim()
    if (provider === cfg.virtualProviderId) return { error: `不能把虚拟 provider「${provider}」自己加进链里` }
    const entry = normalizeChainEntry({ provider, model, enabled: true, reasoningEffort: effort })
    if (!entry) return { error: 'provider / model 不能为空' }
    if (chain.some((item) => candidateKey(item) === candidateKey(entry))) {
      return { error: `${candidateKey(entry)} 已经在链里了` }
    }
    const next = [...chain.map(cloneEntry), entry]
    commitChain(next)
    return `已添加 #${next.length} ${candidateKey(entry)}${entry.reasoningEffort ? `（强度 ${entry.reasoningEffort}）` : ''}\n${chainSummary()}`
  }

  const removeEntry = (token) => {
    const chain = currentChain()
    const parsed = parseIndex(token, chain)
    if (parsed.error) return { error: parsed.error }
    if (chain.length <= 1) return { error: '至少保留一档，不能把链删空' }
    const next = chain.map(cloneEntry)
    const [removed] = next.splice(parsed.index, 1)
    commitChain(next)
    return `已删除 #${parsed.index + 1} ${candidateKey(removed)}\n${chainSummary()}`
  }

  /* ---------------- 预设 ---------------- */

  const presetUse = (id) => {
    const presetId = asString(id)
    if (!presetId || EFFORT_INHERIT.has(presetId.toLowerCase()) || ['chain', 'off', 'none'].includes(presetId.toLowerCase())) {
      // 退出预设，回到「链」：优先用手动排序保存下来的链，没有再退回配置里的 chain
      runtime.activePreset = ''
      saveState()
      return `已退出预设，回到手动链：${chainSummary()}`
    }
    const preset = findPreset(presetId)
    if (!preset) return { error: `没有这个预设：${presetId}\n${presetsText()}` }
    // 注意：保留 chainOverride，退出预设时还能回到手动排序过的那条链
    runtime.activePreset = presetId
    saveState()
    return `已切换到预设「${presetId}」：${chainSummary()}`
  }

  const presetSave = (id, label) => {
    const presetId = asString(id)
    if (!presetId) return { error: '用法：/rotation preset save <id> [显示名]' }
    const chain = currentChain().map(cloneEntry)
    if (!chain.length) return { error: '当前链是空的，没什么可保存的' }
    const existing = runtime.customPresets.findIndex((item) => item.id === presetId)
    const preset = { id: presetId, label: asString(label), chain }
    if (existing >= 0) runtime.customPresets[existing] = preset
    else runtime.customPresets.push(preset)
    runtime.activePreset = presetId
    saveState()
    return `已把当前链存成预设「${presetId}」并切换过去：${chainSummary()}`
  }

  const presetDelete = (id) => {
    const presetId = asString(id)
    const index = runtime.customPresets.findIndex((item) => item.id === presetId)
    if (index < 0) return { error: `只能删除自己 save 过的预设；「${presetId}」不在自定义列表里` }
    runtime.customPresets.splice(index, 1)
    if (runtime.activePreset === presetId) runtime.activePreset = ''
    saveState()
    return `已删除预设「${presetId}」`
  }

  /* ---------------------------------------------------------------- */
  /* /rotation 命令                                                    */
  /* ---------------------------------------------------------------- */

  const USAGE = [
    '分组（= 来源）：agy 账号池 antigravity、Codex 订阅 openai-codex、DeepSeek API xiao-deepseek、',
    'GPT API apixiao、内置 DeepSeek deepseek-official。每个分组里的模型独立筛选。',
    '',
    '状态与自查：',
    '  /rotation                 查看链 / 排序模式 / 冷却 / 健康度（每档带分组前缀）',
    '  /rotation groups          只看分组：每个来源有哪些模型、链里占几档',
    '  /rotation models          列出所有 provider、模型和可用思考强度（按分组）',
    '  /rotation probe [提示词]  逐个直连探测（可加序号：/rotation probe 2）',
    '  /rotation probe group antigravity   只探某个分组',
    '  /rotation test [提示词]   端到端走一遍虚拟 provider（验证切换逻辑）',
    '',
    '手动排序：',
    '  /rotation order 3,1,2,4   按序号重排（写全或只写要前置的那几档）',
    '  /rotation move 3 1        把 #3 移到 #1',
    '  /rotation up 2  /  down 2 上移 / 下移一档',
    '  /rotation sort manual     切回手动排序',
    '',
    '自动排序：',
    '  /rotation sort auto       按健康度 + 延迟自动排序',
    '  /rotation auto            /rotation sort auto 的简写',
    '  /rotation sort auto speed         偏好速度',
    '  /rotation sort auto reliability   偏好稳定',
    '  /rotation sort auto balanced      均衡（默认）',
    '',
    '模型与思考强度：',
    '  /rotation add antigravity/gemini-3.8-flash high   末尾追加一档（带强度）',
    '  /rotation set 2 openai-codex/gpt-6.1-sol high     换某档模型 + 强度',
    '  /rotation effort 1 low|xhigh|inherit|none',
    '  /rotation enable 3  /  disable 3                  启用 / 停用某档',
    '  /rotation remove 4                                删除某档（至少留一档）',
    '',
    '预设：',
    '  /rotation preset                  列出预设（含 example 示例链）',
    '  /rotation preset use coding       切到预设（use chain 回到 chain）',
    '  /rotation preset save mine [名字] 把当前链存成新预设',
    '  /rotation preset delete mine',
    '',
    '维护：',
    '  /rotation reset       清冷却 + 健康度统计（不动链和排序设置）',
    '  /rotation reset-all   恢复配置默认（清掉命令改过的链 / 排序 / 自定义预设）',
    '  /rotation help',
  ].join('\n')

  const handleCommand = async (argv, invocation) => {
    const sub = (argv[0] ?? 'status').toLowerCase()
    const a1 = argv[1]
    const a2 = argv[2]
    const rest = argv.slice(1).join(' ')

    // 状态 / 自查
    if (['status', 'ls', 'list', 'chain'].includes(sub)) return { kind: 'success', text: statusText() }
    if (['help', '-h', '--help'].includes(sub)) return { kind: 'success', text: USAGE }
    if (sub === 'models') return { kind: 'success', text: await modelsText(invocation?.signal) }
    if (['groups', 'group', 'sources', 'source'].includes(sub)) {
      return { kind: 'success', text: await groupsText(invocation?.signal) }
    }
    if (sub === 'reset' || sub === 'clear') return { kind: 'success', text: reset() }
    if (sub === 'reset-all' || sub === 'resetall' || sub === 'restore') return { kind: 'success', text: resetAll() }
    if (sub === 'probe') {
      const chain = currentChain()
      const first = (argv[1] ?? '').toLowerCase()
      if (first === 'group' || first === '分组') {
        const groupId = asString(argv[2])
        if (!groupId) {
          return { kind: 'error', text: '用法：/rotation probe group <分组 id>，例如 /rotation probe group antigravity' }
        }
        const prompt = promptOf(argv.slice(3).join(' '))
        return { kind: 'success', text: await probeAll(prompt, invocation?.signal, undefined, groupId) }
      }
      const maybeIndex = argv[1] && parseIndex(argv[1], chain)
      const only = maybeIndex && !maybeIndex.error ? maybeIndex.index : undefined
      const prompt = only === undefined ? promptOf(rest) : promptOf(argv.slice(2).join(' '))
      return { kind: 'success', text: await probeAll(prompt, invocation?.signal, only) }
    }
    if (['test', 'e2e', 'auto-test'].includes(sub)) {
      return { kind: 'success', text: await probeAuto(promptOf(rest), invocation?.signal) }
    }

    // 排序
    if (sub === 'sort' || sub === 'order-by') {
      if (a1 && a1.toLowerCase() === 'order') {
        const result = reorderByIndices(argv.slice(2).join(' '))
        return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
      }
      const result = applySort(a1, a2)
      if (typeof result === 'string') return { kind: 'success', text: result }
      return { kind: 'error', text: result.error }
    }
    if (sub === 'auto') {
      const result = applySort('auto', a1)
      if (typeof result === 'string') return { kind: 'success', text: result }
      return { kind: 'error', text: result.error }
    }
    if (sub === 'manual') {
      const result = applySort('manual')
      if (typeof result === 'string') return { kind: 'success', text: result }
      return { kind: 'error', text: result.error }
    }
    if (sub === 'order') {
      const result = reorderByIndices(rest)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }
    if (sub === 'move') {
      const result = moveEntry(a1, a2)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }
    if (sub === 'up' || sub === 'down') {
      const result = shiftEntry(a1, sub === 'up' ? -1 : 1)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }

    // 模型 / 强度 / 启停
    if (sub === 'set') {
      const result = setEntry(a1, a2, argv[3])
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }
    if (sub === 'effort') {
      const result = setEffort(a1, a2)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }
    if (sub === 'enable' || sub === 'disable' || sub === 'on' || sub === 'off') {
      const enabled = sub === 'enable' || sub === 'on'
      const result = setEnabled(a1, enabled)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }

    if (sub === 'add' || sub === 'append') {
      const result = addEntry(a1, a2)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete' || sub === 'del') {
      const result = removeEntry(a1)
      return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
    }

    // 预设
    if (sub === 'preset' || sub === 'presets') {
      const action = (a1 ?? '').toLowerCase()
      if (!action || action === 'list') return { kind: 'success', text: presetsText() }
      if (action === 'use' || action === 'switch') {
        const result = presetUse(a2)
        return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
      }
      if (action === 'save') {
        const result = presetSave(a2, argv.slice(3).join(' '))
        return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
      }
      if (action === 'delete' || action === 'rm') {
        const result = presetDelete(a2)
        return typeof result === 'string' ? { kind: 'success', text: result } : { kind: 'error', text: result.error }
      }
      return { kind: 'error', text: `未知预设操作：${a1}\n\n${USAGE}` }
    }

    return { kind: 'error', text: `未知子命令：${sub}\n\n${USAGE}` }
  }

  try {
    ctx.commands.register({
      definitionId: 'model-rotation',
      name: 'rotation',
      description: '模型轮询链：手动/自动排序、预设切换、模型与思考强度、状态与探测',
      handler: async (invocation) => {
        const argv = String(invocation?.rawInput ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
        // 不同入口传进来的 rawInput 可能带也可能不带命令名，这里统一剥掉
        while (argv.length && ['/rotation', 'rotation', '/rot'].includes(argv[0].toLowerCase())) argv.shift()
        try {
          return await handleCommand(argv, invocation)
        } catch (error) {
          return { kind: 'error', text: `执行失败：${errMessage(error)}` }
        }
      },
    })
  } catch (error) {
    warn(`注册 /rotation 命令失败：${errMessage(error)}`)
  }

  /* ---------------------------------------------------------------- */
  /* rotation_probe 工具（给 agent 自查用）                             */
  /* ---------------------------------------------------------------- */

  try {
    ctx.inject(['tools'], (sub) => {
      const tools = sub.get('tools')
      if (!tools || typeof tools.register !== 'function') return
      const dispose = tools.register(
        defineTool({
          name: 'rotation_probe',
          description:
            '模型轮询链自查工具。mode=status 看链/排序模式/健康度；mode=probe 逐个直连探测每个候选模型；' +
            'mode=test 端到端走一遍轮询链（验证自动切换）；mode=models 列出可用 provider/模型/思考强度。',
          parameters: {
            mode: {
              type: 'string',
              description: 'status | probe | test | models，默认 status',
            },
            prompt: {
              type: 'string',
              description: '探测用的提示词（可选）',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
          },
          timeoutMs: 600000,
          async execute(args, exec) {
            const mode = String(args?.mode ?? 'status').toLowerCase()
            const prompt = promptOf(args?.prompt)
            if (mode === 'probe') return await probeAll(prompt, exec?.signal)
            if (mode === 'test' || mode === 'auto' || mode === 'e2e') return await probeAuto(prompt, exec?.signal)
            if (mode === 'models') return await modelsText(exec?.signal)
            return statusText()
          },
        }),
      )
      if (typeof dispose === 'function') ctx.effect(() => () => dispose())
    })
  } catch (error) {
    warn(`注册 rotation_probe 工具失败：${errMessage(error)}`)
  }

  /* ---------------------------------------------------------------- */
  /* Web 设置页：给 client.js 提供状态 / 命令 / 模型目录                 */
  /* ---------------------------------------------------------------- */

  const snapshotPayload = () => {
    const now = Date.now()
    const chain = currentChain()
    const rows = chain.map((entry, index) => {
      const cool = cooldownOf(entry)
      const cooling = !!cool && cool.until > now
      const h = healthOf(entry)
      return {
        index,
        provider: entry.provider,
        model: entry.model,
        group: groupIdOf(entry),
        groupLabel: groupLabelOf(entry),
        groupShort: groupShortLabelOf(entry),
        key: candidateKey(entry),
        label: entry.label || '',
        display: candidateLabel(entry),
        enabled: entry.enabled !== false,
        reasoningEffort: entry.reasoningEffort || '',
        cooling,
        cooldownRemainingMs: cooling ? cool.until - now : 0,
        cooldownCode: cooling ? cool.code || '' : '',
        health: {
          attempts: h.attempts,
          successes: h.successes,
          failures: h.failures,
          successRate: h.attempts ? Math.round((h.successes / h.attempts) * 100) : null,
          avgLatencyMs: Math.round(h.latEwma),
          lastOkAt: h.lastOkAt || 0,
          lastErrorAt: h.lastErrorAt || 0,
        },
      }
    })
    return {
      ok: true,
      virtual: { provider: cfg.virtualProviderId, model: cfg.virtualModelId },
      displayName: cfg.displayName,
      sortMode: runtime.sortMode,
      autoPrefer: runtime.autoPrefer,
      activePreset: runtime.activePreset || '',
      chain: rows,
      groups: [...new Set(rows.map((row) => row.group))].map((id) => {
        const members = rows.filter((row) => row.group === id)
        return {
          id,
          label: groupLabelOf(members[0]),
          short: groupShortLabelOf(members[0]),
          count: members.length,
          keys: members.map((row) => row.key),
        }
      }),
      order: orderedCandidates().map((entry) => candidateKey(entry)),
      presets: allPresets().map((preset) => ({
        id: preset.id,
        label: preset.label || '',
        builtin: cfg.presets.some((item) => item.id === preset.id),
        active: runtime.activePreset === preset.id,
        summary: preset.chain
          .filter((item) => item.enabled !== false)
          .map((item) =>
            candidateKey(item) + (item.reasoningEffort && item.reasoningEffort !== 'none' ? `[${item.reasoningEffort}]` : ''),
          )
          .join(' → '),
      })),
      stats: {
        calls: stats.calls,
        switches: stats.switches,
        lastSwitch: stats.lastSwitch,
        lastFailure: stats.lastFailure,
        lastSuccess: stats.lastSuccess,
      },
      cooldownConfig: { quotaMs: cfg.quotaCooldownMs, errorMs: cfg.errorCooldownMs },
      lastAnswer,
      answersBySession: Object.fromEntries(answersBySession),
      lastRun,
      clientReports: clientReports.slice(-12),
      statusText: statusText(),
    }
  }

  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch {
      /* 响应已关闭，忽略 */
    }
  }

  const readJsonBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on?.('data', (chunk) => {
        size += chunk.length
        if (size <= 1_000_000) chunks.push(chunk)
      })
      req.on?.('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          resolve(value && typeof value === 'object' ? value : {})
        } catch {
          resolve({})
        }
      })
      req.on?.('error', () => resolve({}))
    })

  /**
   * 模型目录（按分组）：一个 provider 一组，组内每个模型带可用思考强度。
   * 结果缓存 60 秒——设置页每次打开/刷新都会拉一次，但不会每次都去问 provider。
   */
  let catalogCache = { at: 0, data: null }
  const CATALOG_TTL_MS = 60 * 1000
  const buildCatalog = async (signal) => {
    if (catalogCache.data && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data
    const list = (await ctx.llm.listProviders()) ?? []
    const groups = new Map()
    for (const provider of Array.isArray(list) ? list : []) {
      if (!provider?.id) continue
      const id = provider.id
      if (id === cfg.virtualProviderId) continue
      const known = KNOWN_GROUPS[id]
      if (!groups.has(id)) {
        const label = known ? known.label : id
        groups.set(id, {
          id,
          label,
          short: label.split('（')[0].trim(),
          order: known?.order ?? 999,
          providers: [],
        })
      }
      const bucket = groups.get(id)
      const entry = { id, name: provider.name ?? id, models: [] }
      try {
        const models = (await ctx.llm.listModels(id)) ?? []
        for (const model of (Array.isArray(models) ? models : []).slice(0, 40)) {
          const info = await resolveInfo(id, model.id, signal)
          entry.models.push({
            id: model.id,
            name: model.name ?? model.id,
            efforts: info.efforts,
            defaultEffort: info.defaultEffort,
            contextWindow: info.contextWindow,
          })
        }
      } catch (error) {
        entry.error = errMessage(error)
      }
      bucket.providers.push(entry)
    }
    const data = {
      ok: true,
      groups: [...groups.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      cachedAt: Date.now(),
    }
    data.providers = data.groups.flatMap((group) => group.providers)
    catalogCache = { at: Date.now(), data }
    return data
  }

  try {
    ctx.inject(['webServer'], (sub) => {
      const webServer = sub.get('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        warn('没有 webServer 服务，设置页拿不到数据（命令 /rotation 仍可用）')
        return
      }
      const disposers = []
      const reg = (route) => {
        try {
          const dispose = webServer.register(route)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          warn(`注册路由 ${route.path} 失败：${errMessage(error)}`)
        }
      }

      reg({
        kind: 'exact',
        path: '/plugins/model-rotation/state',
        handler: (_req, res) => sendJson(res, 200, snapshotPayload()),
      })

      // 浏览器侧诊断通道：client.js 把「座位注册成功/失败、渲染崩溃、徽章状态」报上来，
      // 因为客户端 console 不进 host 日志，出问题时只能靠这条通道取证。
      reg({
        kind: 'exact',
        path: '/plugins/model-rotation/client-report',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const entry = recordClientReport(body)
          if (cfg.logSwitches) {
            try {
              ctx.logger?.info?.(TAG + `client-report ${entry.event}：${JSON.stringify(entry.detail ?? null)}`)
            } catch {}
          }
          sendJson(res, 200, { ok: true, received: entry })
        },
      })

      reg({
        kind: 'exact',
        path: '/plugins/model-rotation/command',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const argv = Array.isArray(body.argv)
            ? body.argv.map((item) => String(item))
            : String(body.command ?? '')
                .split(/\s+/)
                .filter(Boolean)
          try {
            const result = await handleCommand(argv, null)
            sendJson(res, 200, {
              ...snapshotPayload(),
              ok: result?.kind !== 'error',
              text: String(result?.text ?? ''),
            })
          } catch (error) {
            sendJson(res, 200, { ...snapshotPayload(), ok: false, text: `执行失败：${errMessage(error)}` })
          }
        },
      })

      reg({
        kind: 'exact',
        path: '/plugins/model-rotation/catalog',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const provider = url.searchParams.get('provider')
          const model = url.searchParams.get('model')
          try {
            if (provider && model) {
              const info = await resolveInfo(provider, model)
              sendJson(res, 200, {
                ok: true,
                provider,
                model,
                efforts: info.efforts.map((id) => ({ id, name: id })),
                defaultEffort: info.defaultEffort,
                contextWindow: info.contextWindow,
              })
              return
            }
            if (url.searchParams.get('refresh')) catalogCache = { at: 0, data: null }
            sendJson(res, 200, await buildCatalog())
          } catch (error) {
            sendJson(res, 200, { ok: false, text: errMessage(error), groups: [], providers: [] })
          }
        },
      })

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 忽略 */
          }
        }
      })
    })
  } catch (error) {
    warn(`注册设置页接口失败：${errMessage(error)}`)
  }
}
