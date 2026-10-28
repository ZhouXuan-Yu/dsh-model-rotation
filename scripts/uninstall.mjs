/**
 * 卸载/停用本插件：把本插件的所有 generation 从 desired.json 里摘掉，
 * 再重新投影 profile（移掉 node_modules 链接、dependencies/overrides、
 * dsh.profile.bundles 里的条目）。generation 目录本身留着，重启后可被清理。
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "D:\DSH\DSH Desktop\DSH Desktop.exe" .\scripts\uninstall.mjs
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(scriptDir)
const pluginName = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')).name

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')
const ASAR = process.env.DSH_ASAR ?? 'D:\\DSH\\DSH Desktop\\resources\\app.asar'
const PROFILE = process.env.DSH_PROFILE ?? 'web'

if (process.versions.electron === undefined) {
  console.error('必须在 DSH Desktop 的 Electron node 里运行：设置 ELECTRON_RUN_AS_NODE=1，并用 DSH Desktop.exe 启动本脚本。')
  process.exit(1)
}

const modulesUrl = pathToFileURL(
  `${ASAR.replace(/\\/gu, '/')}/node_modules/dsh-desktop-market-installer/generations`,
).href
const load = (name) => import(`${modulesUrl}/${name}`)
const { projectGenerations } = await load('projection.mjs')
const { disableGeneration, withRegistryLock } = await load('registry.mjs')

const result = await withRegistryLock(DSH_HOME, async () => {
  const removed = await disableGeneration(DSH_HOME, pluginName)
  const projected = await projectGenerations(DSH_HOME, PROFILE)
  return { removed, projected }
})

console.log(`[uninstall] ${pluginName} 已${result.removed ? '' : '未'}在 desired 中，profile 已重新投影。`)
console.log('[uninstall] bundles 现在含本插件:', result.projected.bundles.includes(pluginName))
console.log('[uninstall] 重启 DSH 桌面端后不再加载。')
