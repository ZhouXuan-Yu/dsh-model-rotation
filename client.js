/**
 * dsh-model-rotation —— client 上半（Web 设置页）
 *
 * 在「设置」里注册一整页「模型轮询」，直接可视化管理轮询链：
 *   - 手动排序（↑ / ↓ / 拖位）+ 自动排序（偏好：速度 / 稳定 / 均衡）
 *   - 每档的 provider / model / 思考强度（inherit / low / medium / high / xhigh / none）
 *   - 预设的保存、应用、删除
 *   - 实时看健康度、冷却、调用与切换统计，一键探测 / 重置
 *
 * 数据通道：host 半注册的 3 条 HTTP 路由
 *   GET  /plugins/model-rotation/state
 *   POST /plugins/model-rotation/command   { argv: string[] }
 *   GET  /plugins/model-rotation/catalog   （?provider=&model= 时可查该模型的思考强度）
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-rotation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const BASE = (typeof window !== 'undefined' && window.location && window.location.origin) || ''
    const STATE_URL = '/plugins/model-rotation/state'
    const COMMAND_URL = '/plugins/model-rotation/command'
    const CATALOG_URL = '/plugins/model-rotation/catalog'
    const POLL_MS = 5000

    /* ---------------- 颜色 / 样式（跟随主题） ---------------- */

    const C = {
      border: 'color-mix(in oklab, currentColor 16%, transparent)',
      borderStrong: 'color-mix(in oklab, currentColor 30%, transparent)',
      soft: 'color-mix(in oklab, currentColor 7%, transparent)',
      soft2: 'color-mix(in oklab, currentColor 12%, transparent)',
      muted: 'color-mix(in oklab, currentColor 62%, transparent)',
      faint: 'color-mix(in oklab, currentColor 45%, transparent)',
      accent: 'color-mix(in oklab, #4f7cff 82%, currentColor)',
      ok: 'color-mix(in oklab, #22a06b 88%, currentColor)',
      warn: 'color-mix(in oklab, #d98324 90%, currentColor)',
      bad: 'color-mix(in oklab, #d94a4a 90%, currentColor)',
    }

    const S = {
      page: { padding: '20px 22px 40px', display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px' },
      h1: { fontSize: '17px', fontWeight: 600, margin: 0 },
      sub: { color: C.muted, fontSize: '12px', lineHeight: 1.55 },
      card: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' },
      cardTitle: { fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      chainRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        border: `1px solid ${C.border}`,
        borderRadius: '8px',
        background: C.soft,
        flexWrap: 'wrap',
      },
      idx: { width: '24px', textAlign: 'center', color: C.faint, fontVariantNumeric: 'tabular-nums', fontSize: '12px' },
      btn: {
        border: `1px solid ${C.borderStrong}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '3px 9px',
        fontSize: '12px',
        cursor: 'pointer',
        lineHeight: 1.5,
      },
      btnPrimary: {
        border: `1px solid ${C.accent}`,
        background: C.accent,
        color: '#fff',
        borderRadius: '6px',
        padding: '3px 9px',
        fontSize: '12px',
        cursor: 'pointer',
        lineHeight: 1.5,
      },
      btnTiny: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.muted,
        borderRadius: '5px',
        padding: '1px 6px',
        fontSize: '11px',
        cursor: 'pointer',
        lineHeight: 1.6,
      },
      seg: { display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: '7px', overflow: 'hidden' },
      segBtn: { border: 0, background: 'transparent', color: C.muted, padding: '4px 12px', fontSize: '12px', cursor: 'pointer' },
      segBtnOn: { border: 0, background: C.soft2, color: 'inherit', padding: '4px 12px', fontSize: '12px', cursor: 'pointer', fontWeight: 600 },
      select: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '3px 6px',
        fontSize: '12px',
        maxWidth: '260px',
      },
      input: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '3px 8px',
        fontSize: '12px',
        width: '130px',
      },
      badge: { borderRadius: '999px', padding: '1px 8px', fontSize: '11px', border: `1px solid ${C.border}`, whiteSpace: 'nowrap' },
      name: { fontWeight: 600, fontSize: '12px' },
      muted: { color: C.muted, fontSize: '12px' },
      log: {
        whiteSpace: 'pre-wrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '11.5px',
        lineHeight: 1.6,
        background: C.soft,
        border: `1px solid ${C.border}`,
        borderRadius: '8px',
        padding: '10px 12px',
        maxHeight: '260px',
        overflow: 'auto',
      },
      dim: { color: C.faint, fontSize: '11.5px' },
    }

    /* ---------------- 工具 ---------------- */

    async function getJson(path) {
      const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return await res.json()
    }

    async function postJson(path, body) {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return await res.json()
    }

    /**
     * 浏览器侧诊断上报：客户端 console 不进 host 日志，座位注册/渲染出问题时
     * 只能靠这条通道把现场送到 /plugins/model-rotation/state 的 clientReports 里。
     */
    const REPORT_URL = '/plugins/model-rotation/client-report'
    const REPORTED = new Set()
    function report(event, detail, once) {
      try {
        const key = String(event)
        if (once === true) {
          if (REPORTED.has(key)) return
          REPORTED.add(key)
        }
        const payload = {
          event: key,
          detail: detail === undefined ? null : detail,
          page: typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '',
        }
        void fetch(BASE + REPORT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 诊断失败绝不影响主流程 */
      }
    }

    function errorDetail(error, extra) {
      const base = {
        name: error && error.name ? String(error.name) : 'Error',
        message: error && error.message ? String(error.message) : String(error),
        stack: error && error.stack ? String(error.stack).split('\n').slice(0, 6).join('\n') : '',
      }
      if (extra && typeof extra === 'object') {
        for (const key of Object.keys(extra)) base[key] = extra[key]
      }
      return base
    }

    function fmtRemaining(ms) {
      if (!ms || ms <= 0) return ''
      const total = Math.round(ms / 1000)
      const m = Math.floor(total / 60)
      const s = total % 60
      if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`
      return m > 0 ? `${m}m${s}s` : `${s}s`
    }

    function effortText(value) {
      if (!value) return 'inherit'
      if (value === 'none') return '不带强度'
      return value
    }

    function keyOf(row) {
      return `${row.provider}/${row.model}`
    }

    /* ---------------- 设置页 ---------------- */

    function ModelRotationSection() {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState('')
      const [catalog, setCatalog] = useState(null)
      const [efforts, setEfforts] = useState({}) // key -> {ids:[], names:{}}
      const [busy, setBusy] = useState('')
      const [log, setLog] = useState('')
      const [picker, setPicker] = useState({ provider: '', model: '', effort: '', filter: '' })
      const [presetName, setPresetName] = useState('')
      const [confirmReset, setConfirmReset] = useState(false)
      const mounted = useRef(true)
      const effortsRef = useRef({})
      effortsRef.current = efforts

      const applySnapshot = useCallback((data) => {
        if (!mounted.current || !data) return
        setSnap(data)
      }, [])

      const refresh = useCallback(async () => {
        try {
          const data = await getJson(STATE_URL)
          applySnapshot(data)
          setError('')
        } catch (e) {
          if (mounted.current) setError(`读取插件状态失败：${e.message || e}`)
        }
      }, [applySnapshot])

      const run = useCallback(
        async (argv, label) => {
          setBusy(label || argv[0] || 'run')
          try {
            const data = await postJson(COMMAND_URL, { argv })
            applySnapshot(data)
            if (mounted.current) setLog(String(data.text || '(无输出)'))
            if (!data.ok && mounted.current) setError(String(data.text || '命令执行失败'))
            else if (mounted.current) setError('')
            return data
          } catch (e) {
            if (mounted.current) setError(`命令失败：${e.message || e}`)
            return null
          } finally {
            if (mounted.current) setBusy('')
          }
        },
        [applySnapshot],
      )

      // 首次加载 + 轮询状态
      useEffect(() => {
        mounted.current = true
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, POLL_MS)
        return () => {
          mounted.current = false
          clearInterval(timer)
        }
      }, [refresh])

      // 拉一次模型目录（按分组）
      useEffect(() => {
        let cancelled = false
        getJson(CATALOG_URL)
          .then((data) => {
            if (cancelled) return
            const groups = data && Array.isArray(data.groups) ? data.groups : []
            setCatalog({ groups, providers: data && Array.isArray(data.providers) ? data.providers : [] })
            // 目录里已经带了每个模型的思考强度，直接铺进 efforts 表，链上的下拉就能用
            const built = {}
            for (const group of groups) {
              for (const provider of group.providers || []) {
                for (const model of provider.models || []) {
                  const ids = Array.isArray(model.efforts) ? model.efforts : []
                  const names = {}
                  for (const id of ids) names[id] = id
                  built[`${provider.id}/${model.id}`] = { ids, names }
                }
              }
            }
            setEfforts((prev) => ({ ...built, ...prev }))
          })
          .catch(() => {
            if (!cancelled) setCatalog({ groups: [], providers: [] })
          })
        return () => {
          cancelled = true
        }
      }, [])

      const loadEfforts = useCallback(async (provider, model) => {
        const key = `${provider}/${model}`
        if (!provider || !model) return
        if (effortsRef.current[key]) return
        try {
          const data = await getJson(
            `${CATALOG_URL}?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
          )
          if (!mounted.current) return
          const ids = (data && data.efforts ? data.efforts : []).map((item) => item.id)
          const names = {}
          for (const item of data && data.efforts ? data.efforts : []) names[item.id] = item.name || item.id
          setEfforts((prev) => (prev[key] ? prev : { ...prev, [key]: { ids, names } }))
        } catch {
          if (mounted.current) setEfforts((prev) => (prev[key] ? prev : { ...prev, [key]: { ids: [], names: {} } }))
        }
      }, [])

      // 给链里每个模型补拉强度列表
      useEffect(() => {
        if (!snap || !Array.isArray(snap.chain)) return
        for (const row of snap.chain) void loadEfforts(row.provider, row.model)
      }, [snap, loadEfforts])

      const modelOptions = useMemo(() => {
        const list = []
        const groups = (catalog && catalog.groups) || []
        for (const group of groups) {
          for (const provider of group.providers || []) {
            for (const model of provider.models || []) {
              list.push({
                group: group.id,
                groupLabel: group.label || group.id,
                provider: provider.id,
                providerName: provider.name,
                model: model.id,
                modelName: model.name,
              })
            }
          }
        }
        return list
      }, [catalog])

      const pickerGroup = useMemo(() => {
        const groups = (catalog && catalog.groups) || []
        return groups.find((group) => group.id === picker.provider) || null
      }, [catalog, picker.provider])

      const pickerModels = useMemo(() => {
        if (!pickerGroup) return []
        const keyword = (picker.filter || '').trim().toLowerCase()
        const list = []
        for (const provider of pickerGroup.providers || []) {
          for (const model of provider.models || []) {
            const haystack = `${provider.id}/${model.id} ${model.name || ''}`.toLowerCase()
            if (keyword && !haystack.includes(keyword)) continue
            list.push({ ...model, provider: provider.id })
          }
        }
        return list
      }, [pickerGroup, picker.filter])

      // 添加候选：默认选第一个分组的第一个模型
      useEffect(() => {
        if (!picker.provider && catalog && catalog.groups && catalog.groups.length) {
          const first = catalog.groups[0]
          const firstProvider = (first.providers || [])[0]
          setPicker({
            provider: first.id,
            model: firstProvider && firstProvider.models && firstProvider.models[0] ? firstProvider.models[0].id : '',
            effort: '',
            filter: '',
          })
        }
      }, [catalog, picker.provider])

      useEffect(() => {
        if (picker.provider && picker.model) void loadEfforts(picker.provider, picker.model)
      }, [picker.provider, picker.model, loadEfforts])

      const chain = snap && Array.isArray(snap.chain) ? snap.chain : []
      const activeCount = chain.filter((row) => row.enabled).length
      const isAuto = snap && snap.sortMode === 'auto'
      const pickerEfforts = picker.provider && picker.model ? (efforts[`${picker.provider}/${picker.model}`] || { ids: [] }) : { ids: [] }

      const rowMove = (row, delta) => {
        const target = row.index + delta
        if (target < 0 || target >= chain.length) return
        void run(['move', String(row.index + 1), String(target + 1)], 'move')
      }

      return h(
        'div',
        { style: S.page },
        // 头部
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, h('h1', { style: S.h1 }, '模型轮询'),
            h('span', { style: { ...S.badge, borderColor: C.border } }, snap ? `provider: ${snap.virtual.provider}` : '加载中…'),
            h('span', { style: { ...S.badge } }, snap ? `模型: ${snap.virtual.model}` : '—'),
            snap
              ? h('span', { style: { ...S.badge, color: C.muted } },
                  `调用 ${snap.stats.calls} 次 · 切换 ${snap.stats.switches} 次 · 启用 ${activeCount}/${chain.length} 档`)
              : null,
            snap && chain.some((row) => row.cooling)
              ? h('span', {
                  style: { ...S.badge, color: C.warn, borderColor: C.warn },
                  title: '这些档刚失败过，正在冷却，暂时会被跳过（冷却结束自动恢复可用）',
                }, `冷却中 ${chain.filter((row) => row.cooling).length} 档`)
              : null,
            snap && snap.lastAnswer && snap.lastAnswer.key
              ? h('span', {
                  style: { ...S.badge, color: C.accent, borderColor: C.accent },
                  title: `最近一次回答：${snap.lastAnswer.key}\n分组：${snap.lastAnswer.groupLabel || snap.lastAnswer.group || ''}\n耗时：${Math.round((snap.lastAnswer.latencyMs || 0))}ms${snap.lastAnswer.switched ? `（前面 ${snap.lastAnswer.switched} 档失败后切换）` : ''}`,
                }, `上次回答：${snap.lastAnswer.label || snap.lastAnswer.model}`)
              : null,
          ),
          h('div', { style: S.sub },
            '按顺序尝试，前档额度用尽 / 报错会自动切到下一档；已输出内容后不再切换，避免半截回复。',
            h('br'),
            '在模型选择器里选「Model Rotation / Auto」即走这条链；也可以直接用会话命令 /rotation。',
          ),
        ),
        error ? h('div', { style: { ...S.card, borderColor: C.bad, color: C.bad } }, error) : null,
        // 三步上手（新手引导）
        h(
          'div',
          { style: { ...S.card, borderColor: C.accent } },
          h('div', { style: S.cardTitle }, '三步上手'),
          h(
            'div',
            { style: S.sub },
            h('span', {}),
            '① 在输入框右下角的模型选择器里选「⚡ 自动轮询」——之后每次回答都走下面这条链；',
            h('br'),
            '② 「轮询链」就是尝试顺序：靠前的先用，额度用尽 / 报错自动换下一档，还会自动把你这一步重新发一遍；',
            h('br'),
            '③ 不想逐项配置，直接点下面的「一键：推荐链」，再按需微调即可。',
          ),
          h(
            'div',
            { style: S.row },
            h('button', {
              style: S.btnPrimary,
              title: '载入内置 example 预设：Gemini 3.8 Flash → Codex 6.1 Sol → xiao-DeepSeek → 内置 DeepSeek',
              disabled: busy !== '',
              onClick: () => void run(['preset', 'use', 'example'], 'onboard-preset'),
            }, '一键：推荐链'),
            h('button', {
              style: S.btn,
              title: '按「健康度 + 延迟」自动排序（均衡），失败多的档自动往后排',
              disabled: busy !== '',
              onClick: () => void run(['sort', 'auto', 'balanced'], 'onboard-auto'),
            }, '一键：自动排序'),
            h('button', {
              style: S.btn,
              title: '逐个直连探测每个档，检查账号/额度/地区是否可用（会消耗少量额度）',
              disabled: busy !== '',
              onClick: () => void run(['probe'], 'onboard-probe'),
            }, '一键：探测全部'),
            h('button', {
              style: S.btn,
              title: '查看全部命令与参数说明',
              disabled: busy !== '',
              onClick: () => void run(['help'], 'onboard-help'),
            }, '命令速查'),
          ),
          h('div', { style: S.dim },
            '这些按钮等价于在会话里敲 /rotation preset use example、/rotation sort auto balanced 等命令。'),
        ),
        // 排序方式
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '① 排序方式（手动 / 自动）'),
          h(
            'div',
            { style: S.row },
            h(
              'div',
              { style: S.seg },
              h(
                'button',
                {
                  style: isAuto ? S.segBtn : S.segBtnOn,
                  disabled: !snap || busy !== '' || !isAuto,
                  onClick: () => void run(['manual'], 'manual'),
                },
                '手动排序',
              ),
              h(
                'button',
                {
                  style: isAuto ? S.segBtnOn : S.segBtn,
                  disabled: !snap || busy !== '' || isAuto,
                  onClick: () => void run(['sort', 'auto'], 'auto'),
                },
                '自动排序',
              ),
            ),
            isAuto
              ? h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.muted }, '偏好'),
                  h(
                    'select',
                    {
                      style: S.select,
                      value: snap.autoPrefer || 'balanced',
                      disabled: busy !== '',
                      onChange: (e) => void run(['sort', 'auto', e.target.value], 'prefer'),
                    },
                    h('option', { value: 'balanced' }, '均衡（健康度 50% + 速度 50%）'),
                    h('option', { value: 'speed' }, '速度优先（10% 健康度 + 90% 速度）'),
                    h('option', { value: 'reliability' }, '稳定优先（85% 健康度 + 15% 速度）'),
                  ),
                )
              : h('span', { style: S.muted }, '手动模式严格按下面的顺序尝试，不会自己调整。'),
          ),
        ),
        // 轮询链
        h(
          'div',
          { style: S.card },
          h('div', { style: { ...S.cardTitle, justifyContent: 'space-between' } },
            h('div', { style: S.row },
              '② 轮询链（靠前的先用）',
              h('span', { style: { ...S.badge, color: C.muted } },
                snap && snap.activePreset ? `当前预设：${snap.activePreset}` : '当前：手动链'),
            ),
            h('div', { style: S.row },
              busy === 'probe' ? h('span', { style: S.muted }, '探测中…') : null,
              h('button', { style: S.btn, disabled: busy !== '', onClick: () => void run(['probe'], 'probe') }, '探测全部'),
              h('button', { style: S.btn, disabled: busy !== '', onClick: () => void run(['test'], 'test') }, '端到端测试'),
            ),
          ),
          chain.length === 0
            ? h('div', { style: S.muted }, '链是空的，请在下面添加候选。')
            : chain.map((row) => {
                const effortIds = (efforts[keyOf(row)] || { ids: [] }).ids
                const effortChoices = ['', ...effortIds.filter((id) => id !== ''), 'none']
                const unique = []
                for (const id of effortChoices) if (!unique.includes(id)) unique.push(id)
                return h(
                  'div',
                  { key: `${row.index}:${row.key}`, style: S.chainRow },
                  h('span', { style: S.idx }, `#${row.index + 1}`),
                  h(
                    'span',
                    { style: { ...S.badge, color: C.muted, borderColor: C.border, maxWidth: '132px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    row.groupShort || row.group || row.provider,
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
                    h('button', { style: S.btnTiny, disabled: row.index === 0 || busy !== '', onClick: () => rowMove(row, -1) }, '↑'),
                    h('button', { style: S.btnTiny, disabled: row.index >= chain.length - 1 || busy !== '', onClick: () => rowMove(row, 1) }, '↓'),
                  ),
                  h('label', { style: { ...S.row, gap: '4px', cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked: row.enabled !== false,
                      disabled: busy !== '',
                      onChange: (e) => void run([e.target.checked ? 'enable' : 'disable', String(row.index + 1)], 'toggle'),
                    }),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '220px' } },
                    row.label
                      ? h('span', { style: S.name }, row.label)
                      : h(
                          'select',
                          {
                            style: S.select,
                            value: `${row.provider}/${row.model}`,
                            disabled: busy !== '' || modelOptions.length === 0,
                            onChange: (e) => {
                              const value = String(e.target.value || '')
                              const slash = value.indexOf('/')
                              if (slash <= 0) return
                              void run(
                                ['set', String(row.index + 1), value, row.reasoningEffort || 'inherit'],
                                'set',
                              )
                            },
                          },
                          modelOptions.length === 0
                            ? h('option', { value: `${row.provider}/${row.model}` }, `${row.provider}/${row.model}`)
                            : null,
                          ((catalog && catalog.groups) || []).map((group) =>
                            h(
                              'optgroup',
                              { key: group.id, label: group.label || group.id },
                              (group.providers || []).flatMap((provider) =>
                                (provider.models || []).map((model) =>
                                  h(
                                    'option',
                                    { key: `${provider.id}/${model.id}`, value: `${provider.id}/${model.id}` },
                                    `${model.name || model.id}（${provider.id}/${model.id}）`,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                    h('span', { style: S.dim }, row.label ? `${row.provider}/${row.model}` : row.key),
                  ),
                  h(
                    'select',
                    {
                      style: S.select,
                      value: row.reasoningEffort || '',
                      disabled: busy !== '',
                      onChange: (e) => void run(['effort', String(row.index + 1), e.target.value || 'inherit'], 'effort'),
                    },
                    unique.map((id) =>
                      h('option', { key: id || 'inherit', value: id }, id === '' ? '强度 inherit' : id === 'none' ? '不带强度' : `强度 ${id}`),
                    ),
                  ),
                  row.cooling
                    ? h('span', { style: { ...S.badge, color: C.warn, borderColor: C.warn } },
                        `冷却 ${fmtRemaining(row.cooldownRemainingMs)}${row.cooldownCode ? `（${row.cooldownCode}）` : ''}`)
                    : row.health && row.health.attempts > 0
                      ? h('span', { style: { ...S.badge, color: row.health.successRate >= 60 ? C.ok : C.warn } },
                          `成功 ${row.health.successRate}% · ${row.health.avgLatencyMs}ms`)
                      : h('span', { style: { ...S.badge, color: C.faint } }, '未测'),
                  h('span', { style: { flex: 1 } }),
                  h('button', { style: S.btnTiny, disabled: busy !== '', onClick: () => void run(['probe', String(row.index + 1)], 'probe1') }, '探测'),
                  h('button', { style: S.btnTiny, disabled: busy !== '', onClick: () => void run(['up', String(row.index + 1)], 'up') }, '上移'),
                  h('button', { style: S.btnTiny, disabled: busy !== '', onClick: () => void run(['down', String(row.index + 1)], 'down') }, '下移'),
                  h('button', {
                    style: { ...S.btnTiny, color: C.bad },
                    disabled: busy !== '' || chain.length <= 1,
                    onClick: () => void run(['remove', String(row.index + 1)], 'remove'),
                  }, '删除'),
                )
              }),
          // 添加候选（先选分组，再在组内筛选模型）
          h(
            'div',
            { style: { ...S.row, borderTop: `1px dashed ${C.border}`, paddingTop: '10px', flexWrap: 'wrap' } },
            h('span', { style: S.muted }, '③ 添加候选（先选分组，再在组内筛选）'),
            h(
              'select',
              {
                style: { ...S.select, maxWidth: '260px' },
                value: picker.provider,
                disabled: busy !== '',
                onChange: (e) => {
                  const groupId = String(e.target.value || '')
                  const group = ((catalog && catalog.groups) || []).find((item) => item.id === groupId)
                  const firstProvider = group && group.providers ? group.providers[0] : null
                  setPicker({
                    provider: groupId,
                    model: firstProvider && firstProvider.models && firstProvider.models[0] ? firstProvider.models[0].id : '',
                    effort: '',
                    filter: '',
                  })
                },
              },
              ((catalog && catalog.groups) || []).map((group) =>
                h('option', { key: group.id, value: group.id }, `${group.label || group.id}（${group.id}）`),
              ),
            ),
            h('input', {
              style: { ...S.input, maxWidth: '150px' },
              placeholder: '筛选模型…',
              value: picker.filter,
              disabled: busy !== '',
              onChange: (e) => setPicker((prev) => ({ ...prev, filter: e.target.value })),
            }),
            h(
              'select',
              {
                style: { ...S.select, maxWidth: '280px' },
                value: picker.model,
                disabled: busy !== '',
                onChange: (e) => setPicker((prev) => ({ ...prev, model: String(e.target.value || ''), effort: '' })),
              },
              pickerModels.length === 0
                ? h('option', { value: '' }, picker.filter ? '（该分组里没有匹配的模型）' : '（该分组没有模型）')
                : pickerModels.map((model) =>
                    h(
                      'option',
                      { key: `${model.provider}/${model.id}`, value: model.id },
                      `${model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id}`,
                    ),
                  ),
            ),
            h(
              'select',
              {
                style: S.select,
                value: picker.effort,
                disabled: busy !== '',
                onChange: (e) => setPicker((prev) => ({ ...prev, effort: String(e.target.value || '') })),
              },
              h('option', { value: '' }, '强度 inherit'),
              (pickerEfforts.ids || []).map((id) => h('option', { key: id, value: id }, `强度 ${id}`)),
              h('option', { value: 'none' }, '不带强度'),
            ),
            h('button', {
              style: S.btnPrimary,
              disabled: busy !== '' || !picker.provider || !picker.model,
              onClick: () =>
                void run(
                  ['add', `${picker.provider}/${picker.model}`, picker.effort || 'inherit'],
                  'add',
                ),
            }, '添加'),
            pickerGroup && pickerGroup.label
              ? h('span', { style: S.dim }, `分组 ${pickerGroup.label} · ${pickerModels.length} 个模型`)
              : null,
          ),
        ),
        // 预设
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '④ 预设（模型 + 思考强度，一键切换）'),
          h(
            'div',
            { style: S.row },
            h(
              'select',
              {
                style: { ...S.select, maxWidth: '320px' },
                value: (snap && snap.activePreset) || '',
                disabled: busy !== '' || !snap,
                onChange: (e) => void run(['preset', 'use', String(e.target.value || 'chain')], 'preset'),
              },
              h('option', { value: '' }, '不使用预设（用当前手动链）'),
              (snap && snap.presets ? snap.presets : []).map((preset) =>
                h('option', { key: preset.id, value: preset.id },
                  `${preset.label ? `${preset.label}（${preset.id}）` : preset.id}${preset.builtin ? ' · 内置' : ''}`),
              ),
            ),
            h('input', {
              style: S.input,
              placeholder: '新预设 id',
              value: presetName,
              disabled: busy !== '',
              onChange: (e) => setPresetName(e.target.value),
            }),
            h('button', {
              style: S.btn,
              disabled: busy !== '' || !presetName.trim(),
              onClick: async () => {
                await run(['preset', 'save', presetName.trim()], 'preset-save')
                setPresetName('')
              },
            }, '存为预设'),
            snap && snap.activePreset
              ? h('button', {
                  style: { ...S.btn, color: C.bad },
                  disabled: busy !== '',
                  onClick: () => void run(['preset', 'delete', snap.activePreset], 'preset-delete'),
                }, '删除当前预设')
              : null,
          ),
          snap && snap.presets && snap.presets.length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                snap.presets.map((preset) =>
                  h('div', { key: preset.id, style: { ...S.dim, display: 'flex', gap: '8px' } },
                    h('span', { style: { ...S.badge, color: preset.active ? C.accent : C.faint, borderColor: preset.active ? C.accent : C.border } },
                      preset.active ? '使用中' : preset.builtin ? '内置' : '自定义'),
                    h('span', { style: { color: C.muted } }, preset.summary || '（空）'),
                  ),
                ),
              )
            : null,
        ),
        // 状态 / 维护
        h(
          'div',
          { style: S.card },
          h('div', { style: { ...S.cardTitle, justifyContent: 'space-between' } },
            '⑤ 状态与维护',
            h('div', { style: S.row },
              h('button', { style: S.btn, disabled: busy !== '', onClick: () => void refresh() }, '刷新'),
              h('button', { style: S.btn, disabled: busy !== '', onClick: () => void run(['reset'], 'reset') }, '重置冷却与统计'),
              h(
                'button',
                {
                  style: { ...S.btn, color: confirmReset ? C.bad : C.muted, borderColor: confirmReset ? C.bad : C.border },
                  disabled: busy !== '',
                  onClick: async () => {
                    if (!confirmReset) {
                      setConfirmReset(true)
                      return
                    }
                    setConfirmReset(false)
                    await run(['reset-all'], 'reset-all')
                  },
                },
                confirmReset ? '再点一次：恢复默认' : '恢复默认设置',
              ),
            ),
          ),
          h('div', { style: S.dim },
            snap
              ? `冷却策略：额度类 ${Math.round(snap.cooldownConfig.quotaMs / 1000)}s · 其它错误 ${Math.round(snap.cooldownConfig.errorMs / 1000)}s ｜ 尝试顺序：${(snap.order || []).join(' → ') || '—'}`
              : '加载中…',
          ),
          log ? h('pre', { style: S.log }, log) : null,
        ),
      )
    }

    /* ======================================================================
       右下角模型选择器：把「自动轮询（Auto）」置顶
       ----------------------------------------------------------------------
       官方选择器（@deepseek-ai/dsh-client-ui-model-selection）占用的是 single 槽
       `conversation.input.model`，没有可以追加子项的口子，所以这里整体接管这个
       座位：数据仍然来自同一个 per-session `ModelDirectory`（目录 / 提交都与官方
       一致），只是菜单第一行固定是「自动轮询」，选中即把会话切到本插件的虚拟
       provider（rotation/auto），之后每次调用都按设置页里的链逐档尝试。
       ====================================================================== */

    const AUTO_PLACEHOLDER = { provider: 'rotation', model: 'auto' }
    /** 虚拟 provider/模型可由设置覆盖，这里读一次宿主状态 */
    const autoTarget = { provider: AUTO_PLACEHOLDER.provider, model: AUTO_PLACEHOLDER.model }
    let autoTargetRequested = false

    function ensureAutoTarget() {
      if (autoTargetRequested) return
      autoTargetRequested = true
      getJson(STATE_URL)
        .then((data) => {
          const provider = data && data.virtual ? data.virtual.provider : undefined
          const model = data && data.virtual ? data.virtual.model : undefined
          if (typeof provider === 'string' && provider && typeof model === 'string' && model) {
            autoTarget.provider = provider
            autoTarget.model = model
          }
        })
        .catch(() => {})
    }

    /** 各 provider 的显示名：优先用宿主 /catalog 里 provider 自报的名字（不写死任何厂家/型号） */
    const LABELS = { data: {}, at: 0, inflight: null }
    /**
     * /catalog 的形状可能是新版（顶层 labels 映射）或旧版（只有 groups[].providers[]），
     * 这里两种都认，避免宿主版本不同就丢标签 —— 标签只做兜底，不参与任何逻辑。
     */
    const labelsFromCatalog = (data) => {
      const out = {}
      if (!data || typeof data !== 'object') return out
      if (data.labels && typeof data.labels === 'object') {
        for (const id of Object.keys(data.labels)) {
          const name = asStr(data.labels[id])
          if (id && name) out[id] = name
        }
      }
      const groups = Array.isArray(data.groups) ? data.groups : []
      for (const group of groups) {
        if (!group || typeof group !== 'object') continue
        const providers = Array.isArray(group.providers) ? group.providers : []
        for (const provider of providers) {
          if (!provider || typeof provider !== 'object') continue
          const id = asStr(provider.id)
          if (!id || out[id]) continue
          const name = asStr(provider.name) || asStr(provider.displayName)
          if (name) out[id] = name
        }
        const groupId = asStr(group.id)
        if (groupId && !out[groupId]) {
          const groupName = asStr(group.label) || asStr(group.name)
          if (groupName) out[groupId] = groupName
        }
      }
      return out
    }
    function loadProviderLabels() {
      if (LABELS.inflight) return
      if (Date.now() - LABELS.at < 60000 && Object.keys(LABELS.data).length > 0) return
      LABELS.inflight = getJson(CATALOG_URL)
        .then((data) => {
          const map = labelsFromCatalog(data)
          LABELS.data = map
          LABELS.at = Date.now()
        })
        .catch(() => {})
        .finally(() => {
          LABELS.inflight = null
        })
    }
    const providerLabel = (id) => (id && LABELS.data[id]) || ''

    /** 目录里的 group 形状可能随宿主版本变化，这里只做宽松归一（取不到就留空，不做假设） */
    const asStr = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
    const normalizeModel = (model) => ({
      id: asStr(model && (model.id ?? model.model)),
      name: asStr(model && (model.name ?? model.label)),
      reasoning: (model && model.reasoning) || undefined,
    })
    const normalizeGroup = (group) => {
      const id = asStr(group && (group.id ?? group.provider ?? group.key))
      const name = asStr(group && (group.name ?? group.label ?? group.title))
      const models = Array.isArray(group && group.models)
        ? group.models
        : Array.isArray(group && group.items)
          ? group.items
          : []
      return { id, name: name || providerLabel(id) || id, models: models.map(normalizeModel) }
    }
    const normalizeGroups = (groups) => (Array.isArray(groups) ? groups.map(normalizeGroup) : [])

    const matchModels = (models, query) => {
      const q = String(query == null ? '' : query).trim().toLowerCase()
      if (!q) return models
      return models.filter((model) => `${model.name || ''} ${model.id}`.toLowerCase().includes(q))
    }

    const COMPOSER_CSS = [
      '.mrot-root{position:relative;min-width:0}',
      '.mrot-trigger{display:flex;align-items:center;gap:4px;height:28px;min-width:0;max-width:min(360px,45cqw);padding:0 6px 0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}',
      '.mrot-trigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.mrot-trigger:disabled{opacity:.55;cursor:default}',
      '.mrot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.mrot-label-auto{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.mrot-effort{color:var(--dsw-alias-label-secondary);opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}',
      '.mrot-chevron{flex:none;opacity:.6;transition:transform .12s}',
      '.mrot-chevron-open{transform:rotate(180deg)}',
      '.mrot-menu{position:fixed;z-index:1100;display:flex;flex-direction:column;min-width:250px;max-width:min(430px,100vw - 32px);max-height:min(390px,100vh - 96px);padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 34px rgba(0,0,0,.2)}',
      '.mrot-search{display:flex;padding:2px 3px 6px}',
      '.mrot-search input{flex:1;min-width:0;padding:5px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;outline:none}',
      '.mrot-list{display:flex;flex-direction:column;overflow-y:auto;min-height:0}',
      '.mrot-group{padding:8px 7px 3px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary);opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mrot-row{display:flex;align-items:center;gap:6px;min-height:32px;padding:4px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer}',
      '.mrot-row:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.mrot-row[data-on="true"]{background:var(--dsw-alias-bg-layer-2)}',
      '.mrot-row:disabled{opacity:.5;cursor:default}',
      '.mrot-row-main{display:flex;flex-direction:column;flex:1;min-width:0}',
      '.mrot-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mrot-row-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mrot-check{flex:0 0 14px;display:grid;place-items:center;font-size:12px}',
      '.mrot-sep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1)}',
      '.mrot-cell{display:flex;align-items:center;gap:6px;min-height:32px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer}',
      '.mrot-cell:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.mrot-cell-label{flex:none}',
      '.mrot-cell-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-secondary)}',
      '.mrot-cell-chevron{flex:none;opacity:.55}',
      '.mrot-error{margin:4px 2px 0;padding:5px 7px;border-radius:6px;background:color-mix(in oklab, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}',
    ].join('')

    function ensureComposerCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('mrot-composer-css')) return
      const el = document.createElement('style')
      el.id = 'mrot-composer-css'
      el.textContent = COMPOSER_CSS
      document.head.appendChild(el)
    }

    /**
     * 接管模型座位：props 由槽的 inject 注入（与官方一致的目录与提交通道）。
     */
    function ModelSeat(props) {
      const available = props.available
      const locked = props.locked === true
      const directory = props.directory
      const load = props.load
      const select = props.select

      const state = React.useSyncExternalStore(
        (notify) => directory.subscribe(notify),
        () => directory.getSnapshot(),
      )
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('root')
      const [query, setQuery] = useState('')
      const [error, setError] = useState('')
      const [pos, setPos] = useState(null)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)

      const groups = useMemo(() => normalizeGroups(state && state.groups), [state])
      const current = (state && state.current) || null
      const pending = state ? state.pending : null
      const busy = pending !== null && pending !== undefined
      const isAuto = current !== null && current.provider === autoTarget.provider && current.model === autoTarget.model
      const currentGroup = current === null ? undefined : groups.find((group) => group.id === current.provider)
      const currentModel =
        currentGroup === undefined || current === null ? undefined : currentGroup.models.find((model) => model.id === current.model)
      const reasoning = currentModel ? currentModel.reasoning : undefined
      const effectiveEffort = current && current.reasoningEffort !== undefined ? current.reasoningEffort : reasoning ? reasoning.defaultEffort : undefined
      const effortName =
        reasoning === undefined
          ? ''
          : effectiveEffort === undefined
            ? ''
            : (reasoning.efforts.find((effort) => effort.id === effectiveEffort) || {}).name || effectiveEffort
      const totalModels = useMemo(() => groups.reduce((sum, group) => sum + group.models.length, 0), [groups])
      const showSearch = totalModels > 4
      const filteredGroups = useMemo(
        () =>
          groups
            .map((group) => ({ ...group, models: matchModels(group.models, showSearch ? query : '') }))
            .filter((group) => group.models.length > 0),
        [groups, query, showSearch],
      )
      const effortRows = useMemo(() => {
        if (reasoning === undefined) return []
        const rows = reasoning.defaultEffort === undefined ? [{ id: '', name: '（跟随提供方默认）' }] : []
        return rows.concat(reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name })))
      }, [reasoning])

      // 贴住触发按钮上方定位（视口内夹紧）
      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null)
          return
        }
        const place = () => {
          const rect = triggerRef.current ? triggerRef.current.getBoundingClientRect() : null
          if (rect === null) return
          const MARGIN = 12
          const width = menuRef.current ? menuRef.current.offsetWidth : 0
          const height = menuRef.current ? menuRef.current.offsetHeight : 0
          let left = rect.right - width
          let top = rect.top - 8 - height
          if (width > 0) left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN)
          if (height > 0) top = Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN)
          setPos({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, pane, query, state])

      // 点外面 / Esc 关闭
      useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (menuRef.current && menuRef.current.contains(event.target)) return
          if (rootRef.current && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (!available) return null

      const showMenu = () => {
        loadProviderLabels()
        setError('')
        setQuery('')
        setPane('root')
        setOpen(true)
        if (typeof load === 'function') load()
      }
      const closeMenu = () => setOpen(false)
      const choose = async (selection) => {
        setError('')
        let result
        try {
          result = await select(selection)
        } catch (err) {
          setError(err && err.message ? String(err.message) : '切换失败，请重试')
          return
        }
        if (result && result.ok === false) {
          setError(result.error && result.error.message ? String(result.error.message) : '切换失败，请重试')
          return
        }
        setOpen(false)
      }
      const chooseAuto = () => choose({ provider: autoTarget.provider, model: autoTarget.model })
      const chooseModel = (group, model) => {
        const selection = { provider: group.id, model: model.id }
        if (model.reasoning && model.reasoning.defaultEffort !== undefined) selection.reasoningEffort = model.reasoning.defaultEffort
        return choose(selection)
      }
      const chooseEffort = (effortId) => {
        if (current === null) return undefined
        const selection = { provider: current.provider, model: current.model }
        if (effortId) selection.reasoningEffort = effortId
        return choose(selection)
      }

      const triggerLabel = current === null ? '选择模型' : isAuto ? '自动轮询' : currentModel ? currentModel.name || current.model : current.model

      const trigger = h(
        'button',
        {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'mrot-trigger',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: locked || busy,
          title: isAuto
            ? '当前：自动轮询（Model Rotation）— 每次调用按设置里的链逐档尝试'
            : `当前模型：${currentGroup ? currentGroup.name : ''}${triggerLabel ? ' / ' + triggerLabel : ''}`,
          onClick: () => (open ? closeMenu() : showMenu()),
        },
        h('span', { className: isAuto ? 'mrot-label mrot-label-auto' : 'mrot-label' }, isAuto ? '⚡ ' + triggerLabel : triggerLabel),
        effortName && !isAuto ? h('span', { className: 'mrot-effort' }, effortName) : null,
        h('span', { className: 'mrot-chevron' + (open ? ' mrot-chevron-open' : '') }, '⌄'),
      )

      let menu = null
      if (open) {
        const rows = []
        if (pane === 'root') {
          rows.push(
            h(
              'button',
              {
                key: 'auto',
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': isAuto,
                className: 'mrot-row',
                'data-on': isAuto ? 'true' : 'false',
                disabled: busy,
                onClick: chooseAuto,
              },
              h(
                'span',
                { className: 'mrot-row-main' },
                h('span', { className: 'mrot-row-name' }, '⚡ 自动轮询（Auto）'),
                h('span', { className: 'mrot-row-hint' }, '按模型轮询设置里的链逐档尝试，失败自动换下一档'),
              ),
              h('span', { className: 'mrot-check' }, isAuto ? '✓' : ''),
            ),
          )
          rows.push(h('div', { key: 'sep', className: 'mrot-sep' }))
          rows.push(
            h(
              'button',
              {
                key: 'model-cell',
                type: 'button',
                className: 'mrot-cell',
                onClick: () => {
                  setQuery('')
                  setPane('model')
                },
              },
              h('span', { className: 'mrot-cell-label' }, '模型'),
              h('span', { className: 'mrot-cell-value' }, triggerLabel),
              h('span', { className: 'mrot-cell-chevron' }, '›'),
            ),
          )
          if (effortRows.length > 0) {
            rows.push(
              h(
                'button',
                {
                  key: 'effort-cell',
                  type: 'button',
                  className: 'mrot-cell',
                  onClick: () => setPane('effort'),
                },
                h('span', { className: 'mrot-cell-label' }, '思考强度'),
                h('span', { className: 'mrot-cell-value' }, effortName || '提供方默认'),
                h('span', { className: 'mrot-cell-chevron' }, '›'),
              ),
            )
          }
        } else if (pane === 'model') {
          rows.push(
            h(
              'button',
              { key: 'back', type: 'button', className: 'mrot-cell', onClick: () => setPane('root') },
              h('span', { className: 'mrot-cell-chevron' }, '‹'),
              h('span', { className: 'mrot-cell-label' }, '返回'),
            ),
          )
          if (showSearch) {
            rows.push(
              h(
                'div',
                { key: 'search', className: 'mrot-search' },
                h('input', {
                  value: query,
                  placeholder: '搜索模型（支持模糊包含）',
                  onChange: (event) => setQuery(event.target.value),
                }),
              ),
            )
          }
          for (const group of filteredGroups) {
            const groupText = group.name || providerLabel(group.id) || group.id || '模型'
            rows.push(h('div', { key: 'g:' + group.id, className: 'mrot-group', title: groupText }, groupText))
            for (const model of group.models) {
              const on = current !== null && current.provider === group.id && current.model === model.id
              rows.push(
                h(
                  'button',
                  {
                    key: group.id + '/' + model.id,
                    type: 'button',
                    role: 'menuitemradio',
                    'aria-checked': on,
                    className: 'mrot-row',
                    'data-on': on ? 'true' : 'false',
                    disabled: busy,
                    onClick: () => chooseModel(group, model),
                  },
                  h('span', { className: 'mrot-row-main' }, h('span', { className: 'mrot-row-name' }, model.name || model.id)),
                  h('span', { className: 'mrot-check' }, on ? '✓' : ''),
                ),
              )
            }
          }
          if (filteredGroups.length === 0) {
            rows.push(h('div', { key: 'empty', className: 'mrot-group', style: { padding: '10px 7px' } }, '没有匹配的模型'))
          }
        } else if (pane === 'effort') {
          rows.push(
            h(
              'button',
              { key: 'back', type: 'button', className: 'mrot-cell', onClick: () => setPane('root') },
              h('span', { className: 'mrot-cell-chevron' }, '‹'),
              h('span', { className: 'mrot-cell-label' }, '返回'),
            ),
          )
          for (const row of effortRows) {
            const on =
              row.id === '' ? effectiveEffort === undefined : effectiveEffort !== undefined && effectiveEffort === row.id
            rows.push(
              h(
                'button',
                {
                  key: 'e:' + (row.id || 'default'),
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': on,
                  className: 'mrot-row',
                  'data-on': on ? 'true' : 'false',
                  disabled: busy,
                  onClick: () => chooseEffort(row.id),
                },
                h('span', { className: 'mrot-row-main' }, h('span', { className: 'mrot-row-name' }, row.name)),
                h('span', { className: 'mrot-check' }, on ? '✓' : ''),
              ),
            )
          }
        }

        menu = h(
          'div',
          {
            key: 'menu',
            ref: menuRef,
            className: 'mrot-menu',
            role: 'menu',
            style: pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.left + 'px', top: pos.top + 'px' },
          },
          h('div', { className: 'mrot-list' }, rows),
          error ? h('div', { className: 'mrot-error' }, error) : null,
        )
      }

      return h('div', { ref: rootRef, className: 'mrot-root' }, trigger, menu)
    }

    /* ======================================================================
       座位失败兜底：渲染器对 single 槽的条目有「崩了就 abdicate、回退官方」的
       机制（客户端 console 我们看不到）。这里自己再包一层错误边界：
         - 崩了就把错误上报到 host（/plugins/model-rotation/client-report）
         - 并渲染一个极简可用的「⚡自动」按钮，保证用户仍然能切到轮询模式
       ====================================================================== */

    class SeatBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        report('seat-crash', errorDetail(error, { componentStack: info && info.componentStack ? String(info.componentStack).split('\n').slice(0, 8).join('\n') : '' }))
      }

      render() {
        if (this.state.error) {
          const props = this.props || {}
          const select = props.select
          const target = autoTarget
          return h(
            'button',
            {
              type: 'button',
              className: 'mrot-fallback',
              title: '模型轮询面板渲染失败，点击切到自动轮询（详情已上报）',
              onClick: () => {
                try {
                  const pending = select && select({ provider: target.provider, model: target.model })
                  if (pending && typeof pending.catch === 'function') pending.catch(() => {})
                } catch (error) {
                  report('seat-fallback-select-failed', errorDetail(error))
                }
              },
            },
            '⚡ 自动轮询',
          )
        }
        return h(ModelSeat, this.props)
      }
    }

    /* ======================================================================
       「这次回答是哪个模型」：会话头徽章
       ----------------------------------------------------------------------
       槽位 `conversation.session.header.actions`（list, scope session）是会话
       标题旁的 action 区，agy-link 的状态徽章也挂在这里。host 半在每次模型调用
       成功后记录 lastAnswer（provider/model/label/耗时/切换轨迹），这里轮询
       状态接口展示；点开 tooltip 能看到这次回答前面失败过哪些档。
       ====================================================================== */

    const ANSWER_CSS = `
.mrot-answer { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08));
  color: var(--dsw-alias-label-secondary, inherit); font-size: 11.5px; line-height: 1; white-space: nowrap; cursor: default; user-select: none; }
.mrot-answer-bolt { color: var(--dsw-alias-brand-primary, #4f7cff); font-size: 12px; }
.mrot-answer-model { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.mrot-answer-meta { color: var(--dsw-alias-label-secondary, inherit); opacity: 0.85; }
.mrot-answer-switch { color: var(--dsw-alias-state-warn-primary, #d98324); }
.mrot-answer-live { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-success-primary, #22a06b); }
.mrot-fallback { height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28));
  background: transparent; color: var(--dsw-alias-label-primary, inherit); font-size: 12px; cursor: pointer; }
`

    let answerCssInstalled = false
    function ensureAnswerCss() {
      if (answerCssInstalled) return
      answerCssInstalled = true
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.getElementById('mrot-answer-css')) return
        const style = document.createElement('style')
        style.id = 'mrot-answer-css'
        style.textContent = ANSWER_CSS
        document.head.appendChild(style)
      } catch {
        /* 样式失败不影响功能 */
      }
    }

    const answerCache = { data: null, at: 0, inflight: false }

    function HeaderAnswerBadge(props) {
      const sessionId = props && props.sessionId !== undefined ? String(props.sessionId) : ''
      const [snapshot, setSnapshot] = useState(null)

      useEffect(() => {
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          const now = Date.now()
          if (!answerCache.inflight && now - answerCache.at > 2000) {
            answerCache.inflight = true
            try {
              const data = await getJson(STATE_URL)
              answerCache.data = data
              answerCache.at = Date.now()
            } catch {
              /* 忽略：host 半可能还没加载完 */
            } finally {
              answerCache.inflight = false
            }
          }
          if (!stopped) setSnapshot(answerCache.data)
          timer = setTimeout(tick, 4000)
        }
        void tick()
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      }, [])

      const answer = sessionId && snapshot && snapshot.answersBySession
        ? snapshot.answersBySession[sessionId]
        : snapshot && snapshot.lastAnswer
      if (!answer || !sessionId || String(answer.sessionId || '') !== sessionId) return null

      const label = answer.label || answer.model || '未知模型'
      const isDirect = answer.mode === 'direct'
      const effort = answer.reasoningEffort && answer.reasoningEffort !== 'none' ? answer.reasoningEffort : ''
      const latency = answer.latencyMs ? `${(answer.latencyMs / 1000).toFixed(1)}s` : ''
      const switched = Number(answer.switched) || 0
      const trail = Array.isArray(answer.attempts) ? answer.attempts : []
      const trailText = trail
        .map((item) => {
          const mark = item.ok ? '✅' : `❌ ${item.code || ''}`
          const ms = item.totalMs ? ` ${(item.totalMs / 1000).toFixed(1)}s` : ''
          return `${mark} ${item.group ? `[${item.group}] ` : ''}${item.key || item.model || ''}${ms}`
        })
        .join('\n')
      const hint = switched > 0 ? `（前面 ${switched} 档失败后切到本档）` : ''
      const headline = isDirect
        ? `本会话最近一次回答（直连）：${answer.provider}/${answer.model}`
        : `本会话最近一次轮询回答：${label}`
      const title =
        `${headline}${effort ? `（思考强度 ${effort}）` : ''}${isDirect ? '' : ` · ${snapshot.virtual ? `${snapshot.virtual.provider}/${snapshot.virtual.model}` : '旋转链'}`}\n` +
        `分组：${answer.groupLabel || answer.group || '—'}\n` +
        `耗时：${latency || '—'}${hint}\n` +
        (trailText ? `\n尝试轨迹：\n${trailText}` : '')

      return h(
        'div',
        { className: isDirect ? 'mrot-answer mrot-answer-direct' : 'mrot-answer', title, 'data-session': sessionId, 'aria-label': `最近回答模型：${label}` },
        h('span', { className: 'mrot-answer-bolt' }, isDirect ? '◆' : '⚡'),
        h('span', { className: 'mrot-answer-model' }, label),
        effort ? h('span', { className: 'mrot-answer-meta' }, `· ${effort}`) : null,
        latency ? h('span', { className: 'mrot-answer-meta' }, `· ${latency}`) : null,
        switched > 0 ? h('span', { className: 'mrot-answer-switch', title: '发生过自动切换' }, `↻${switched}`) : null,
        isDirect ? h('span', { className: 'mrot-answer-meta' }, '直连') : null,
      )
    }

    /* ---------------- 插件入口 ---------------- */

    const name = 'dsh-model-rotation-client'
    const inject = ['slots']

    function apply(ctx) {
      ensureComposerCss()
      ensureAnswerCss()
      ensureAutoTarget()
      loadProviderLabels()
      report('apply', {
        hasSlots: !!(ctx && ctx.slots),
        hasInject: typeof ctx?.inject === 'function',
        href: typeof window !== 'undefined' && window.location ? String(window.location.href || '').slice(0, 200) : '',
      }, true)

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'model-rotation',
            order: 26,
            label: () => '模型轮询',
          },
          ModelRotationSection,
        ),
      )

      // 接管 composer 模型座位：官方选择器是 single 槽，只能整体替换（置顶 Auto 的唯一做法）。
      // single 槽同 priority 注册会抛错，所以用更低的 priority 遮蔽官方那一份（槽的实现里「最低 priority 渲染」）。
      ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope) => {
        try {
          const models = scope && scope.modelDirectories
          if (!models || typeof models.directoryFor !== 'function') {
            report('seat-未注册', { reason: 'modelDirectories 服务不可用', hasScope: !!scope }, true)
            return
          }
          const sessions = scope.sessions
          const slots = scope.slots || ctx.slots
          slots.inject('conversation.input.model', () =>
            slots.register(
              {
                name: 'conversation.input.model',
                priority: -20,
                registrant: 'dsh-model-rotation',
                inject: (sessionId) => {
                  try {
                    const directory = models.directoryFor(sessionId)
                    let available = true
                    if (sessions && typeof sessions.subagentAddress === 'function') {
                      available = sessions.subagentAddress(sessionId) === undefined
                    }
                    report('seat-inject', { sessionId: String(sessionId ?? ''), available, target: autoTarget }, true)
                    return {
                      available,
                      directory: directory.store,
                      load: () => {
                        if (!available || typeof directory.load !== 'function') return
                        const pending = directory.load()
                        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
                      },
                      select: (selection) => (available ? directory.select(selection) : Promise.resolve(undefined)),
                    }
                  } catch (error) {
                    report('seat-inject-failed', errorDetail(error, { sessionId: String(sessionId ?? '') }))
                    return { available: false, directory: null, load: () => {}, select: () => Promise.resolve(undefined) }
                  }
                },
              },
              SeatBoundary,
            ),
          )
          report('seat-registered', { priority: -20, boundary: true }, true)
        } catch (err) {
          report('seat-register-failed', errorDetail(err))
          console.warn('[dsh-model-rotation] 接管模型选择器失败：' + (err && err.message ? err.message : String(err)))
        }
      })

      // 「这次回答是哪个模型」徽章：挂在会话标题旁的 action 区。
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'model-rotation-last-answer',
            order: 6,
            inject: (sessionId) => ({ sessionId }),
          },
          HeaderAnswerBadge,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
