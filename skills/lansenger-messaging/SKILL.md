---
name: lansenger-messaging
description: How to communicate on Lansenger (蓝信) — send rich content via built-in Agent tools, approvals, and pitfalls
metadata: {"openclaw":{"requires":{"config":["channels.lansenger"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) 消息发送 — Agent 工具速查手册

本技能教你使用**内置 Agent 工具**（`lansenger_send_*` 等）从 OpenClaw 会话中向蓝信发送消息。

在蓝信会话中，**直接正常写回复即可**——Markdown 会自动渲染为 formatText。不需要额外工具，除非你需要 @提及。

> 💡 **更倾向于用 CLI？** 蓝信 CLI 技能套件（`lansenger` 技能）提供完整的 `lansenger message send-*` 命令，以及聊天记录、群组管理、日程、待办等扩展功能。无需修改 `openclaw.json` 配置（不用在 tools.allow 中加 `group:plugins`）。
> 
> CLI 安装与配置指引：[setup-for-ai-agents.md](https://github.com/lansenger-pm/lansenger-skills-official/blob/main/docs/setup-for-ai-agents.md) — 包含安装、凭证配置、身份选择、OAuth2 等完整流程。

注意，Markdown 和文件附件**互斥**。如果你同时需要格式化和文件，先发送 Markdown 回复，再单独调用 `lansenger_send_file`。

**绝对不要在 lansenger_send_text 中放原始 Markdown**——会显示为丑陋的源代码。

## CLI 凭证安全约束

> 本节适用于使用 `lansenger` 技能（CLI 方式）的 Agent。完整安装配置流程见 [setup-for-ai-agents.md](https://github.com/lansenger-pm/lansenger-skills-official/blob/main/docs/setup-for-ai-agents.md)。

**核心约束**：绝对不要修改或覆盖已有的 `lansenger` CLI/SDK profile（`~/.lansenger/sdk_state.json`）。已有 profile 可能被其他 Agent 使用，修改会导致静默故障。
- profile 已存在 → 原样复用，不执行任何 `config set`。
- profile 不存在 → 用当前会话凭证创建新 profile。

凭证来源：`channels.lansenger.{appId,appSecret,apiGatewayUrl}` 或 accounts 子账号 / 环境变量。

## 快速决策：该用什么工具？

需要发送内容？按以下决策树选择：

1. 带格式的普通回复 → 直接写。不需要工具。
2. Markdown + @提及 → `lansenger_send_format_text`
3. 纯文本 + @提及 + 文件 → `lansenger_send_text`
4. 发送文件 → **`message(action=send, filePath=<path>)`**（始终可用，任意文件类型）或 `lansenger_send_file`
5. 发送图片 URL → `lansenger_send_image_url`
6. 链接卡片 → `lansenger_send_link_card`
7. 图文消息 → `lansenger_send_app_articles`
8. 富文本卡片 → `lansenger_send_app_card`
9. 审批卡片 → `lansenger_send_approve_card`（approveCard 交互式按钮）
10. 撤回消息 → `lansenger_revoke_message`
11. 查找群列表 → `lansenger_query_groups`
12. 查看群详情 → `lansenger_group_info`
13. 查看群成员 → `lansenger_group_members`
14. 检查是否在群中 → `lansenger_group_check_membership`

## 消息类型能力矩阵

| 类型       | Markdown | @提及          | 附件 |
|------------|----------|----------------|------|
| formatText | ✓ (自动) | ✓ (reminder)   | ✗    |
| text       | ✗        | ✓              | ✓    |

- **formatText**：Markdown 渲染，通过 reminder 参数支持 @提及（API 拒绝时自动回退）。不支持文件附件。
- **text**：纯文本。支持 @提及 + 文件附件。不支持 Markdown 渲染。
- 这两种类型**互斥**——根据需求选择一种。

## Agent 工具参考

**所有工具均自动从会话注入 `appId`**，无需手动传入。仅在需要指定不同账号时通过 `appId` 参数覆盖。`to`（chatId）可选，留空自动检测当前会话。

### lansenger_send_file

| 参数           | 类型     | 必填 | 说明 |
|----------------|----------|------|------|
| filePath       | string   | ✅    | 绝对本地路径（workspace、/tmp、Desktop 等） |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| caption        | string   | ❌    | 纯文本说明（不支持 Markdown） |
| coverImagePath | string   | ❌*   | **视频必填**：封面/缩略图路径。API 要求 mediaIds=[video, cover]。提取命令：`ffmpeg -i video.mp4 -vframes 1 -q:v 2 cover.jpg` |
| videoWidth     | integer  | ❌*   | **视频必填**：视频宽度（像素）。获取命令：`ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 video.mp4` |
| videoHeight    | integer  | ❌*   | **视频必填**：视频高度（像素）。获取命令：`ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 video.mp4` |
| videoDuration  | integer  | ❌*   | **视频必填**：视频时长（秒）。获取命令：`ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 video.mp4` |
| to             | string   | ❌    | 目标 chatId（省略则自动检测） |

\* *发送视频文件（`.mp4`、`.mov` 等）时必须提供。蓝信 API 强制要求视频类型提供封面图 + 元数据。缺失则发送失败。*

### lansenger_send_text

| 参数            | 类型     | 必填 | 说明 |
|-----------------|----------|------|------|
| content         | string   | ✅    | 纯文本（不支持 Markdown） |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| filePath        | string   | ❌    | 可选附件（content 成为文件说明） |
| to              | string   | ❌    | 目标 chatId |
| reminderAll     | boolean  | ❌    | @提及所有成员（仅群聊） |
| reminderUserIds | string[] | ❌    | @提及指定用户（仅群聊） |
| reminderBotIds  | string[] | ❌    | @提及指定机器人（仅群聊） |
| refMsgId        | string   | ❌    | 引用回复的消息 ID |

### lansenger_send_format_text

| 参数            | 类型     | 必填 | 说明 |
|-----------------|----------|------|------|
| content         | string   | ✅    | Markdown 文本 |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| to              | string   | ❌    | 目标 chatId |
| reminderAll     | boolean  | ❌    | @提及所有人（仅群聊） |
| reminderUserIds | string[] | ❌    | @提及指定用户（仅群聊） |
| reminderBotIds  | string[] | ❌    | @提及指定机器人（仅群聊） |
| refMsgId        | string   | ❌    | 引用回复的消息 ID |

### lansenger_send_image_url

| 参数     | 类型   | 必填 | 说明 |
|----------|--------|------|------|
| imageUrl | string | ✅    | 可直接访问的图片 URL |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| caption  | string | ❌    | 纯文本说明（不支持 Markdown） |
| to       | string | ❌    | 目标 chatId |

### lansenger_send_link_card

| 参数         | 类型   | 必填 | 说明 |
|--------------|--------|------|------|
| title        | string | ✅    | 卡片标题 |
| link         | string | ✅    | 点击跳转链接 |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| description  | string | ❌    | 卡片描述（API 要求，默认空） |
| iconLink     | string | ❌    | 图标 URL（默认空） |
| pcLink       | string | ❌    | PC 客户端链接 |
| fromName     | string | ❌    | 来源名称（默认空） |
| fromIconLink | string | ❌    | 来源图标 URL（默认空） |
| to           | string | ❌    | 目标 chatId |

### lansenger_send_app_articles

| 参数     | 类型     | 必填 | 说明 |
|----------|----------|------|------|
| articles | object[] | ✅    | 每项：{ imgUrl, title, url, summary?, pcUrl? } |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| to       | string   | ❌    | 目标 chatId |

> ⚠️ 图文项的摘要字段是 `summary`，不是 `description`。`description` 会被 API 静默忽略。

### lansenger_send_app_card

| 参数           | 类型     | 必填 | 说明 |
|----------------|----------|------|------|
| bodyTitle      | string   | ✅    | 卡片标题（支持 div 样式） |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| headTitle      | string   | ❌    | 头部标题 |
| bodySubTitle   | string   | ❌    | 副标题（支持 div 样式） |
| bodyContent    | string   | ❌    | 正文内容（支持 div 样式） |
| signature      | string   | ❌    | 底部签名 |
| isDynamic      | boolean  | ❌    | 启用审批流程（默认 false） |
| headStatusInfo | object   | ❌    | { description, colour } — description：状态文字（支持 div 样式控制颜色，如 `<div style="color:#FFB116">待审批</div>`，最多 30 字节）。colour：圆点颜色（hex，如 #FFB116）。两者是独立的：文字颜色 vs 圆点颜色。 |
| fields         | object[] | ❌    | 键值对（最多 10 个） |
| links          | object[] | ❌    | 链接（最多 3 个）：{ title, url } |
| cardLink       | string   | ❌    | 卡片点击链接 |
| staffId        | string   | ❌    | 员工 openId，用于发送者头像 |
| headIconUrl    | string   | ❌    | 头部图标 URL |
| to             | string   | ❌    | 目标 chatId |

### lansenger_send_approve_card

| 参数       | 类型     | 必填 | 说明 |
|------------|----------|------|------|
| head       | object   | ✅*   | `{ title, iconLink?, iconId?, headStatus?: { describe, statusIcon?, iconLink?, colour } }` — 卡片头部。`headStatus.colour` 是圆点颜色（hex），`describe` 是状态文字。 |
| body       | object   | ✅    | `{ title, content?, subtitle? }` — `content.formatType`: 1=普通文本, 2=Markdown。 |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| buttons    | object[] | ❌    | `[{ text, buttonTheme?: 1\|2\|3\|4, state?: 0\|1\|2, link?, pcLink?, padLink?, callbackInfo?, permissionScope?: { permittedStaffs?, prohibitedStaffs? }, prohibitedState? }]` — 最多 3 个。buttonTheme: 1=primary蓝, 2=次蓝, 3=次黑, 4=警告。state: 0=可用, 1=禁用, 2=隐藏。 |
| reminder   | object   | ❌    | `{ all?, userIds?, botIds? }` — @提及（仅群聊）。提示用户需在消息正文写 `@姓名`。 |
| cardLink   | string   | ❌    | 卡片点击链接。`cardLinkForPc`/`cardLinkForPad` 也可通过同一个字符串传入（需拼接）。 |
| expireTime | integer  | ❌    | 卡片过期时间（秒） |
| to         | string   | ❌    | 目标 chatId |

\* `head` 可选，但通常应提供 `head.title` + `head.headStatus` 以实现状态展示。

### lansenger_update_dynamic_card

| 参数           | 类型     | 必填 | 说明 |
|----------------|----------|------|------|
| msgId          | string   | ✅    | 原始 send_app_card 返回的消息 ID |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| headStatusInfo | object   | ❌    | { description, colour } — description：状态文字（支持 div 样式）。colour：圆点颜色（hex）。相互独立。 |
| links          | object[] | ❌    | 更新后的链接（最多 3 个） |
| isLastUpdate   | boolean  | ❌    | true = 最终状态，卡片变为静态（默认 false） |

### lansenger_revoke_message

| 参数      | 类型     | 必填 | 说明 |
|-----------|----------|------|------|
| messageIds | string[] | ✅    | 要撤回的消息 ID 列表 |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| chatType  | string   | ❌    | bot（默认）或 group |
| senderId  | string   | ❌    | chatType=group 时必填 |

### lansenger_query_groups

查询机器人所在的群列表。返回群 ID 列表。

| 参数       | 类型    | 必填 | 说明 |
|------------|---------|------|------|
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| pageOffset | integer | ❌    | 分页偏移，0-based（默认 0） |
| pageSize   | integer | ❌    | 每页群数（默认 100） |

> ⚠️ 企业部署可能返回 `errCode=10005 'API服务无权限'`，该环境下 `/v2/groups/fetch` 未授权。

### lansenger_group_info

查询指定群的详细信息：名称、头像、简介、群主、成员数、设置等。

| 参数    | 类型   | 必填 | 说明 |
|---------|--------|------|------|
| groupId | string | ✅    | 群 ID |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |

> 当前群的 ID 可从 session metadata 的 `To` 字段获取。

### lansenger_group_members

查询指定群的成员列表。返回成员名称、角色（0=普通成员, 1=助理群主, 2=群主）、头像等。支持分页。

| 参数       | 类型    | 必填 | 说明 |
|------------|---------|------|------|
| groupId    | string  | ✅    | 群 ID |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| pageOffset | integer | ❌    | 分页偏移（默认 0） |
| pageSize   | integer | ❌    | 每页人数。省略则返回全部 |

### lansenger_group_check_membership

检查指定人员（或机器人自身）是否在群中。

| 参数    | 类型   | 必填 | 说明 |
|---------|--------|------|------|
| groupId | string | ✅    | 群 ID |
| appId          | string   | ❌    | 自动从会话注入。仅在覆盖默认账号时传入 |
| staffId | string | ❌    | 员工 ID。省略则检查机器人自身是否在群中 |

## 审批流程模式

### exec 命令审批（自动触发）

非白名单命令自动触发审批，由 OpenClaw 框架驱动，Agent 无需调用工具。审批卡片（approveCard）会自动发送到发起命令的聊天中，包含三个交互式按钮：
- **执行一次** — 仅当次执行
- **本会话有效** — 本次会话内不再审批
- **拒绝执行** — 拒绝该命令

用户可通过点击按钮（需客户端支持）或手输 `/approve <id> allow-once|allow-session|deny` 完成审批。审批后卡片状态自动更新为"已允许执行一次"等，按钮置灰。

> **Agent 无需手动发送审批卡片** — 这是框架自动处理的。Agent 只需要正常执行命令，框架会根据 approvals 配置决定是否触发审批。

### 业务审批（工具调用）

通过 `lansenger_send_app_card` (appCard) + `lansenger_update_dynamic_card` 手动实现审批流程：

1. `lansenger_send_app_card(bodyTitle="...", isDynamic=true, appId="<AppId>", headStatusInfo={description: '<div style="color:#FFB116">待审批</div>', colour: "#FFB116"})`
2. `lansenger_update_dynamic_card(msgId="<步骤1返回的>", appId="<AppId>", headStatusInfo={description: '<div style="color:#198754">已批准</div>', colour: "#198754"}, isLastUpdate=true)`

状态颜色：#FFB116（待审批）、#198754（已批准）、#dc3545（已拒绝）

## @提及规则

1. **不要在消息文本中手动写 "@姓名"** — 蓝信 API 会根据 `reminderUserIds` / `reminderBotIds` / `reminderAll` 自动在消息前拼接对方的名字，无需 Agent 显式写入。
2. **reminder 控制推送通知** — 当你希望某人收到推送通知时，通过 `reminderUserIds`（员工）或 `reminderBotIds`（机器人）参数指定其 ID。
3. **引用回复** — 使用 `refMsgId` 可以让消息以引用形式回复到指定消息，在群聊中显示更清晰的上下文。

## 入站消息类型

| 类型       | 你会看到的内容 |
|------------|---------------|
| text       | 纯文本内容 |
| formatText | Markdown 文本内容 |
| image      | 本地文件路径（用 read 工具查看） |
| video      | 本地文件路径（视频 + 封面图） |
| file       | 本地文件路径 |
| voice      | 本地文件路径（.amr） |
| position   | 位置名称、地址、经纬度 |
| card       | 联系人卡片（含 staffId） |
| sticker    | 贴纸/表情消息 |

## 文件发送：MEDIA: 标签 vs message 工具

OpenClaw 的 `MEDIA:` 标签机制有 **MIME 白名单**——只有以下文件类型可以通过 MEDIA: 标签发送：

| MEDIA: 允许的类型              | 示例 |
|-------------------------------|------|
| 图片（image/*）               | .png, .jpg, .gif, .bmp, .webp, .svg |
| 音频（audio/*）               | .mp3, .wav, .ogg, .m4a |
| 视频（video/*）               | .mp4, .mov, .avi, .mkv |
| PDF                           | .pdf |
| Office 文档                   | .doc, .xls, .ppt, .docx, .xlsx, .pptx |
| 压缩包                        | .zip, .gzip, .7z, .tar |
| CSV                           | .csv |
| Markdown                      | .md |

**所有其他文件类型被 MEDIA: 标签阻止**，回复中会显示"⚠️ Media failed."。具体包括：

| MEDIA: 阻止的类型 | 示例 |
|-------------------|------|
| 纯文本            | .txt |
| JSON              | .json |
| 代码/配置         | .py, .js, .ts, .yaml, .xml, .toml, .ini, .cfg, .conf |
| 数据文件          | .db, .sql, .parquet |
| 可执行文件        | .exe, .sh, .bat |
| 其他二进制        | .bin, .dat, .so, .dll |

**要发送被阻止的文件类型，使用 `message(action=send, filePath=<path>)`**——它绕过 MEDIA 白名单，直接通过蓝信 API 上传任意文件类型。你也可以将文件重命名为 `.md`（把内容包裹在 Markdown 代码块中）使其兼容 MEDIA。

## 常见陷阱

| 陷阱 | 修复方法 |
|------|----------|
| 在 text 工具中使用原始 Markdown | 绝对不要这样做——会显示为丑陋源代码。正常写 Markdown 即可。 |
| AppArticles 用了 `description` 字段 | 使用 `summary`，不是 `description`。`description` 会被 API 静默忽略。 |
| AppCard `font-size: px` | 使用 `pt` 单位（12pt–36pt）。px 会导致 API "invalid bodyContent" 错误。 |
| AppCard `text-indent: 0` | 使用 `0em` 带单位。裸 `0` 会导致静默失败。 |
| headStatusInfo div 包裹混乱 | description 支持 div 样式控制颜色。colour 是圆点颜色。两者独立。 |
| 消息过长 | ~4000 字符限制。分多条发送。 |
| 视频缺少封面或元数据 | **API 要求：** 1) `coverImagePath`（封面/缩略图）— mediaIds 必须为 `[videoId, coverId]`；2) `videoWidth` + `videoHeight` + `videoDuration` — 上传 API 需要这些参数。发送视频前必须：提取封面帧（`ffmpeg -i video.mp4 -vframes 1 -q:v 2 cover.jpg`）并探测元数据（`ffprobe`）。将四个参数全部填入工具参数。 |
| 工具不可用 | 工具内置于频道插件中，默认自动可用。如果不显示，检查 `openclaw.json` 中 `tools.allow` 是否配置了限制性列表（如 `["read", "write"]`）但漏掉了插件工具。修复：添加 `"tools": { "alsoAllow": ["group:plugins"] }`。CLI 备选：`pipx install lansenger-cli`。 |
| 漏掉 appId 参数 | `appId` 已自动从当前会话注入，无需传入。仅当需要指定不同账号时才需显式传 `appId`。 |
