# Changelog

本文件记录 `dsh-model-rotation` 的对外变更。版本号遵循 `MAJOR.MINOR.PATCH`。

## 0.8.2

**健壮性 / 向后兼容**

- 客户端取 provider 显示名时同时兼容 `/catalog` 的两种形状：新版顶层 `labels` 映射，
  旧版只有 `groups[].providers[].name`（宿主还在跑旧版本时标签也不会丢）；
- 模型选择器分组标题兜底链改为 `分组名 → provider 自报名字 → provider id`，并且标题加了 `title`
  提示、对比度略调高，避免浅色主题下看不清；
- 不写死任何厂家名、分组顺序或字段名，宿主/provider 插件升级换代不需要改本插件。

## 0.8.1

**兼容性 / 维护成本**

- 分组名不再依赖内置的 provider→中文名映射：优先用 `ctx.llm.listProviders()` 里 provider 自报的名字，
  取不到才退回别名、最后退回 provider id（模型选择器、设置页、会话头徽章、`/rotation status` 一致）；
- 客户端不再自己复刻官方分组排序（`deepseek-account` 优先那类硬编码），直接用官方模型目录给出的顺序；
- 目录数据结构做了宽松归一（`id/provider/key`、`models/items`、`name/label/title` 都能读），
  宿主或 provider 插件改字段名时不会整块空白，最差退化成显示 provider id；
- 设置页 `/catalog` 增加 `labels` 字段（provider 显示名映射），供客户端动态取用。

## 0.8.0

**界面（便于上手）**

- 设置页新增「三步上手」引导卡片：一句话说明 + 四个一键按钮（推荐链 / 自动排序 / 探测全部 / 命令速查）；
- 五个分区加序号：① 排序方式 → ② 轮询链 → ③ 添加候选 → ④ 预设 → ⑤ 状态与维护；
- 顶部状态条新增「冷却中 N 档」与「上次回答：模型名」两个徽章（悬停看分组、耗时、切换情况）；
- 主要按钮补充 `title` 悬浮说明。

**发布准备**

- 增加 `LICENSE`（MIT）、`CHANGELOG.md`、`PUBLISH.md`（上架流程与验收清单）；
- `package.json` 补关键词、`files` 白名单与仓库字段说明；`npm pack` 内容校验通过。

## 0.7.0

- **额度用尽自动重发**：监听 `agent/request-error`，失败档进冷却后让 agent 循环重跑这一步，
  等价于「自动再发一次消息，换成下一个模型」，最多 `maxAutoResends` 次（默认 2）；
- **直连模型也记录回答模型**：监听 `llm/stream`，会话头徽章对非轮询调用显示 `◆ … 直连`；
- 新增配置 `autoResend` / `maxAutoResends`。

## 0.6.1

- 修复模型选择器被别的插件遮蔽：slot `priority` 从 `-1` 改为 `-20`（对方是 `-10`）；
- 回答记录按会话保存（`answersBySession`，最多 100 个），标题生成 / 上下文压缩不覆盖；
- 强度记录改取真实委托参数。

## 0.6.0

- 会话头徽章：显示本次回答实际用的模型、强度、耗时、切换次数、尝试轨迹；
- 座位崩溃兜底（`SeatBoundary`）与浏览器侧诊断上报（`POST /plugins/model-rotation/client-report`）。

## 0.5.0

- composer 模型选择器置顶「⚡ 自动轮询（Auto）」（遮蔽官方 single 槽，走同一 per-session `ModelDirectory`）。

## 0.4.x

- 按来源分组（agy 账号池 / Codex 订阅 / 两家 DeepSeek API / 内置 DeepSeek），组内筛选模型；
- 默认链改为示例链：Gemini 3.8 Flash[high] → Codex 6.1 Sol[high] → xiao-DeepSeek Flash → 内置 DeepSeek Flash；
- 新增 `/rotation groups`、`/rotation probe group <id>`、`/rotation add|remove`。

## 0.3.0

- 新增 Web 设置页（`settings.section`「模型轮询」）与 host 路由 `/plugins/model-rotation/{state,command,catalog}`。

## 0.2.0

- 手动排序（`order/move/up/down`）、自动排序（`sort auto` + 三档偏好）、预设（模型 + 思考强度）。

## 0.1.0

- 首个可用版本：虚拟 provider `rotation` / 模型 `auto`，有序链、失败切换、冷却、探测。
