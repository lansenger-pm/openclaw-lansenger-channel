---
name: lansenger-messaging
description: How to communicate on Lansenger (蓝信) — send rich content via message tool, agent tools, CLI, approvals, and pitfalls
metadata: {"openclaw":{"requires":{"config":["channels.lansenger"],"cli":["lansenger"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) 消息发送 — Agent 速查手册

在蓝信会话中，**直接正常写回复即可**——Markdown 会自动渲染为 formatText。不需要额外工具，除非你需要 @提及。

你可以通过 **CLI 命令**（备选）或 **Agent 工具**（内置）发送消息：

- **Agent 工具**（主要方式）：`lansenger_send_file`、`lansenger_send_text` 等——内置在频道插件中，频道配置并运行后始终可用。
- **CLI 命令**（备选方式）：`lansenger message send-file`、`lansenger message send-text` 等——通过 bash 执行。需先安装：`pipx install lansenger-cli` 或 `pip install lansenger-cli`。

> 💡 **CLI 是可选的备选方案**：`pipx install lansenger-cli`（或 `pip install lansenger-cli`）。Agent 工具内置于频道插件，频道运行后即可用。

注意，Markdown 和文件附件**互斥**。如果你同时需要格式化和文件，先发送 Markdown 回复，再单独调用 `lansenger_send_file` 或 `lansenger message send-file`。

**绝对不要在 lansenger_send_text / send-text 中放原始 Markdown**——会显示为丑陋的源代码。

## CLI 凭证同步

Lansenger-CLI 通过全局 `-P <profile>` 参数支持**多凭证配置**。profile 名称就是 App ID。在调用任何 CLI 命令前，必须确保当前 appId 的凭证在 CLI 配置存储中可用。

**每次 CLI 调用必须包含 `-P <appId>`**（放在 `lansenger` 之后、子命令组之前），其中 `<appId>` 是当前会话的蓝信 App ID。这确保 CLI 使用正确的机器人凭证。

### 首次 CLI 调用前 — 同步凭证

在会话中首次使用 CLI 命令前，**执行一次**以下检查和同步流程：

```bash
# 步骤 1：检查 profile 是否已存在
lansenger -P <appId> config show

# 步骤 2：如果 profile 已存在（显示配置信息），原样复用。
#          不要修改已有 profile —— 其他 Agent 或脚本可能依赖它。

# 步骤 3：仅当 profile 不存在（返回错误 / "not configured"）时，创建新 profile：
lansenger -P <appId> config set app_id <appId>
lansenger -P <appId> config set app_secret <appSecret>
lansenger -P <appId> config set api_gateway_url <apiGatewayUrl>
lansenger -P <appId> config set passport_url <passportUrl>            # 可选
```

**重要 — SDK/CLI 凭证安全**：绝对不要修改或覆盖已有的 `lansenger` CLI/SDK profile。`~/.lansenger/sdk_state.json` 中的 profile 可能被其他 Agent 或自动化脚本使用。修改已有 profile 的凭证会导致这些 Agent 静默故障。始终先用 `lansenger -P <appId> config show` 检查：
- **profile 已存在** → 原样复用。不要执行任何 `config set` 命令。
- **profile 不存在** → 用当前凭证创建新 profile。

`<appId>`、`<appSecret>`、`<apiGatewayUrl>` 和 `<passportUrl>` 的值来自 OpenClaw 配置：
- 单账号：`channels.lansenger.appId`、`channels.lansenger.appSecret`、`channels.lansenger.apiGatewayUrl`
- 多账号：`channels.lansenger.accounts.<key>.appId`、`.appSecret`、`.apiGatewayUrl`
- 环境变量：`LANSENGER_APP_ID`、`LANSENGER_APP_SECRET`、`LANSENGER_API_GATEWAY_URL`

### 验证同步是否成功

```bash
lansenger -P <appId> config show
# 应显示 "Credentials configured: True"
```

### 列出所有已有 profile

```bash
lansenger config list-profiles
```

### 管理 profile

```bash
lansenger config show                       # 查看当前（默认）profile
lansenger -P <appId> config show            # 查看指定 profile
lansenger config list-profiles              # 列出所有 profile

# ⚠️ 永远不要删除 profile —— 它们可能被其他 Agent 使用。
# 只有用户自己才能决定清除凭证。
```

> **提示**：同步一次后，profile 持久化在 `~/.lansenger/sdk_state.json` 中。只有凭证变更或新增机器人时才需要重新同步。

## 快速决策：该用什么工具/命令？

需要发送内容？按以下决策树选择：

1. 带格式的普通回复 → 直接写。不需要工具。
2. Markdown + @提及 → `lansenger_send_format_text` 或 `lansenger message send-markdown`
3. 纯文本 + @提及 + 文件 → `lansenger_send_text` 或 `lansenger message send-text`
4. 发送文件 → **`message(action=send, filePath=<path>)`**（始终可用，无需额外权限，任意文件类型）或 `lansenger_send_file` 或 `lansenger message send-file`
5. 发送图片 URL → `lansenger_send_image_url` 或 `lansenger message send-image-url`
6. 链接卡片 → `lansenger_send_link_card` 或 `lansenger message send-link-card`
7. 图文消息 → `lansenger_send_app_articles` 或 `lansenger message send-app-articles`
8. 富文本卡片 → `lansenger_send_app_card` 或 `lansenger message send-app-card`
9. 审批流程 → sendAppCard(isDynamic=true) → updateDynamicCard
10. 撤回消息 → `lansenger_revoke_message` 或 `lansenger message revoke`
11. 查找群 ID → `lansenger_query_groups` 或 `lansenger message query-groups`

## 消息类型能力矩阵

| 类型       | Markdown | @提及          | 附件 |
|------------|----------|----------------|------|
| formatText | ✓ (自动) | ✓ (reminder)   | ✗    |
| text       | ✗        | ✓              | ✓    |

- **formatText**：Markdown 渲染，通过 reminder 参数支持 @提及（API 拒绝时自动回退）。不支持文件附件。
- **text**：纯文本。支持 @提及 + 文件附件。不支持 Markdown 渲染。
- 这两种类型**互斥**——根据需求选择一种。

## Agent 工具参考

所有工具均接受可选的 `to`（chatId）。留空则自动检测当前会话。仅在不同会话时才需填写。chatId 区分大小写——不要截断或修改。

### lansenger_send_file

| 参数           | 类型     | 必填 | 说明 |
|----------------|----------|------|------|
| filePath       | string   | ✅    | 绝对本地路径（workspace、/tmp、Desktop 等） |
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
| to              | string   | ❌    | 目标 chatId |
| reminderAll     | boolean  | ❌    | @提及所有人（仅群聊） |
| reminderUserIds | string[] | ❌    | @提及指定用户（仅群聊） |
| reminderBotIds  | string[] | ❌    | @提及指定机器人（仅群聊） |
| refMsgId        | string   | ❌    | 引用回复的消息 ID |

### lansenger_send_image_url

| 参数     | 类型   | 必填 | 说明 |
|----------|--------|------|------|
| imageUrl | string | ✅    | 可直接访问的图片 URL |
| caption  | string | ❌    | 纯文本说明（不支持 Markdown） |
| to       | string | ❌    | 目标 chatId |

### lansenger_send_link_card

| 参数         | 类型   | 必填 | 说明 |
|--------------|--------|------|------|
| title        | string | ✅    | 卡片标题 |
| link         | string | ✅    | 点击跳转链接 |
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
| to       | string   | ❌    | 目标 chatId |

> ⚠️ 图文项的摘要字段是 `summary`，不是 `description`。`description` 会被 API 静默忽略。

### lansenger_send_app_card

| 参数           | 类型     | 必填 | 说明 |
|----------------|----------|------|------|
| bodyTitle      | string   | ✅    | 卡片标题（支持 div 样式） |
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

### lansenger_update_dynamic_card

| 参数           | 类型     | 必填 | 说明 |
|----------------|----------|------|------|
| msgId          | string   | ✅    | 原始 send_app_card 返回的消息 ID |
| headStatusInfo | object   | ❌    | { description, colour } — description：状态文字（支持 div 样式）。colour：圆点颜色（hex）。相互独立。 |
| links          | object[] | ❌    | 更新后的链接（最多 3 个） |
| isLastUpdate   | boolean  | ❌    | true = 最终状态，卡片变为静态（默认 false） |

### lansenger_revoke_message

| 参数      | 类型     | 必填 | 说明 |
|-----------|----------|------|------|
| messageIds | string[] | ✅    | 要撤回的消息 ID 列表 |
| chatType  | string   | ❌    | bot（默认）或 group |
| senderId  | string   | ❌    | chatType=group 时必填 |

### lansenger_query_groups

| 参数       | 类型    | 必填 | 说明 |
|------------|---------|------|------|
| pageOffset | integer | ❌    | 页码（默认 1） |
| pageSize   | integer | ❌    | 每页群数（默认 100） |

## CLI 命令参考

所有命令格式为 `lansenger <group> <subcommand>`。chatId 区分大小写。

**每次 CLI 命令必须包含 `-P <appId>`**（全局参数，放在 `lansenger` 之后、子命令之前）以选择正确的凭证 profile。参见上方 [CLI 凭证同步](#cli-凭证同步) 了解如何确保 profile 存在。

### lansenger message send-text

```bash
lansenger -P <appId> message send-text <chat_id> <content> [--file <path>] [--mention-all] [--mention <uid1> [--mention <uid2>]]
```

### lansenger message send-markdown

```bash
lansenger -P <appId> message send-markdown <chat_id> <content> [--mention-all] [--mention <uid>]
```

### lansenger message send-file

```bash
lansenger -P <appId> message send-file <chat_id> <file_path> [--caption <text>] [--media-type <1|2|3>]
```

### lansenger message send-image-url

```bash
lansenger -P <appId> message send-image-url <chat_id> <image_url> [--caption <text>]
```

### lansenger message send-link-card

```bash
lansenger -P <appId> message send-link-card <chat_id> <title> <link> [--desc <text>] [--icon <url>] [--pc-link <url>] [--from-name <name>] [--from-icon <url>]
```

### lansenger message send-app-articles

```bash
lansenger -P <appId> message send-app-articles <chat_id> '{"title":"T","url":"U","imgUrl":"I","summary":"S"}' '{"title":"T2","url":"U2"}'
```

> ⚠️ 图文项字段是 `summary`，不是 `description`。`description` 会被 API 静默忽略。

### lansenger message send-app-card

```bash
lansenger -P <appId> message send-app-card <chat_id> <body_title> [--head-title <t>] [--sub-title <t>] [--content <t>] [--signature <t>] [--card-link <url>] [--dynamic] [--staff-id <id>] [--head-icon <url>] [--status-desc <div>] [--status-colour <hex>] [--field <json>] [--link <json>]
```

**headStatusInfo**：`--status-desc` = 状态文字（支持 div 样式控制颜色），`--status-colour` = 圆点颜色（hex）。两者是独立的：文字颜色 vs 圆点颜色。

### lansenger message update-dynamic-card

```bash
lansenger -P <appId> message update-dynamic-card <msg_id> [--last] [--status-desc <div>] [--status-colour <hex>] [--link <json>]
```

### lansenger message revoke

```bash
lansenger -P <appId> message revoke <msg_id1> <msg_id2> [--chat-type bot|group] [--sender-id <id>]
```

### lansenger message query-groups

```bash
lansenger -P <appId> message query-groups [--page <n>] [--size <n>]
```

## 审批流程模式

**通过工具：**
1. `lansenger_send_app_card(bodyTitle="...", isDynamic=true, headStatusInfo={description: '<div style="color:#FFB116">待审批</div>', colour: "#FFB116"})`
2. `lansenger_update_dynamic_card(msgId="<步骤1返回的>", headStatusInfo={description: '<div style="color:#198754">已批准</div>', colour: "#198754"}, isLastUpdate=true)`

**通过 CLI：**
```bash
lansenger -P <appId> message send-app-card <chat_id> "审批" --dynamic --status-desc '<div style="color:#FFB116">待审批</div>' --status-colour "#FFB116"
lansenger -P <appId> message update-dynamic-card <msg_id> --last --status-desc '<div style="color:#198754">已批准</div>' --status-colour "#198754"
```

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
| 在 text 工具/CLI 中使用原始 Markdown | 绝对不要这样做——会显示为丑陋源代码。正常写 Markdown 即可。 |
| AppArticles 用了 `description` 字段 | 使用 `summary`，不是 `description`。`description` 会被 API 静默忽略。 |
| AppCard `font-size: px` | 使用 `pt` 单位（12pt–36pt）。px 会导致 API "invalid bodyContent" 错误。 |
| AppCard `text-indent: 0` | 使用 `0em` 带单位。裸 `0` 会导致静默失败。 |
| headStatusInfo div 包裹混乱 | description 支持 div 样式控制颜色。colour 是圆点颜色。两者独立。 |
| 消息过长 | ~4000 字符限制。分多条发送。 |
| 视频缺少封面或元数据 | **API 要求：** 1) `coverImagePath`（封面/缩略图）— mediaIds 必须为 `[videoId, coverId]`；2) `videoWidth` + `videoHeight` + `videoDuration` — 上传 API 需要这些参数。发送视频前必须：提取封面帧（`ffmpeg -i video.mp4 -vframes 1 -q:v 2 cover.jpg`）并探测元数据（`ffprobe`）。将四个参数全部填入工具参数。 |
| 工具不可用 | 工具内置于频道插件中。如果不可用，使用 `message(action=send, filePath=...)` 发送文件（不需要 `group:plugins`）。最后手段，使用 CLI：`pipx install lansenger-cli`，然后 `lansenger message send-text <chatId> <content>`。 |
| CLI 命令未找到 | 安装：`pipx install lansenger-cli` 或 `pip install lansenger-cli`。然后验证：`lansenger --help`。 |
| CLI 凭证错误 / 以错误的机器人身份发送 | **始终使用 `-P <appId>`**（全局参数放在 `lansenger` 之后）。不加则 CLI 使用 `default` profile，可能是别的机器人。先同步：`lansenger -P <appId> config show` → 如果不存在则创建新 profile。**绝对不要覆盖已有 profile。** |
| CLI "Credentials configured: False" | 执行 `lansenger -P <appId> config show` 检查。仅当 profile 不存在时才执行 `lansenger -P <appId> config set app_id <appId>` + `lansenger -P <appId> config set app_secret <appSecret>`。如果 profile 存在但凭证不同，不要修改——可能需用户决定。 |
