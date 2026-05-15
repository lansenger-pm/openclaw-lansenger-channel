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
- **零核心修改** — 纯插件模式，`git diff HEAD` 保持纯净

## 消息类型能力矩阵

| msgType     | Markdown | @提及 | 附件 |
|-------------|----------|-------|------|
| `text`      | ✗        | ✓     | ✓    |
| `formatText`| ✓        | ✓ (reminder) | ✗    |

**默认策略**：优先使用 `formatText` 发送 Markdown 回复。附件使用 `text` 回退。两种类型均支持 @mention（通过 `reminder` 参数）—提及用户时在文本中包含"@姓名"。

## 代理工具 & CLI

消息可以通过**代理工具**、**CLI 命令**或两者发送：

| 方式 | 安装方法 | 使用 |
|------|----------|------|
| 代理工具 | `openclaw plugins install @lansenger-pm/openclaw-lansenger-tools` | `lansenger_send_file`、`lansenger_send_text` 等 |
| CLI 命令 | `pip install lansenger-cli` | `lansenger message send-file`、`lansenger message send-text` 等 |

> ⚠️ **代理工具需要 `lansenger-tools` 插件** — 需单独安装。CLI 命令需要 `lansenger-cli`（Python）。两者均未安装时，代理只能通过普通 Markdown 文本回复。

| 工具 | 说明 |
|------|------|
| `lansenger_send_text` | 发送文本或 formatText 消息（默认 Markdown） |
| `lansenger_send_file` | 发送文件/图片/视频/语音（工作区或外部路径） |
| `lansenger_send_image_url` | 通过 URL 发送图片 |
| `lansenger_send_link_card` | 发送富链接预览卡片 |
| `lansenger_send_app_card` | 发送交互/审批卡片 |
| `lansenger_send_app_articles` | 发送多文章卡片 |
| `lansenger_update_dynamic_card` | 原地更新动态卡片状态 |
| `lansenger_revoke_message` | 撤回已发送的消息 |
| `lansenger_query_groups` | 查询可用群组 |

工具也可通过 CLI 使用：`lansenger message send-text`、`lansenger message send-file` 等。

## 安装与配置

### 推荐安装流程

```bash
# 1. 安装频道插件
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. 安装工具插件或 CLI（至少需要一个来发送消息）
#    方案 A：OpenClaw 代理工具插件
openclaw plugins install @lansenger-pm/openclaw-lansenger-tools
#    方案 B：Python CLI（通过 bash 调用）
pip install lansenger-cli

# 3. 启用插件（如未自动启用）
openclaw config set plugins.entries.lansenger.enabled true
openclaw config set plugins.entries.lansenger-tools.enabled true  # 使用方案 A 时

# 4. 配置频道（交互式向导）
openclaw channels add

# 5. 重启网关
openclaw gateway restart
```

`package.json` 的 `peerDependencies` 在 npm install 时会警告缺失 tools 插件。设置向导也会提醒安装。

