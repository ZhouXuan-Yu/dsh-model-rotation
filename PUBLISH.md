# 发布到插件市场：操作清单

本插件按 DSH（DeepSeek Harness）的 bundle + client 双半约定编写，不依赖任何私有补丁，
因此可以按普通 npm 包发布，再由插件市场索引收录。

## 0. 发布前自检（本地，全部应通过）

```powershell
cd dsh-model-rotation
node --check index.js
node --check client.js
node ..\_rotation_smoke.mjs          # host 侧：轮询/切换/排序/预设/冷却/自动重发
node ..\_rot_real_import.mjs         # 用真实 @deepseek-ai/* 模块 import 并 apply
node ..\_rotation_client_check.mjs   # 离线渲染：设置页 / composer 座位 / 徽章
npm pack --dry-run                   # 看最终包里到底有哪些文件
```

## 1. 需要人工补齐的元数据

`package.json` 里下面几项必须有真实值（市场卡片会读）：

| 字段 | 说明 |
|---|---|
| `repository` | 源码仓库，例如 `{"type":"git","url":"https://github.com/<你>/dsh-model-rotation.git"}` |
| `homepage` | 项目主页/文档地址（可选） |
| `author` | 作者名或 `{name,email}` |
| `bugs` | 问题反馈地址（可选） |
| `icon` | 市场卡片图标：先确认当前市场 schema 接受哪种写法（`dsh.icon` 还是顶层 `icon`），再补 `assets/icon.svg` + `exports["./icon"]` |

> 不确定就**先不加**：宁可市场卡片没图标，也不要因为未知字段导致 `dsh.client` 校验失败。

## 2. 打包与本地验证包内容

```powershell
npm pack
# 应只包含：index.js / client.js / cordis.patch.yml / README.md / CHANGELOG.md / LICENSE / package.json
```

`files` 白名单已限定上述文件；`scripts/`、`node_modules/` 不会进包。

## 3. 发布到 npm

```powershell
npm login                       # 需要已开 2FA
npm publish --access public     # 未加 scope 的包用 public 也兼容
```

发布前建议先发一个 `0.8.0-rc.1` 试装，确认安装后 DSH 能正常加载：

```powershell
dsh plugin --profile web add dsh-model-rotation   # 仅 pnpm 层，市场安装请走插件页
```

> 提醒：DSH Desktop 里 **`dsh plugin` 只是 pnpm 薄包装**，不会登记 bundle，
> 真正安装要经插件市场/插件页（内部走 `dsh-desktop-market-installer` 的 generation 流程）。
> 本仓库的 `scripts/install.mjs` 是等价的本地安装通道。

## 4. 提交到市场索引

桌面端「插件市场」的列表**不读 npm**，只读精选目录
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（市场里 `dshmarket` 的 `lib/regions.js` 把 `https://awesome-dsh-plugin.com/plugins.json`
作为官方目录地址），所以发了 npm 也不会自动上架。实际流程（已按此提交）：

1. 仓库加 `dsh-plugin` topic：`gh repo edit <owner>/<repo> --add-topic dsh-plugin`；
2. 仓库根放 `screenshots.json`（相对路径数组，1–8 张，市场详情页用）——本仓库已放
   `assets/shot-composer.png` / `assets/shot-settings.png` / `assets/shot-badge.png`；
3. fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增**一个**文件
   `data/plugins/<owner>__<repo>.yml`：

   ```yaml
   url: https://github.com/ZhouXuan-Yu/dsh-model-rotation
   name: ZhouXuan-Yu/dsh-model-rotation
   category: model
   description:
     en: '...one line, ends with a period, no marketing...'
     zh: '...'
   ```

   `data/plugins/*.yml` 是唯一数据源，两个 README 由脚本生成，**不要手改**；
   `category` 合法值里有 `model`；描述含 `: ` 必须加引号；
4. 提 PR（本仓库对应 **PR #10029**），CI 会跑 `PR check`（格式/lint/README 重生成）
   和 `Submission gate`（`dsh.bundle`、仓库**创建满 1 天**、代码真实可用）；
5. 合并后站点重建，市场里即可搜到。仓库年龄不足时 gate 会红，但**会自动重跑**，
   不需要重复提交或关闭重开。

> 已确认的硬性门槛：`package.json` 必须有 `dsh.bundle`（只声明 `dsh.client` 会被拒）；
> 仓库创建满 1 天（无法作弊，只能等）；描述会被维护者拿去和代码核对，不要夸大。


## 5. 上架文案（可直接复用）

- **一句话**：按来源分组选模型，排好顺序自动轮询；额度用尽自动换下一档，并把这一步自动重发。
- **亮点**：
  - 分组：agy 账号池 / Codex 订阅 / 两家 DeepSeek API / 内置 DeepSeek，组内可筛选；
  - 排序：手动拖顺序，或按「健康度 + 延迟」自动排序（三档偏好）；
  - 预设：把「模型 + 思考强度」打包，一键切换；
  - 容错：额度/鉴权/限流/5xx 自动切下一档；已输出内容后改用整步重发，避免半截答案；
  - 可视：composer 菜单第一行「⚡ 自动轮询」，会话头徽章显示本次到底是哪个模型答的。
- **依赖说明**（市场卡片需注明）：
  - 需要 DSH ≥ 支持 `llm.registerAdapter`、`agent/request-error`、`client` 双半的版本；
  - 链里的模型来自你已安装的 provider 插件（agy-link / codex-subscription / llm-pi-ai / 官方 DeepSeek）；
  - 未安装对应 provider 时，该档会在探测里显示 ❌ 并给出来源不可用的原因。

## 6. 发布后回归

1. 干净 profile 安装本插件 → 设置里出现「模型轮询」页；
2. 模型选择器第一行是「⚡ 自动轮询」；
3. `/rotation status`、`/rotation probe`、`/rotation test` 正常；
4. 会话头徽章出现且在直连模型时显示「直连」；
5. 卸载（插件页移除）后模型选择器恢复官方实现（我们只是遮蔽，不修改官方代码）。
## 发布（维护者）

已发布：https://www.npmjs.com/package/dsh-model-rotation

一键发布（打包 → git 提交/打标签/推送 → npm publish → registry 校验）：

```powershell
node scripts/publish.mjs --test                 # 跑三套测试后发布当前版本
node scripts/publish.mjs --bump patch --test    # 先升版本再发布
node scripts/publish.mjs --dry-run              # 只检查与打包预览
```

DSH 里也能直接用同名 skill：`dsh-plugin-publish`（`~/.agents/skills/dsh-plugin-publish/SKILL.md`）。

凭据：npm token 存在 `%USERPROFILE%\.npmrc` 的 `//registry.npmjs.org/:_authToken=`，权限需为「阅读与写入（发布与分期）」。
