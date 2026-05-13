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
- **群消息路由** — 自动检测并路由到群聊/私聊 API
- **@提及** — 支持群聊中 @所有人 和 @指定用户
- **入站媒体处理** — 下载图片/文件/语音，检测文件扩展名，向代理提供文件路径
- **消息撤回** — 撤回已发送的消息
- **自动启动** — 网关启动时自动连接所有已配置的机器人账户
- **零核心修改** — 纯插件模式，`git diff HEAD` 保持纯净

## 消息类型能力矩阵

| msgType     | Markdown | @提及 | 附件 |
|-------------|----------|-------|------|
| `text`      | ✗        | ✓     | ✓    |
| `formatText`| ✓        | ✗     | ✗    |

**默认策略**：优先使用 `formatText` 发送 Markdown 回复。附件使用 `text` 回退。

## 快速安装

### 通过 OpenClaw CLI（推荐）

```bash
# 1. 安装插件
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. 复制到 extensions 目录（因 OpenClaw CLI 发现机制 bug，必须手动复制）
mkdir -p ~/.openclaw/extensions/lansenger
cp -r ~/.openclaw/npm/node_modules/@lansenger-pm/openclaw-lansenger-channel/* \
     ~/.openclaw/extensions/lansenger/

# 3. 重启网关
openclaw gateway restart
```

> ⚠️ 第2步是必需的，因为 `openclaw channels add` 只发现 `extensions/` 目录下的插件，不会扫描 npm 安装的包。这是 [OpenClaw 上游 bug](https://docs.openclaw.ai)，不是插件本身的问题。

### 通过 npm

```bash
npm install -g @lansenger-pm/openclaw-lansenger-channel
openclaw channels add --channel lansenger
```

### 开发安装（本地链接）

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

## 快速配置

安装后，配置凭证：

> **单账号**：`channels add` 仅创建一个账号。如需多个机器人，见下方[多机器人配置](#多机器人配置)。

```bash
# 标准安装（使用默认网关 https://open.e.lanxin.cn/open/apigw）
openclaw channels add --channel Lansenger \
  --app-token "你的-appid" \
  --secret "你的-appsecret"

# 企业私有化部署（自定义网关地址）
openclaw channels add --channel Lansenger \
  --app-token "你的-appid" \
  --secret "你的-appsecret" \
  --base-url "https://apigw.lx.qianxin.com"
```

然后重启：
```bash
openclaw gateway restart
```

获取凭证：**蓝信桌面端** → **通讯录** → **智能机器人** → **个人机器人** → 点击右侧 **ℹ️** 图标（移动端不支持查看凭证）。

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
      "dmSecurity": "paired",
      "accounts": {
        "your-appid": {
          "appId": "your-appid",
          "appSecret": "...",
          "agentId": "main",
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
| `dmSecurity` | 私聊策略：`paired`、`allowlist`、`open` | `paired` |
| `accounts` | 多机器人配置 | — |

### 多机器人配置

> ⚠️ `openclaw channels add` 仅支持单账号，每次执行会**覆盖**之前的账号。添加多个机器人需使用 `openclaw config set` 配置 `accounts` 结构。

通过 `channels add` 添加第一个账号后，用 `openclaw config set` 添加更多机器人：

```bash
# 添加第二个机器人（替换 appid/appsecret/gateway 为你的值）
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

# 将不同机器人绑定到不同代理
openclaw config set channels.lansenger.accounts.your-appid-2.agentId "main"
openclaw config set channels.lansenger.accounts.your-appid-1.agentId "test"

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
      "dmSecurity": "paired",
      "accounts": {
        "your-appid-2": {
          "appId": "your-appid-2",
          "appSecret": "...",
          "agentId": "main",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        },
        "your-appid-1": {
          "appId": "your-appid-1",
          "appSecret": "...",
          "agentId": "test",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        }
      }
    }
  }
}

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
# 或
openclaw gateway call lansenger.status
```

### 绑定机器人至代理（配置方式）

机器人与代理的绑定通过账户配置的 `agentId` 或 OpenClaw `bindings[]` 实现：

```bash
# 按账号设置 agentId（推荐）
openclaw config set channels.lansenger.accounts.your-appid.agentId "main"

# 或通过 OpenClaw bindings[]
openclaw config set bindings '[{"agentId":"main","match":{"channel":"lansenger","peer":{"kind":"direct","id":"your-userid"}}}]'
```

> 多代理路由见[多机器人配置](#多机器人配置)。

## 支持的消息类型

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
| `appArticles` | 多文章卡片（图文卡片） | `sendAppArticles()` | 出站 |
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
│   ├── runtime.ts      # 网关运行时（方法、入站处理器）
│   └── bindings.ts     # 多机器人绑定管理器
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # 代理消息策略
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

在账户配置中设置 `agentId`，或使用 OpenClaw `bindings[]` 配置多代理路由。

### WebSocket 断连

插件内置自动重连（指数退避：2s、5s、10s、30s、60s）和心跳（每 30s ping）。

### formatText vs text

- 使用 `formatText` 发送 Markdown 回复（默认）
- 使用 `text` 发送 @提及或附件
- 两者都需要时，发送两条独立消息

### 动态卡片更新失败

审批状态更新使用 DynamicMsg appCard 格式，`updateCardStatus()` 方法自动处理。

## 许可证

MIT — 详情见 [LICENSE](LICENSE)。

## 贡献

1. Fork 本仓库
2. 创建功能分支
3. 进行修改
4. 运行测试：`npx vitest run`
5. 提交 Pull Request