> **自定义网关**：企业私有化部署（如奇安信）需在配置后通过 `openclaw.json` 或环境变量设置 `apiGatewayUrl` — 见[可选配置](#可选配置)。

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
| `LANSENGER_APP_SECRET` | 个人机器人 App Secret | `57E718CA1CAC20F2...` |
| `LANSENGER_API_GATEWAY_URL` | 蓝信 API 网关 URL 覆盖 | `https://open.e.lanxin.cn/open/apigw` |

凭证也可通过 `openclaw.json` 配置提供（见下方可选配置）。当两者同时设置时，环境变量优先。

### 获取凭证

**蓝信桌面端** → **通讯录** → **智能机器人** → **个人机器人** → 点击 **ℹ️** 图标

> ⚠️ **移动端不支持查看凭证。** 请仅使用桌面端。

### 可选配置

```json
{
  "channels": {
    "lansenger": {
      "appId": "your-appid",
      "appSecret": "your-secret",
      "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw",
      "homeChannel": "lansenger",
      "enabled": true,
      "allowFrom": ["your-appid"],
      "dmPolicy": "pairing",
      "accounts": {
        "your-appid": {
          "appId": "your-appid",
          "appSecret": "...",
          "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw"
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
| `apiGatewayUrl` | API 网关 URL | `https://open.e.lanxin.cn/open/apigw` |
| `homeChannel` | 代理路由的默认频道 | `lansenger` |
| `enabled` | 启用/禁用频道 | `true` |
| `allowFrom` | 允许私聊的用户 ID | `[]` |
| `dmPolicy` | 私聊策略：`pairing`、`allowlist`、`open`、`disabled` | `pairing` |
| `accounts` | 多机器人配置 | — |
| `groupPolicy` | 群聊策略：`open`（所有群）、`allowlist`（仅允许列表群）、`disabled`（禁止群消息） | `allowlist` |
| `groupAllowFrom` | 允许触发机器人的群 ID | `[]` |
| `groups` | 群级配置（requireMention、enabled、allowFrom） | — |

### 多机器人配置

添加多个机器人时，使用 `openclaw config set` 配置 `accounts` 结构：

```bash
# 添加第二个机器人（替换 appid/appsecret/gateway 为你的值）
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

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
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        },
        "your-appid-1": {
          "appId": "your-appid-1",
          "appSecret": "...",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
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
        peer: { kind: "direct", id: "2285568-xxx" },
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
* `match.peer.id`: 用户 ID（`2285568-xxx`）或群聊 ID

单 Agent 模式下，所有消息自动路由到默认 Agent（`main`），无需 bindings 配置。

### 群聊策略

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

1. 通过蓝信媒体 API 下载所有 `mediaIds`
2. 从 Content-Type/Content-Disposition 头检测文件扩展名（回退：文件魔数）
3. 保存到临时文件，将路径附加到 `InboundEvent.mediaPaths[]`
4. 在代理文本中添加提示："附件已保存到本地 — 使用读取工具查看"

## 审批流程

支持审批卡片：
- 审批请求通过 **appCard**（`isDynamic=true`）发送
- 状态更新（待审批 → 已通过/已拒绝）通过 **DynamicMsg** 原地更新卡片
- 根据用户检测到的语言发送中文或英文卡片
- **i18nAppCard**（5 语言）保留供未来使用，当前不用于审批

## 重要说明

- **无员工聊天概念** — 蓝信只有群聊和私聊（DM），没有"员工聊天"类型。
- **撤回 chatType** — 仅支持 `bot` 和 `group`，没有 `staff` 类型。
- **撤回无 sysMsg** — API 接受 `sysMsg` 但不会显示。
- **无 deleteMessage** — API 返回错误码 10000，删除消息不可用。
- **appArticles** — 使用 `summary` 字段（不是 `description`）。
- **linkCard** — `description`、`iconLink`、`fromName`、`fromIconLink` 为必填字段（可用空字符串作为默认值）。
- **msgTarget 自动路由** — 所有发送方法自动路由，无需单独调用群聊/私聊 API。
- **网关 URL 因环境不同** — 如 `https://apigw.lx.qianxin.com` 用于奇安信部署，`https://open.e.lanxin.cn/open/apigw` 用于标准蓝信。
- **reminder** — formatText 中可选字段；群聊中建议使用。提及用户时在文本中包含"@姓名"。
- **媒体标签** — `<media>` 标签适用于工作区文件；外部路径请使用 `lansenger_send_file`。
- **openclaw skill/message lansenger** — 这些 CLI 命令不存在；请使用代理工具。
- **工具插件** — 代理工具（`lansenger_send_*`）需要单独安装 `@lansenger-pm/openclaw-lansenger-tools` 插件。CLI 命令（`lansenger message send-*`）需要 `pip install lansenger-cli`。至少安装其中一个。

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
│   ├── client.ts       # 蓝信 API 客户端（WS、HTTP、媒体）
│   ├── channel.ts      # OpenClaw 频道插件
│   ├── channel.test.ts # 频道插件测试
│   └── runtime.ts      # 网关运行时（方法、入站处理器）
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # 代理消息策略（工具 + CLI）
├── dist/               # 编译后的 JavaScript
├── index.ts            # 插件入口
├── setup-entry.ts      # 设置向导入口
├── openclaw.plugin.json # 插件元数据与 GUI 配置
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

- **v3.1** — 多账号设置向导；dmPolicy 对齐 OpenClaw 标准（dmSecurity→dmPolicy + paired→pairing）；中英双语提示文案；凭证 shouldPrompt 跳过已配置步骤；多账号配置迁移清理
- **v3.0** — 新增 `lansenger_send_format_text` 工具（Markdown + @提及）；重写 SKILL.md；修正 headStatusInfo description+colour 语义
- **v2.10** — appCard font-size px→pt 自动转换；sendImageUrl 错误分类；工具注册日志
- **v2.9** — 状态适配器；环境变量回退；uiHints 中文标签；README 精简（5 语言）
- **v2.8** — OpenClaw `bindings[]` 多 Agent 路由；groupPolicy/groupAllowFrom/groups 群聊准入；SKILL.md AgentSkills 规范
- **v2.7** — 纯对象工具注册；运行时状态获取 client/target
- **v2.6** — 无条件注册工具；移除幽灵 delete_message
- **v2.5** — formatText reminder；AppArticles `summary`；撤回仅 bot/group
- **v2.4** — 修复消息体组装；appArticles/linkCard 字段修复
- **v2.3** — 移除遗留群聊/私聊发送；全部通过 msgTarget 路由
- **v2.2** — 添加 9 个 agent 工具
- **v2.0** — 初始发布

## 许可证

MIT — 详情见 [LICENSE](LICENSE)。

## 贡献

1. Fork 本仓库
2. 创建功能分支
3. 进行修改
4. 运行测试：`npx vitest run`
5. 提交 Pull Request