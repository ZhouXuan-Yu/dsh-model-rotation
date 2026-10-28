#!/usr/bin/env node
/**
 * 一键发布 dsh-model-rotation（打包 → 提交 → 推送 → npm publish → 校验）。
 *
 * 用法：
 *   node scripts/publish.mjs                 # 用当前 package.json 版本发布
 *   node scripts/publish.mjs --test          # 先跑三套测试再发布（推荐）
 *   node scripts/publish.mjs --bump patch    # 先升版本（patch|minor|major）再发布
 *   node scripts/publish.mjs --dry-run       # 只做检查与打包预览，不提交、不发包
 *   node scripts/publish.mjs --skip-git      # 只发 npm，不动 git
 *   node scripts/publish.mjs --skip-npm      # 只走 git，不发 npm
 *   node scripts/publish.mjs --otp 123456    # 账号开了 2FA 且 token 没绕过时用
 *
 * 依赖：npm 已登录（%USERPROFILE%\.npmrc 里有 //registry.npmjs.org/:_authToken=...），
 *       git 远端 origin 可写。本脚本不读取也不打印 token。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(root, '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const DRY = has('--dry-run')
const SKIP_GIT = has('--skip-git')
const SKIP_NPM = has('--skip-npm')
const RUN_TESTS = has('--test')
const BUMP = valueOf('--bump')
const OTP = valueOf('--otp')

const title = (text) => console.log(`\n=== ${text} ===`)
const ok = (text) => console.log(`  ✓ ${text}`)
const info = (text) => console.log(`  · ${text}`)

const WIN = process.platform === 'win32'
const quoteArg = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)

/** Windows 下 .cmd 需要 shell 才能解析；用单条命令字符串避免 DEP0190 警告。 */
function spawnCommand(cmd, argv, options = {}) {
  if (WIN) {
    return spawnSync([cmd, ...argv.map(quoteArg)].join(' '), {
      cwd: options.cwd || root,
      stdio: options.stdio || 'inherit',
      encoding: 'utf8',
      shell: true,
    })
  }
  return spawnSync(cmd, argv, {
    cwd: options.cwd || root,
    stdio: options.stdio || 'inherit',
    encoding: 'utf8',
  })
}

