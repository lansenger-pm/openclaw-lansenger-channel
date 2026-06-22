---
name: lansenger-setup
description: Guide for first-time Lansenger (蓝信) bot credential binding, DM pairing, and comprehensive channel configuration — for scenarios where the user cannot access the OpenClaw command line (e.g. Docker deployment). Use this skill when the user wants to set up or reconfigure Lansenger from scratch via conversation.
metadata: {"openclaw":{"requires":{"cli":["openclaw"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) 配置指南

本技能覆盖蓝信机器人接入 OpenClaw 的完整流程。适用于用户**无法直接操作命令行**的场景（如 Docker 部署），Agent 充当配置向导，收集用户提供的凭证并代为执行 CLI 命令。

## 何时使用此技能

- 用户说"配置蓝信"、"绑定蓝信机器人"、"连接蓝信"等。
- 蓝信频道尚未配置（`channels.lansenger` 中没有 `appId`/`appSecret`）。
- 用户想要调整特定频道设置（私聊策略、群聊策略、确认消息等）。
- 用户在 Docker/容器环境中，无法自行执行 CLI 命令。

## 前提条件

- 用户必须有一个已创建好的蓝信**个人机器人**。
- 用户必须能访问**蓝信桌面端**（移动端不支持查看机器人凭证）。
- Agent 的 shell 环境中必须可用 `openclaw` CLI。

---

## 配置参数速查表

所有配置路径均在 `channels.lansenger` 下。使用 `openclaw config set <path> <value>` 设置，`openclaw config get <path>` 读取。

### 核心凭证（必填）

| 配置项 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `appId` | ✅ | — | 机器人 App ID，格式：`orgId-applicationId`（如 `xxx-xxxxxxx`）。获取路径：蓝信桌面端 → 通讯录 → 智能机器人 → 个人机器人 → ℹ️ |
| `appSecret` | ✅ | — | 机器人 App Secret，与 App ID 在同一页面获取。**敏感信息，绝对不要完整回显，始终脱敏处理。** |
| `apiGatewayUrl` | ❌ | `https://open.e.lanxin.cn/open/apigw` | API 网关地址。公有云用户无需修改，企业私有部署用户需设置自定义地址。 |

### 多账号注意事项

> **设置 config 时优先使用 account 级路径**：`channels.lansenger.accounts.<appId>.` 只影响指定机器人。`channels.lansenger.` 是**顶级配置**，会影响所有机器人——其他机器人可能属于其他用户，不要随意改动顶级配置。

| 层级 | 路径示例 | 影响范围 |
|------|---------|---------|
| 顶级（慎用） | `channels.lansenger.groupPolicy` | 所有机器人 |
| 单账号（优先） | `channels.lansenger.accounts.13107200-4218880.groupPolicy` | 仅该机器人 |
| 单群 | `channels.lansenger.groups.<chatId>.requireMention` | 仅该群 |

> 如果用户只有一个机器人，顶级配置和 account 级配置效果相同；如果存在多个机器人（`accounts` 下有多个 key），始终优先用 `accounts.<appId>.` 路径。

### 私聊访问控制

> **重要：蓝信个人机器人只能接收主人（创建者）的私聊消息。** 其他人发送的私聊消息在蓝信平台层面就不会送达，因此 `allowlist` / `open` 策略对个人机器人没有实际意义。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `dmPolicy` | enum | `pairing` | 私聊安全策略。个人机器人推荐使用 `pairing` 或 `disabled`。可选值：`pairing`（首次私聊触发配对码审批）、`allowlist`（仅 allowFrom 中的用户，对个人机器人无意义）、`open`（任何人可私聊，对个人机器人无意义）、`disabled`（禁止私聊） |
| `allowFrom` | string[] | `[]` | 预授权的蓝信用户 ID（格式：`orgId-applicationId`）。对个人机器人无实际意义——只有主人才可以私聊。 |

**dmPolicy 推荐：**
- **`pairing`**（默认，推荐）：主人发送首条私聊 → 机器人回复配对码 → 通过 `openclaw pairing approve lansenger <code>` 审批。
- **`disabled`**：机器人忽略所有私聊。适用于纯群聊机器人。

### 群聊设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `groupPolicy` | enum | `open` | 群聊策略。可选值：`open`（所有群可触发）、`allowlist`（仅 groupAllowFrom 中的群）、`disabled`（禁止群消息） |
| `groupAllowFrom` | string[] | `[]` | 允许触发机器人的群聊 ID 列表，仅在 `groupPolicy` 为 `allowlist` 时生效。 |
| `requireMention` | boolean | `true` | 群聊中是否需要 `@机器人名称` 才会触发。设为 `false` 则任何消息都会触发。 |
| `autoMentionReply` | boolean | `false` | 群聊自动回复时是否 @入站消息发送者。蓝信 API 会根据 staffId 自动拼接名字，无需 Agent 手动写 `@姓名`。支持按群、按账号覆盖。 |

**按群粒度微调** — 使用 `channels.lansenger.groups.<chatId>` 覆盖单个群的设置：

```bash
# 对特定群关闭 @提及 要求
openclaw config set channels.lansenger.groups.<chatId>.requireMention false
# 对特定群开启自动 @回复
openclaw config set channels.lansenger.groups.<chatId>.autoMentionReply true

# 启用/禁用特定群
openclaw config set channels.lansenger.groups.<chatId>.enabled false

# 限制特定群中的发送者
openclaw config set channels.lansenger.groups.<chatId>.allowFrom '["<userId1>","<userId2>"]'
```

### 确认消息

启用 `ackMessage` 后，机器人在 Agent 开始生成回复前会先发送"收到，正在处理…"的简短确认。语言根据用户消息自动检测。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ackMessage` | boolean | `false` | 是否在 Agent 处理前发送确认消息 |
| `revokeAckMessage` | boolean | `true` | Agent 回复送达后是否自动撤回确认消息。设为 `false` 则保留（部分用户不喜欢看到"消息已撤回"的系统提示）。 |
| `ackMessageTextZh` | string | `收到，正在处理...` | 中文确认消息文案 |
| `ackMessageTextEn` | string | `Received, processing...` | 英文确认消息文案 |

### 媒体与文件发送

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `mediaLocalRoots` | string[] | `[]` | 允许发送本地文件的目录列表。**空 = 允许所有路径。** 建议设为工作目录以限制 Agent 访问范围。 |
| `dangerouslyAllowPrivateNetwork` | boolean | `false` | 允许 `lansenger_send_image_url` 从内网地址获取图片（RFC1918、链路本地、metadata IP）。默认被 SSRF 防护拦截。仅在可信隔离环境中启用。**命名中带有 dangerously 表示这是一个有安全风险的选项。** |

### 高级设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `name` | string | — | 机器人账号的显示名称（如 "QAX Bot"），用于 UI 和日志。 |
| `enabled` | boolean | `true` | 总开关。设为 `false` 可临时禁用蓝信频道，不删除配置。 |
| `configWrites` | boolean | `true` | 是否允许蓝信频道自动写入配置（如首次私聊自动设置 `homeChannel`）。设为 `false` 则配置只读。 |
| `homeChannel` | string | — | 定时任务/通知的默认发送目标。从首次私聊消息中自动检测。 |
| `commands.ownerAllowFrom` | string[] | `[]` | 允许执行斜杠命令（`/reset`、`/models` 等）的蓝信用户 staff ID（格式：`lansenger:<orgId>-<staffId>`）。未配置时只有 web 聊天用户可使用命令。设置在 OpenClaw 配置的根级 `commands` 下：
```bash
openclaw config set commands.ownerAllowFrom '["lansenger:<orgId>-<staffId>"]'
```

### 多机器人账号

需要部署多个蓝信机器人时，使用 `accounts` 结构：

```bash
# 查看当前多账号设置
openclaw config get channels.lansenger.accounts

# 添加新机器人账号（key 为 App ID）
openclaw config set channels.lansenger.accounts.<appId>.appId "<appId>"
openclaw config set channels.lansenger.accounts.<appId>.appSecret "<appSecret>"
openclaw config set channels.lansenger.accounts.<appId>.enabled true
openclaw config set channels.lansenger.accounts.<appId>.dmPolicy pairing

# 每个账号独立支持以上所有设置：
# name, apiGatewayUrl, groupPolicy, groupAllowFrom, requireMention,
# ackMessage, revokeAckMessage, ackMessageTextZh, ackMessageTextEn,
# mediaLocalRoots, dangerouslyAllowPrivateNetwork
# （allowFrom / dmPolicy=allowlist/open 对个人机器人无实际意义）
```

**多机器人路由**：使用顶层 `bindings` 配置将不同机器人路由到不同 Agent。

---

## 配置流程

### 第一阶段：核心凭证绑定

#### 步骤 1.1：引导用户获取凭证

告诉用户在蓝信桌面端查找机器人凭证：

> 请打开**蓝信桌面端**，按以下步骤获取你的机器人凭证：
> 1. 点击左侧 **通讯录**
> 2. 选择 **智能机器人** 标签页
> 3. 选择 **个人机器人**
> 4. 找到你的机器人，点击右侧的 **ℹ️ 详情图标**
> 5. 你将看到 **App ID** 和 **App Secret**

**务必告知用户的要点：**
- 凭证**仅在桌面端可见**，移动端无法查看。
- App ID 格式：`orgId-applicationId`（如 `xxx-xxxxxxx`）。
- App Secret 需妥善保管，相当于机器人密码。

#### 步骤 1.2：收集三个凭证值

向用户询问：

1. **App ID**（必填）— 格式：`orgId-applicationId`
2. **App Secret**（必填）— 详情页中的长字符串
3. **API Gateway URL**（可选）— 仅当用户提到私有化部署时询问，否则默认使用 `https://open.e.lanxin.cn/open/apigw`。

**安全规则：** 绝对不要完整回显 App Secret。确认时始终脱敏处理（如 `ABC***xyz`）。

#### 步骤 1.3：检查当前配置状态

```bash
openclaw config get channels.lansenger
```

如果 `appId` 或 `appSecret` 已存在，与用户确认是否覆盖。

#### 步骤 1.4：写入凭证

> **多账号检查**：先执行 `openclaw config get channels.lansenger.accounts`。如果返回了多个 account key，说明存在其他用户配置的其他机器人，**使用 account 级路径**，不要影响他们：
> ```bash
> openclaw config set channels.lansenger.accounts.<appId>.appId "<appId>"
> openclaw config set channels.lansenger.accounts.<appId>.appSecret "<appSecret>"
> ```
> 如果 `accounts` 下只有一个机器人或为空，可以直接用顶级路径。

```bash
openclaw config set channels.lansenger.appId "<appId>"
openclaw config set channels.lansenger.appSecret "<appSecret>"
```

如果用户提供了自定义 API Gateway URL：
```bash
openclaw config set channels.lansenger.apiGatewayUrl "<url>"
```

#### 步骤 1.5：启用并设置默认值

> 多账号环境同样优先使用 `accounts.<appId>.` 路径。

```bash
openclaw config set channels.lansenger.enabled true
openclaw config set channels.lansenger.dmPolicy pairing
```

#### 步骤 1.6：验证连接

```bash
openclaw gateway restart
```

等待几秒后：
```bash
openclaw channel status lansenger
```

- **`ok: true`** → 凭证有效，继续第二阶段。
- **`ok: false`** 或报错 → 参见 [故障排除：连接问题](#连接问题)。

#### 步骤 1.7：推荐加密存储

> 你的 App Secret 目前以明文存储在配置文件中。建议运行 `openclaw secrets configure` 进行加密存储（可选但推荐）。

**不要**自动执行 `openclaw secrets configure`——该命令是交互式的，仅作建议。

#### 步骤 1.8：启用 Agent 工具

蓝信频道工具（`lansenger_send_*`）注册在 `group:plugins` 工具组下。需要将 `group:plugins` 加入工具白名单才能让 Agent 使用：

```bash
openclaw config get tools.alsoAllow

# 如果为空或不包含 "group:plugins"，添加它：
openclaw config set tools.alsoAllow '["group:plugins"]'
```

> 不配置此项的话，`lansenger_send_file`、`lansenger_send_text` 等工具在 Agent 中不可见，只能通过 CLI 发送消息。

---

### 第二阶段：私聊配对

机器人连接成功后，用户需要配对自己的蓝信账号才能发送私聊。

#### 步骤 2.1：解释配对流程

> 现在请打开**蓝信客户端**（桌面端或移动端均可），找到你的机器人，给它发送一条私聊消息。消息内容随意，比如 "你好"。
>
> 发送后，机器人会自动回复一条包含**配对码**的消息。请把配对码告诉我，我来帮你完成配对。

#### 步骤 2.2：提醒超时

> 配对码有时效性，如果超过 5 分钟未使用，可能需要重新发送消息获取新的配对码。

#### 步骤 2.3：审批配对

用户提供配对码后：

```bash
openclaw pairing approve lansenger <配对码>
```

#### 步骤 2.4：验证

让用户再发一条私聊（如"测试"）。如果机器人正常回复而非再次发送配对码，则配对成功。

如果再次收到配对码：
- 配对码可能已过期——让用户重新发送私聊获取新码。
- 重新执行 `openclaw pairing approve lansenger <新配对码>`。

---

### 第三阶段：可选——询问其他设置

核心配置完成后，询问用户是否需要调整其他设置。简洁呈现选项，每次 2-3 项，不要一次性堆太多。

#### 批次 A：私聊与安全

1. **禁用私聊** — 如果只想让机器人在群聊中使用：

> 多账号环境同样优先使用 `accounts.<appId>.dmPolicy`。

```bash
openclaw config set channels.lansenger.accounts.<appId>.dmPolicy disabled
```

> 注意：蓝信个人机器人只能接收主人的私聊。`allowFrom`、`allowlist`、`open` 等策略对个人机器人无实际意义。只有主人的私聊会被送达。

#### 批次 B：群聊

2. **群聊策略** — 默认 `open`（所有群可触发），是否需要限制？
3. **群聊 @提及** — 默认需要 @机器人才会触发，是否需要关闭？
4. **允许的群聊列表** — 如果群聊策略设为 `allowlist`，需要提供允许的群 ID 列表。

> **多账号环境 → 使用 account 级路径**：`channels.lansenger.accounts.<appId>.groupPolicy`，仅影响该机器人。

```bash
openclaw config set channels.lansenger.accounts.<appId>.groupPolicy allowlist   # 仅允许列表群
openclaw config set channels.lansenger.accounts.<appId>.groupPolicy disabled    # 禁止群消息
openclaw config set channels.lansenger.accounts.<appId>.requireMention false    # 无需 @提及
openclaw config set channels.lansenger.accounts.<appId>.groupAllowFrom '["<chatId1>"]'
```

#### 批次 C：确认消息

5. **确认消息** — 开启后，机器人在处理消息前会先回复"收到，正在处理…"
6. **撤回确认消息** — Agent 回复后自动撤回确认消息（避免刷屏）
7. **自定义确认文案** — 修改中/英文确认文案。

```bash
openclaw config set channels.lansenger.ackMessage true
openclaw config set channels.lansenger.revokeAckMessage false       # 保留确认消息不撤回
openclaw config set channels.lansenger.ackMessageTextZh "稍等，正在处理..."
openclaw config set channels.lansenger.ackMessageTextEn "One moment..."
```

#### 批次 D：媒体发送

8. **文件目录限制** — 限制 Agent 只能从指定目录发送文件（提高安全性）
9. **内网图片** — 允许 Agent 从内网 URL 下载并发送图片（默认禁止，有 SSRF 风险）

```bash
# 限制文件访问仅限工作目录
openclaw config set channels.lansenger.mediaLocalRoots '["/workspace"]'

# 允许内网图片 URL（请谨慎使用）
openclaw config set channels.lansenger.dangerouslyAllowPrivateNetwork true
```

**重要：** 如果启用 `dangerouslyAllowPrivateNetwork`，务必提醒用户 SSRF 风险：
> ⚠️ 这个选项允许 Agent 从内网地址下载图片，存在 SSRF 安全风险。仅在完全可信的隔离环境中启用。

#### 批次 E：高级

10. **显示名称** — 给这个机器人设置一个友好的显示名称
11. **自动写配置** — 是否允许自动设置 homeChannel（默认开启，建议保持）
12. **斜杠命令权限** — 允许用户在蓝信中执行 `/reset`、`/models` 等命令。需将用户的 lansenger staff ID 加入 `commands.ownerAllowFrom`（格式：`lansenger:<orgId>-<staffId>`）
13. **多机器人** — 是否需要配置多个蓝信机器人账号

```bash
openclaw config set channels.lansenger.name "QAX Bot"
openclaw config set channels.lansenger.configWrites false           # 禁止自动写配置
openclaw config set commands.ownerAllowFrom '["lansenger:<orgId>-<staffId>"]'
```

#### 修改后务必重启

任何 `channels.lansenger` 配置变更后：

```bash
openclaw gateway restart
```

然后验证：
```bash
openclaw channel status lansenger
```

---

## 故障排除

### openclaw: command not found

```bash
which openclaw || ls /usr/local/bin/openclaw* || ls /opt/openclaw/bin/
```

如果找不到，说明此 Docker 镜像中 OpenClaw 未正确安装，告知用户。

### channel not found: lansenger

```bash
openclaw plugins list | grep lansenger
```

如果未列出：
```bash
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel
```

### 连接问题

1. 确认 `apiGatewayUrl` 与用户的部署方式匹配（公有云 vs 私有化）。
2. 检查机器人是否被删除或重新创建——凭证可能已变更。
3. 检查网络连通性：
   ```bash
   curl -I https://open.e.lanxin.cn/open/apigw
   ```
4. 查看 gateway 日志：
   ```bash
   openclaw gateway logs --tail 50 | grep lansenger
   ```

### 配对码始终失败

1. 确认 `dmPolicy` 为 `pairing`：
   ```bash
   openclaw config get channels.lansenger.dmPolicy
   ```
2. 确认 gateway 已运行且已在配置变更后重启：
   ```bash
   openclaw gateway status
   ```
3. 让用户重新发送私聊并立即提供新配对码。
4. **个人机器人只能接收主人的私聊。** 如果用户不是机器人主人，配对将始终失败——因为机器人根本无法收到该用户的私聊。

### 配对后私聊无响应

1. 检查 `homeChannel` 是否正确自动设置：
   ```bash
   openclaw config get channels.lansenger.homeChannel
   ```
2. 查看 gateway 日志中的处理错误：
   ```bash
   openclaw gateway logs --tail 100 | grep -i error
   ```

### 群聊中无响应

1. 检查 `groupPolicy` 不是 `disabled`：
   ```bash
   openclaw config get channels.lansenger.groupPolicy
   ```
2. 如果 `groupPolicy` 是 `allowlist`，确认群 ID 在 `groupAllowFrom` 中。
3. 检查 `requireMention`——如果为 `true`，用户必须 `@机器人名称` 才能触发：
   ```bash
   openclaw config get channels.lansenger.requireMention
   ```
4. 检查 `groups.<chatId>` 下的按群覆盖设置——它们优先于顶层设置。

### 确认消息不显示

1. 确认 `ackMessage` 为 `true`：
   ```bash
   openclaw config get channels.lansenger.ackMessage
   ```
2. 启用确认消息后必须重启 gateway。

---

## 重要注意事项

- **不要编造或猜测凭证。** 仅使用用户明确提供的值。
- **绝对不要完整显示 App Secret。** 任何消息中都必须脱敏处理。
- **任何 `channels.lansenger` 配置变更后必须重启 gateway**（`openclaw gateway restart`）。
- **蓝信频道工具**（`lansenger_send_*`）在频道配置完成且 gateway 运行后才可用。
- **个人机器人只能接收主人的私聊。** 与非主人账号配对将失败。
- **设置数组类型配置值时**，使用 JSON 数组语法：`'["item1","item2"]'`。
- **设置布尔类型配置值时**，使用 `true` 或 `false`（不是字符串）。
- **设置前先用 `openclaw config get <path>`** 读取当前值再做修改。
