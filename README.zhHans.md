[English](README.md) | [简体中文](README.zhHans.md) | [繁体中文](README.zhHant.md) | [繁体中文香港](README.zhHantHK.md) | [Français](README.fr.md)

# @lansenger-pm/openclaw-lansenger-channel

> 💠 蓝信 频道插件，用于 OpenClaw — WebSocket 入站，HTTP API 出站。

通过 WebSocket 长连接接收实时消息，通过 HTTP API 发送消息，将 OpenClaw 连接到 蓝信 —— 一个企业即时通讯平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)

## 功能特性

- **实时消息** — 通过 WebSocket 长连接实现
- **多机器人支持** — 将多个蓝信机器人绑定到不同的 OpenClaw 代理
- **Markdown 支持** — 使用 `formatText` 消息类型（默认）
- **文件/图片/语音附件** — 通过 `text` 消息类型上传媒体
- **审批卡片** — 交互式审批流程，支持原地状态更新（待审批 → 已批准/已拒绝）
- **语言检测** — 自动检测用户语言，提供本地化响应
- **msgTarget 自动路由** — 所有发送方法自动路由到群聊或私聊（DM）API；无需单独的群聊/私聊方法
- **@提及** — 支持群聊中 @所有人 和 @指定用户
- **入站媒体处理** — 下载图片/文件/语音，检测文件扩展名，向代理提供文件路径
- **消息撤回** — 撤回已发送的消息（chatType 仅支持 bot 和 group）
- **自动启动** — 网关启动时自动连接所有已配置的机器人账户
- **入站防抖合并** — 利用 OpenClaw 的 `messages.inbound.debounceMs` 配置，合并同一发送者的连续快速消息
- **确认消息** — 在代理处理前发送"收到，正在处理..."确认消息，代理回复后自动撤回，语言自动检测
- **零核心修改** — 纯插件模式，`git diff HEAD` 保持纯净

## 消息类型能力矩阵

| msgType     | Markdown | @提及 | 附件 |
|-------------|----------|-------|------|
| `text`      | ✗        | ✓     | ✓    |
| `formatText`| ✓        | ✓ (reminder) | ✗    |

**默认策略**：优先使用 `formatText` 发送 Markdown 回复。附件使用 `text` 回退。两种类型均支持 @mention（通过 `reminder` 参数）—提及用户时在文本中包含"@姓名"。

## 代理工具 & CLI

代理工具**已内置于此插件** — 频道配置并运行时始终可用。CLI 为可选替代方案，通过 bash 调用。

消息可以通过**代理工具**（内置）或**CLI 命令**（可选替代）发送：

| 方式 | 安装方法 | 使用 |
|------|----------|------|
| **代理工具**（内置） | 已包含在 `@lansenger-pm/openclaw-lansenger-channel` | `lansenger_send_file`、`lansenger_send_text` 等 |
| CLI 命令（可选） | `pipx install lansenger-cli`（`pip install lansenger-cli` 为替代） | `lansenger message send-file`、`lansenger message send-text` 等 |

> **代理工具始终可用** — 频道配置且网关运行时即可使用，无需单独安装插件。CLI 命令为可选替代方案，适合偏好 bash 调用的场景；需安装 `lansenger-cli`（Python）。

| 工具 | 说明 |
|------|------|
| `lansenger_send_text` | 发送纯文本消息，不支持 Markdown |
| `lansenger_send_format_text` | 发送 Markdown 格式文字，支持 @提及 |
| `lansenger_send_file` | 发送文件/图片/视频/语音（工作区或外部路径） |
| `lansenger_send_image_url` | 通过 URL 发送图片 |
| `lansenger_send_link_card` | 发送富链接预览卡片 |
| `lansenger_send_app_card` | 发送交互/审批卡片 |
| `lansenger_send_approve_card` | 发送审批卡片，按钮权限仅审批人可操作 |
| `lansenger_send_app_articles` | 发送多文章卡片 |
| `lansenger_update_dynamic_card` | 原地更新动态卡片状态 |
| `lansenger_revoke_message` | 撤回已发送的消息 |
| `lansenger_query_groups` | 查询可用群组 |
| `lansenger_group_info` | 查询群组详情（名称、头像、群主等） |
| `lansenger_group_members` | 查询群成员列表（姓名、角色、头像） |
| `lansenger_group_check_membership` | 检查用户或机器人是否在群中 |
| `lansenger_download_media` | 通过 mediaId 重新下载消息中的文件 |

