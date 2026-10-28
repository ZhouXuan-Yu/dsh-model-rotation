/**
 * 把本插件安装进 DSH Desktop —— 走桌面端自己的「generation」安装通道。
 *
 * 为什么不用 `dsh plugin --profile web add <目录>`：那条命令只是 pnpm 的薄包装，
 * 不会登记 `dsh.profile.bundles`，也不会把包放进 `profiles/.generations/live`，
 * 所以装进去的插件不会被加载。桌面端市场装插件走的是
 * `dsh-desktop-market-installer` 的 installGeneration（本地目录用 sourceDirectory），
 * 再由 publishInstalledGeneration 把 generation 投影成
 * `profiles/web/node_modules/<name>` 链接 + dependencies + bundles 名单。
 *
 * 用法（必须用 DSH 自带的 Electron node 跑，因为要从 app.asar 里 import）：
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "D:\DSH\DSH Desktop\DSH Desktop.exe" .\scripts\install.mjs
 *
 * 可选环境变量：DSH_HOME、DSH_APP_EXE、DSH_ASAR、DSH_PROFILE
 * 升级：改完代码直接重跑本脚本（每次装成新的 generation），然后重启 DSH 桌面端。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(scriptDir)
const pluginName = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')).name

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')
const APP_EXE = process.env.DSH_APP_EXE ?? 'D:\\DSH\\DSH Desktop\\DSH Desktop.exe'
const ASAR = process.env.DSH_ASAR ?? 'D:\\DSH\\DSH Desktop\\resources\\app.asar'
const PROFILE = process.env.DSH_PROFILE ?? 'web'

if (process.versions.electron === undefined) {
  console.error('必须在 DSH Desktop 的 Electron node 里运行：设置 ELECTRON_RUN_AS_NODE=1，并用 DSH Desktop.exe 启动本脚本。')
  process.exit(1)
}
if (!existsSync(APP_EXE)) throw new Error(`找不到 DSH 可执行文件：${APP_EXE}`)

const generationModules = pathToFileURL(
  `${ASAR.replace(/\\/gu, '/')}/node_modules/dsh-desktop-market-installer/generations`,
).href
const load = (name) => import(`${generationModules}/${name}`)
const { installGeneration } = await load('installer.mjs')
const { publishInstalledGeneration } = await load('projection.mjs')
const { readDesired, writeDesired, listGenerations, withRegistryLock } = await load('registry.mjs')

const log = (...parts) => console.log('[install]', ...parts)

const generation = await withRegistryLock(DSH_HOME, async () => {
  log(`plugin: ${pluginName}  source: ${pluginDir}`)
  log(`dshHome: ${DSH_HOME}  profile: ${PROFILE}`)
  const installed = await installGeneration({
    dshHome: DSH_HOME,
    profile: PROFILE,
    pluginSpec: pluginName,
    expectedPluginName: pluginName,
    sourceDirectory: pluginDir,
    nodeExecutablePath: APP_EXE,
    pnpmEntryPath: `${ASAR}/node_modules/pnpm/bin/pnpm.cjs`,
    environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    onTrace: (line) => log(line),
    onOutput: (chunk) => process.stdout.write(chunk),
  })
  if (!installed.ok) throw new Error(`installGeneration 失败：${installed.detail}`)
  log('generation:', installed.generation.id)

  const desired = await readDesired(DSH_HOME)
  const all = await listGenerations(DSH_HOME)
  const byId = new Map(all.map((entry) => [entry.id, entry]))
  const kept = desired.filter((id) => byId.get(id)?.pluginName !== pluginName)
  await writeDesired(DSH_HOME, [...kept, installed.generation.id])

  const published = await publishInstalledGeneration(DSH_HOME, pluginName, PROFILE, { syncBundles: true })
  log('bundles 已含本插件:', published.bundles.includes(pluginName))
  return installed.generation
})

log(`完成：${generation.id}`)
log('重启 DSH 桌面端后生效；会话里可以选「Model Rotation / Auto」，或运行 /rotation status。')