function sh(cmd, argv, options = {}) {
  const result = spawnCommand(cmd, argv, {
    cwd: options.cwd || root,
    stdio: options.quiet ? 'pipe' : 'inherit',
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status !== 0) {
    console.error(`\n  ✗ ${cmd} ${argv.join(' ')} 退出码 ${result.status}`)
    if (options.quiet && output.trim()) console.error(output.trim())
    process.exit(result.status ?? 1)
  }
  return output
}

function shOptional(cmd, argv, options = {}) {
  const result = spawnCommand(cmd, argv, {
    cwd: options.cwd || root,
    stdio: 'pipe',
  })
  return { code: result.status ?? 1, output: `${result.stdout || ''}${result.stderr || ''}`.trim() }
}

/* 1. 版本 */
title('版本')
const pkgPath = join(root, 'package.json')
let pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (BUMP) {
  if (!['patch', 'minor', 'major'].includes(BUMP)) {
    console.error('  ✗ --bump 只能是 patch / minor / major')
    process.exit(1)
  }
  const [major, minor, patch] = pkg.version.split('.').map((part) => Number(part))
  const next =
    BUMP === 'major' ? `${major + 1}.0.0` : BUMP === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
  info(`${pkg.version} → ${next}`)
  pkg.version = next
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
} else {
  info(`${pkg.name}@${pkg.version}`)
}
const version = pkg.version
const tag = `v${version}`

/* 2. 语法检查 */
title('语法检查')
for (const file of ['index.js', 'client.js']) {
  shOptional(process.execPath, ['--check', join(root, file)])
  ok(file)
}

/* 3. 测试（可选） */
if (RUN_TESTS) {
  title('测试')
  for (const script of ['_rotation_smoke.mjs', '_rot_real_import.mjs', '_rotation_client_check.mjs']) {
    info(script)
    sh(process.execPath, [join(workspace, script)], { cwd: workspace })
  }
  ok('三套测试通过')
}

/* 4. 打包预览 */
title('打包预览')
const pack = shOptional(NPM, ['pack', '--dry-run'])
const summary = pack.output
  .split(/\r?\n/)
  .filter((line) => /total files|package size|unpacked size|filename:/.test(line))
  .map((line) => line.replace(/^npm notice\s*/, '  · '))
console.log(summary.join('\n') || '  · (无输出)')

/* 5. git：提交 / 打标签 / 推送 */
if (!SKIP_GIT) {
  title('git')
  const inside = shOptional('git', ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0) {
    console.error('  ✗ 不在 git 仓库里，无法提交（可用 --skip-git 跳过）')
    process.exit(1)
  }
  const status = shOptional('git', ['status', '--porcelain'])
  if (status.output) {
    if (DRY) {
      info('有未提交改动（dry-run 不提交）：')
      console.log(status.output.split(/\r?\n/).slice(0, 12).map((line) => `    ${line}`).join('\n'))
    } else {
      sh('git', ['add', '-A'])
      sh('git', ['commit', '-m', `release: ${tag}`])
      ok(`已提交 release: ${tag}`)
    }
  } else {
    ok('工作区干净，无需提交')
  }
  const existingTag = shOptional('git', ['tag', '--list', tag])
  if (!existingTag.output && !DRY) {
    sh('git', ['tag', '-a', tag, '-m', `${pkg.name} ${tag}`])
    ok(`已打标签 ${tag}`)
  } else {
    info(existingTag.output ? `标签 ${tag} 已存在` : `dry-run：跳过打标签 ${tag}`)
  }
  if (!DRY) {
    sh('git', ['push', 'origin', 'HEAD'])
    sh('git', ['push', 'origin', tag])
    ok('已推送到 origin')
  } else {
    info('dry-run：跳过 git push')
  }
} else {
  title('git')
  info('--skip-git：跳过')
}

/* 6. npm publish */
if (!SKIP_NPM && !DRY) {
  title('npm publish')
  const publishArgs = ['publish', '--access', 'public']
  if (OTP) publishArgs.push('--otp', OTP)
  const result = spawnCommand(NPM, publishArgs, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('\n  ✗ npm publish 失败：')
    console.error('    - 403 且提示 staging/2FA：token 权限是「读写（仅阶段）」，需要改成「阅读与写入（发布与分期）」或勾选 Bypass 2FA')
    console.error('    - EOTP：账号开了 2FA，用 --otp <6位码> 重跑')
    process.exit(result.status ?? 1)
  }
  ok(`已发布 ${pkg.name}@${version}`)
} else {
  title('npm publish')
  info(DRY ? 'dry-run：跳过发布' : '--skip-npm：跳过发布')
}

/* 7. 校验 */
if (!SKIP_NPM && !DRY) {
  title('校验 registry')
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const meta = await response.json()
    const versions = Object.keys(meta.versions || {})
    if (versions.includes(version)) {
      ok(`registry 已有 ${version}；latest = ${meta['dist-tags']?.latest}`)
    } else {
      console.warn(`  ! registry 暂时还没看到 ${version}（可能有 CDN 延迟），稍后再查：npm view ${pkg.name} versions`)
    }
    const stray = versions.filter((item) => item !== version && /stage/i.test(item))
    if (stray.length) {
      console.warn(`  ! 发现 stage 占位版本 ${stray.join(', ')}，可用 npm deprecate 清理说明`)
    }
  } catch (error) {
    console.warn(`  ! 校验失败（不影响已发布）：${error instanceof Error ? error.message : String(error)}`)
  }
}

title('完成')
console.log(`  npm     https://www.npmjs.com/package/${pkg.name}`)
console.log(`  github  ${pkg.repository?.url || '(未设置)'}`)
console.log(`  安装    npm i ${pkg.name} -g  或  dsh plugin add ${pkg.name}`)
if (!DRY && !SKIP_NPM) console.log('  提醒    本地 DSH 生效仍需 node scripts/install.mjs 后重启桌面端')