工具也可通过 CLI 使用：`lansenger message send-text`、`lansenger message send-file` 等。

## 安装与配置

### 推荐安装流程

```bash
# 1. 安装频道插件（包含代理工具）
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. 启用插件（如未自动启用）
openclaw config set plugins.entries.lansenger.enabled true

# 3. 配置频道（交互式向导）
openclaw channels add

# 4. 重启网关
openclaw gateway restart
```

> **可选**：安装 `lansenger-cli` 作为 CLI 替代方案：`pipx install lansenger-cli`。

> **API 网关地址必填**：必须通过 `openclaw.json` 配置或环境变量提供企业网关地址（如 `https://your-api-gateway.example.com`）— 见[配置说明](#配置说明)。

### 开发安装（本地链接）

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

### 获取凭证

**蓝信桌面端** → **通讯录** → **智能机器人** → **个人机器人** → 点击 **ℹ️** 图标

> ⚠️ **移动端不支持查看凭证。** 请仅使用桌面端。

### 首次消息

重启后机器人自动通过 WebSocket 连接。给机器人发私聊消息，会收到配对码，审批配对：

```bash
openclaw pairing approve lansenger <配对码>
```

## 配置

### 必需环境变量

将以下内容添加到 `~/.openclaw/.env` 或环境变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| `LANSENGER_APP_ID` | 个人机器人 App ID | `your-appid` |
| `LANSENGER_APP_SECRET` | 个人机器人 App Secret | `ABCDEF123456...` |
| `LANSENGER_API_GATEWAY_URL` | 蓝信 API 网关 URL（必填） | — |

配置也可通过 `openclaw.json` 提供（见下方配置说明）。配置值优先；环境变量仅在配置未设置时作为回退。`apiGatewayUrl` 为必填项，无默认值。

> ⚠️ **安全：将 appSecret 迁移至 SecretRef 存储**
>
> 自 v3.12.1 起，蓝信频道插件支持 OpenClaw SecretRef 存储 `appSecret`。如果 `appSecret` 以明文存储在 `openclaw.json` 中，任何读取配置的工作区工具都能看到它。请运行以下命令迁移：
>
> ```
> openclaw secrets configure
> ```
>
> 选择 `channels.lansenger.accounts.*.appSecret` 字段将其转换为 SecretRef。迁移后，配置中将包含 `__OPENCLAW_SECRET__({ref_id})` 而非原始密钥值，实际值存储在系统凭证库中。

### 获取凭证

**蓝信桌面端** → **通讯录** → **智能机器人** → **个人机器人** → 点击 **ℹ️** 图标

> ⚠️ **移动端不支持查看凭证。** 请仅使用桌面端。

### 配置说明

```json
{
  "channels": {
    "lansenger": {
      "appId": "your-appid",
      "appSecret": "your-secret",
      "apiGatewayUrl": "https://your-api-gateway.example.com",
      "homeChannel": "xxx-xxx",
      "enabled": true,
      "allowFrom": ["your-appid"],
      "dmPolicy": "pairing",
      "accounts": {
        "your-appid": {
          "appId": "your-appid",
          "appSecret": "...",
          "apiGatewayUrl": "https://your-api-gateway.example.com"
        }
      }
    }
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `appId` | 个人机器人 App ID | — |
| `appSecret` | 个人机器人 App Secret | — |
| `apiGatewayUrl` | API 网关 URL（必填） | — |
| `homeChannel` | 定时任务/通知送达的默认聊天 ID | — |
| `enabled` | 启用/禁用频道（运行时默认：无凭证时为 false） | `true` |
| `allowFrom` | 允许私聊的用户 ID | `[]` |
| `dmPolicy` | 私聊策略：`pairing`、`allowlist`、`open`、`disabled` | `pairing` |
| `configWrites` | 允许蓝信响应频道事件写入配置 | `true` |
| `name` | 此账户的显示名称 | — |
| `accounts` | 多机器人配置 | — |
| `groupPolicy` | 群聊策略：`open`（所有群）、`allowlist`（仅允许列表群）、`disabled`（禁止群消息） | `open` |
| `groupAllowFrom` | 群聊中允许触发的用户 ID（非群 ID）。蓝信用户 ID 和群 ID 格式相同，请从 API 或日志确认。 | `[]` |
| `groups` | 群级配置：`enabled`、`requireMention`、`autoMentionReply`、`autoQuoteReply`、`allowFrom`。key 为群 `chatId`。allowlist 模式设 `groups.<chatId>.enabled: true`。 | — |
| `autoMentionReply` | 群聊回复时自动 @发送者 | `false` |
| `autoQuoteReply` | 回复时自动引用入站消息（群聊和私聊） | `false` |
| `ackMessage` | 在代理处理前发送确认消息 | `true` |
| `revokeAckMessage` | 代理回复送达后自动撤回确认消息。设为 `false` 则保留确认消息可见（有些用户宁愿看到确认消息也不愿看到撤回的系统通知） | `false` |
| `mediaLocalRoots` | 通过媒体发送本地文件时允许的根目录列表；空数组默认为工作区 + `/tmp` | `[cwd, /tmp]` |
| `ackMessageTextZh` | 中文确认消息文案 | `收到，正在处理...` |
| `ackMessageTextEn` | 英文确认消息文案 | `Received, processing...` |
| `requireMention` | 群聊中是否需要 @机器人才会触发。设为 `false` 则任何消息都会触发。 | `true` |
| `dangerouslyAllowPrivateNetwork` | 允许 `sendImageUrl` 从内网地址获取图片（RFC1918、链路本地、metadata IP）。默认禁用以防止 SSRF 攻击。 | `false` |

### 入站防抖合并（消息合并）

当用户连续发送多条消息时，OpenClaw 的防抖机制可以将它们合并为一次代理对话。在 `openclaw.json` 中配置：

```json
{
  "messages": {
    "inbound": {
      "debounceMs": 3000,
      "byChannel": { "lansenger": 3000 }
    }
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `messages.inbound.debounceMs` | 全局防抖窗口（毫秒）；同一发送者在窗口内的连续消息会被合并 | `0`（禁用） |
| `messages.inbound.byChannel.lansenger` | 蓝信频道专属覆盖（优先级高于全局） | — |
| `messages.queue.mode` | 代理正在处理时的队列模式：`steer`、`followup`、`collect`、`queue`、`interrupt` | `steer`（推荐） |

- 媒体消息和控制命令不走防抖，立即处理
- 防抖生效时，合并消息的文本用 `\n` 拼接；媒体路径合并；使用最后一条消息的元数据

### 多机器人配置

添加多个机器人时，使用 `openclaw config set` 配置 `accounts` 结构：

```bash
# 添加第二个机器人（替换 appid/appsecret/gateway 为你的值）
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://your-api-gateway.example.com"

# 重启生效
openclaw gateway restart
```

最终配置结构：

```json
{
  "channels": {
    "lansenger": {
      "appId": "your-appid-2",
      "appSecret": "...",
      "dmPolicy": "pairing",
      "accounts": {
        "your-appid-2": {
          "appId": "your-appid-2",
          "appSecret": "...",
          "apiGatewayUrl": "https://your-api-gateway.example.com"
        },
        "your-appid-1": {
          "appId": "your-appid-1",
          "appSecret": "...",
          "apiGatewayUrl": "https://your-api-gateway.example.com"
        }
      }
    }
  }
}
```

## 使用

网关启动时自动连接所有已配置的账户。`lansenger.start` 方法可用于动态启动额外账户。

### 启动网关（动态）

```bash
openclaw gateway call lansenger.start
```

### 停止网关

```bash
openclaw gateway call lansenger.stop
```

### 查看状态

```bash
openclaw channels status
# 含健康探测（显示 "configured" 和 "works"）：
openclaw channels status --probe
```

### 多 Agent 路由

使用 `bindings` 将蓝信私聊或群聊路由到不同的 Agent（与飞书/WhatsApp 等相同模式）：

```json5
{
  agents: {
    list: [
      { id: "main" },
      { id: "agent-a", workspace: "/home/user/agent-a" },
    ],
  },
  bindings: [
    {
      agentId: "agent-a",
      match: {
        channel: "lansenger",
        peer: { kind: "direct", id: "xxx-xxx" },
      },
    },
    {
      agentId: "agent-a",
      match: {
        channel: "lansenger",
        peer: { kind: "group", id: "group-chat-id" },
      },
    },
  ],
}
```

路由字段：
* `match.channel`: `"lansenger"`
* `match.peer.kind`: `"direct"`（私聊）或 `"group"`（群聊）
* `match.peer.id`: 用户 ID（`xxx-xxx`）或群聊 ID

单 Agent 模式下，所有消息自动路由到默认 Agent（`main`），无需 bindings 配置。

### 支持的消息类型

| 类型 | 说明 | API 方法 | 方向 |
|------|------|----------|------|
| `text` | 纯文本，支持可选 @提及和附件 | `sendText()` | 出站 |
| `formatText` | Markdown 格式文本（默认） | `sendFormatText()` | 出站 |
| `image` | 图片，支持可选说明 | `sendFile()` | 出站 |
| `file` | 任意文件附件 | `sendFile()` | 出站 |
| `video` | 视频附件 | `sendFile()` | 出站 |
| `voice` | 语音消息 | `sendFile()` | 出站 |
| `linkCard` | 富链接预览卡片 | `sendLinkCard()` | 出站 |
| `i18nAppCard` | 保留供未来使用；5 语言卡片 | `sendI18nAppCard()` | 出站 |
| `appCard` | 审批卡片（支持状态更新） | `sendAppCard()` | 出站 |
| `appArticles` | 多文章卡片（字段为 `summary`，不是 `description`） | `sendAppArticles()` | 出站 |
| `position` | 位置/定位消息 | — | 仅入站 |
| `card` | 通用卡片消息 | — | 仅入站 |
| `sticker` | 贴纸/表情消息 | — | 仅入站 |

## 入站媒体处理

当用户发送图片、视频、文件或语音消息时，插件会：

1. 通过蓝信媒体 API 下载所有 `mediaIds`（视频：第一个以视频类型下载，第二个以图片类型下载作为封面）
2. 从 Content-Type/Content-Disposition 头检测文件扩展名（回退：文件魔数）
3. 保存到临时文件，将路径附加到 `InboundEvent.mediaPaths[]`
4. 在代理文本中添加提示："附件已保存到本地 — 使用读取工具查看"

## 审批流程

支持审批卡片：
- 审批请求通过 **appCard**（`isDynamic=true`）发送
- 状态更新（待审批 → 已通过/已拒绝）通过 **DynamicMsg** 原地更新卡片
- 根据用户检测到的语言发送中文或英文卡片
- **i18nAppCard**（5 语言）保留供未来使用，当前不用于审批

### 谁能审批？

审批卡片的按钮通过 `permissionScope.permittedStaffs` 控制权限，仅授权审批人可点击按钮，其他人看到的是禁用状态。

**审批人解析优先级：**
1. `commands.ownerAllowFrom` — 显式配置的审批人 ID
2. `account.allowFrom` — 私聊白名单用户 ID
3. `account.homeChannel` — 机器人主人（从第一条私聊自动检测）

如果以上都未配置，无人可通过按钮审批。任何情况下均可通过文本命令审批：
- `/approve <id> allow-once` — 执行一次
- `/approve <id> allow-session` — 本会话有效
- `/approve <id> deny` — 拒绝执行

### 配置方法

显式指定审批人：
```bash
openclaw config set commands.ownerAllowFrom '["lansenger:用户ID-1", "lansenger:用户ID-2"]'
```

或依赖自动检测的机器人主人（`homeChannel`），首次私聊后自动设置。

## 重要说明

- **无员工聊天概念** — 蓝信只有群聊和私聊（DM），没有"员工聊天"类型。
- **撤回 chatType** — 仅支持 `bot` 和 `group`，没有 `staff` 类型。
- **撤回无 sysMsg** — API 接受 `sysMsg` 但不会显示。
- **无 deleteMessage** — API 返回错误码 10000，删除消息不可用。
- **appArticles** — 使用 `summary` 字段（不是 `description`）。
- **linkCard** — `description`、`iconLink`、`fromName`、`fromIconLink` 为必填字段（可用空字符串作为默认值）。
- **msgTarget 自动路由** — 所有发送方法自动路由，无需单独调用群聊/私聊 API。
- **网关 URL 为必填项** — 您必须提供企业网关地址（如 `https://your-api-gateway.example.com`），无默认值。
- **reminder** — formatText 中可选字段；群聊中建议使用。提及用户时在文本中包含"@姓名"。
- **媒体标签** — `<media>` 标签适用于工作区文件；外部路径请使用 `lansenger_send_file`。
- **openclaw skill/message lansenger** — 这些 CLI 命令不存在；请使用代理工具。
- **lansenger-setup 技能自动复制** — 插件在启动时将 `lansenger-setup` 技能复制到 `~/.openclaw/skills/`，以便在频道完全激活之前就能帮助配置蓝信。这是有意设计，请勿手动删除。
- **代理工具** — 代理工具（`lansenger_send_*`）需要工具插件且网关注入成功 — 若工具不可用，请使用 CLI 作为备选。CLI 命令（`lansenger message send-*`）需要 `pipx install lansenger-cli`。
- **alsoAllow** — 本插件注册了 agent 工具（`lansenger_send_*`），但在严格工具策略下可能**不可见**。需在 `openclaw.json` 中添加 `"tools": { "alsoAllow": ["group:plugins"] }` 以确保 agent 能看到并使用这些工具。否则工具可能静默不出现在 agent 工具列表中。

## 开发

### 构建

```bash
npm install
npx tsc
```

### 测试

```bash
npx vitest run
```

### 类型检查

```bash
npx tsc --noEmit
```

### 项目结构

```
openclaw-lansenger-channel/
├── src/
│   ├── client.ts          # 蓝信 API 客户端（WS、HTTP、媒体）
│   ├── channel.ts         # OpenClaw 频道插件
│   ├── runtime.ts         # 网关运行时（入站处理、投递）
│   ├── tools.ts           # 代理工具定义（lansenger_send_*）
│   ├── persistent-store.ts # 磁盘状态持久化
│   ├── setup-wizard.ts    # 设置向导（多账号配置迁移）
│   ├── setup-i18n.ts      # 设置向导多语言
│   ├── *.test.ts          # 单元测试
├── skills/
│   ├── lansenger-messaging/
│   │   └── SKILL.md       # 代理消息策略（工具 + CLI）
│   └── lansenger-setup/
│       └── SKILL.md       # 安装助手（自动复制至 ~/.openclaw/skills）
├── dist/                  # 编译后的 JavaScript
├── index.ts               # 插件入口（registerFull、ensureSetupSkill）
├── setup-entry.ts         # 设置向导入口
├── openclaw.plugin.json   # 插件元数据与 GUI 配置
├── CHANGELOG.md
├── VERSION
├── vitest.config.ts
├── package.json
└── tsconfig.json
```

## 故障排除

### "移动端不支持查看凭证"

请仅使用**蓝信桌面端**。移动端应用不显示机器人凭证。

### "No binding for botId"

Agent 路由由 OpenClaw 的 `bindings[]` 配置管理——见[多 Agent 路由](#多-agent-路由)。单 Agent 模式下无需 bindings，消息自动路由到默认 Agent。

### WebSocket 断连

插件内置自动重连（指数退避：2s、5s、10s、30s、60s）和心跳（每 30s ping）。

### formatText vs text

- 使用 `formatText` 发送 Markdown 回复（默认）
- 使用 `text` 发送附件（无 Markdown）
- 两种类型均支持 @mention（通过 `reminder`）—提及时在文本中包含"@姓名"
- 需要 Markdown 和附件时，发送两条独立消息

### 动态卡片更新失败

审批状态更新使用 DynamicMsg appCard 格式，`updateCardStatus()` 方法自动处理。

## 更新日志

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT — 详情见 [LICENSE](LICENSE)。

## 贡献

1. Fork 本仓库
2. 创建功能分支
3. 进行修改
4. 运行测试：`npx vitest run`
5. 提交 Pull Request