---
name: lansenger-setup
description: Comprehensive Lansenger (蓝信) channel configuration guide — covers initial bot credential binding, DM pairing, group policy setup, and ALL ongoing configuration adjustments (requireMention, autoMentionReply, group allow/deny list, ackMessage, media paths, etc.). Use this skill whenever the user wants to set up, reconfigure, or adjust ANY Lansenger channel setting via conversation.
metadata: {"openclaw":{"requires":{"cli":["openclaw"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) 配置指南

本技能覆盖蓝信机器人接入 OpenClaw 的完整流程。适用于用户**无法直接操作命令行**的场景（如 Docker 部署），Agent 充当配置向导，收集用户提供的凭证并代为执行 CLI 命令。

## 何时使用此技能

- 用户提到任何蓝信/Lansenger 配置相关关键词：配置蓝信、设置蓝信、绑定机器人、连接蓝信、蓝信频道、群设置、私聊设置、@提及、requireMention、groupPolicy、dmPolicy、appId、appSecret、ackMessage 等。
- 用户想要调整特定频道设置（私聊策略、群聊策略、确认消息、自动@回复、自动引用回复、媒体路径、审批等）。
- 用户对蓝信机器人的行为不满意，希望修改。

## 前提条件

- 用户必须有一个已创建好的蓝信**个人机器人**。
- 用户必须能访问**蓝信桌面端**（移动端不支持查看机器人凭证）。
- Agent 的 shell 环境中必须可用 `openclaw` CLI。

> **私有部署版本差异**：企业私有部署的蓝信服务版本可能与公有云不同，并非所有配置项均可用。例如：
> - `/v2/groups/fetch` 接口在部分旧版本私有部署中可能返回 `errCode=10005 无权限`
> - `autoQuoteReply`、`autoMentionReply` 等依赖新版 API 的功能可能需要较新的服务端版本
>
> 遇到"无权限"或功能不生效时，提示用户联系蓝信管理员确认服务端版本是否支持对应 API。

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

群聊接入有**三层**独立的过滤机制，群级(2)与用户级(1/3)是**与关系**——必须同时满足才能入站：

1. **频道级用户过滤**：`groupAllowFrom` — 哪些用户能在任意群触发
2. **群级过滤**：`groupPolicy` + `groups.<chatId>.enabled` — 哪些群允许接入
3. **单群用户过滤**：`groups.<chatId>.allowFrom` — 该群内仅允许哪些用户触发（不设置时无限制）

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `groupPolicy` | enum | `open` | 群级策略。可选值：`open`（所有群可触发）、`allowlist`（仅 groups 中 enabled:true 的群）、`disabled`（禁止群消息） |
| `groupAllowFrom` | string[] | `[]` | **用户级过滤**：只有列表中的蓝信用户 ID 在群聊中发消息才会触发 bot。注意，此项填的是**用户 ID**（发消息的人），不是群 ID。蓝信用户 ID 和群 ID 格式相同，无法靠格式区分，请从蓝信消息日志或 API 确认。 |
| `groups` | object | `{}` | 单群配置（key 为群 chatId），可设置 `enabled`、`requireMention`、`autoMentionReply`、`autoQuoteReply`、`respondToAtAll`、`allowFrom`。`allowFrom` 限定该群内允许触发 bot 的用户 ID（不设置或空数组时无限制），**替换**上级 `groupAllowFrom`（群级 > 账号级 > 频道级）。 |
| `requireMention` | boolean | `true` | 群聊中是否需要 `@机器人名称` 才会触发。设为 `false` 则任何消息都会触发。 |
| `autoMentionReply` | boolean | `false` | 群聊自动回复时是否 @入站消息发送者。蓝信 API 会根据 staffId 自动拼接名字，无需 Agent 手动写 `@姓名`。支持按群、按账号覆盖。 |
| `autoQuoteReply` | boolean | `false` | 群聊和私聊回复时是否自动引用入站消息。支持按群、按账号覆盖。私聊时 per-group 配置不生效。 |
| `respondToAtAll` | boolean | `false` | 群聊中 `@全体成员` 是否触发机器人。默认 `false`，仅 `@机器人名称` 会触发；设为 `true` 后 @all 也有效。支持按群、按账号、section 级覆盖。 |

**`groups.<chatId>.enabled` 语义：**

`enabled` 是一个 **opt-out（主动封禁）** 机制，不是 opt-in。默认未设置时（`undefined`）不会触发拦截。

| groupPolicy | 群在 groups 中？ | enabled 值 | 结果 |
|:--:|:--:|-----------|:--:|
| `disabled` | 不限 | 不限 | ❌ 拦截。**不可被 per-group 覆盖** |
| `open` | 否 | — | ✅ 放行 |
| `open` | 是 | 未设置 / `true` | ✅ 放行 |
| `open` | 是 | `false` | ❌ 拦截 |
| `allowlist` | 否 | — | ❌ 拦截 |
| `allowlist` | 是 | 未设置 / `true` | ✅ 放行（仅列出即可） |
| `allowlist` | 是 | `false` | ❌ 拦截 |

> 以上仅覆盖群级过滤。消息还需通过**用户级过滤**：若设了 `groupAllowFrom`，sender 必须在列表中；若设了 `groups.<chatId>.allowFrom`，则**替换**上级 `groupAllowFrom`（仅群级生效，上级不参与）。

**按群粒度微调** — 优先使用 account 级路径 `channels.lansenger.accounts.<appId>.groups.<chatId>` 避免影响其他机器人：

```bash
# 对特定群关闭 @提及 要求
openclaw config set channels.lansenger.accounts.<appId>.groups.<chatId>.requireMention false
# 对特定群开启自动 @回复
openclaw config set channels.lansenger.accounts.<appId>.groups.<chatId>.autoMentionReply true
# 开启自动引用回复
openclaw config set channels.lansenger.accounts.<appId>.groups.<chatId>.autoQuoteReply true

# 允许 @全体成员 触发机器人（account 级 groups）
openclaw config set channels.lansenger.accounts.<appId>.groups.<chatId>.respondToAtAll true
# 或 section 级 groups（仅一个机器人时可用）
openclaw config set channels.lansenger.groups.<chatId>.respondToAtAll true

# 启用/禁用特定群
openclaw config set channels.lansenger.accounts.<appId>.groups.<chatId>.enabled false

# 限制特定群中的发送者
openclaw config set channels.lansenger.accounts.<appId>.groups.<chatId>.allowFrom '["<userId1>","<userId2>"]'
```

> 仅有一个机器人时可以用 section 级 `channels.lansenger.groups.<chatId>` 简化配置。

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
# mediaLocalRoots, dangerouslyAllowPrivateNetwork, respondToAtAll
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

2. **群聊策略** — 默认 `open`（所有群可触发）：
   - `open` — 所有群可触发（推荐，个人机器人的群权限由主人控制）
   - `allowlist` — 仅白名单群可触发（配合 `groups.<chatId>.enabled: true` 使用）
   - `disabled` — 禁止所有群消息
3. **群聊 @提及** — 默认需要 @机器人才会触发，是否需要关闭？
4. **群白名单** — 如果群聊策略设为 `allowlist`，需要在 `groups` 中启用允许的群。`open` 模式下也可以 `enabled: false` 封禁特定群。
5. **群聊用户过滤** — 是否只允许特定用户在群聊中触发 bot？设置 `groupAllowFrom`（**注意填用户 ID，不是群 ID**）。蓝信用户 ID 和群 ID 格式相同，请从日志或 API 确认。

> **三层过滤是"与"关系**：`groupAllowFrom` 控制**谁能发**（频道级用户过滤），`groupPolicy` + `groups` 控制**哪些群**能收（群级过滤），`groups.<chatId>.allowFrom` 控制**该群内谁能发**（单群用户过滤）。三者独立，必须同时满足。

> **多账号环境 → 使用 account 级路径**：`channels.lansenger.accounts.<appId>.groupPolicy`，仅影响该机器人。

```bash
# allowlist 模式：仅允许特定群
openclaw config set channels.lansenger.accounts.<appId>.groupPolicy allowlist
openclaw config set channels.lansenger.groups.<chatId>.enabled true

# open 模式 + 封禁特定群
openclaw config set channels.lansenger.accounts.<appId>.groupPolicy open
openclaw config set channels.lansenger.groups.<chatId>.enabled false

# 禁止所有群
openclaw config set channels.lansenger.accounts.<appId>.groupPolicy disabled

# 不需要 @提及
openclaw config set channels.lansenger.accounts.<appId>.requireMention false

# 仅允许特定用户（填用户 ID，不是群 ID）
openclaw config set channels.lansenger.accounts.<appId>.groupAllowFrom '["<userId1>","<userId2>"]'
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
14. **审批权限** — 允许蓝信用户在聊天中审批危险命令（非白名单 exec 命令）。开启后，bot owner 自动被设为审批人（从 `homeChannel` 检测），无需手动配置 ID。

```bash
openclaw config set approvals.exec.enabled true
```

> Gateway 启动时会自动将 `homeChannel` (bot owner) 写入 `approvals.exec.allowFrom.lansenger`。如果未自动配置，`resolveLansengerApprovers` 也会 fallback 到 owner。设置后可通过点击审批卡片按钮或手输 `/approve <id> allow-once|allow-session|deny` 完成审批。

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
2. 如果 `groupPolicy` 是 `allowlist`，确认群已在 `groups.<chatId>.enabled: true` 中配置。`open` 模式下也可能被 `groups.<chatId>.enabled: false` 封禁。
3. 检查 `groupAllowFrom` — 如果设置了用户白名单，确认发消息的人在该列表中（蓝信用户 ID 和群 ID 格式相同，请确认填的是用户 ID 而非群 ID）：
   ```bash
   openclaw config get channels.lansenger.groupAllowFrom
   ```
4. 检查 `requireMention`——如果为 `true`，用户必须 `@机器人名称` 才能触发：
   ```bash
   openclaw config get channels.lansenger.requireMention
   ```
5. 检查 `groups.<chatId>.allowFrom` — 如果为特定群设置了用户白名单，确认发消息的人在该列表中：
   ```bash
   openclaw config get channels.lansenger.groups.<chatId>.allowFrom
   ```
6. 检查 `groups.<chatId>` 下的按群覆盖设置——它们优先于顶层设置。

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
- **私有部署版本差异**：并非所有配置项在所有蓝信服务端版本上都可用。如遇 API 返回"无权限"或功能不生效，应提醒用户联系蓝信管理员确认服务端版本。
- **任何 `channels.lansenger` 配置变更后必须重启 gateway**（`openclaw gateway restart`）。
- **蓝信频道工具**（`lansenger_send_*`）在频道配置完成且 gateway 运行后才可用。
- **个人机器人只能接收主人的私聊。** 与非主人账号配对将失败。
- **设置数组类型配置值时**，使用 JSON 数组语法：`'["item1","item2"]'`。
- **设置布尔类型配置值时**，使用 `true` 或 `false`（不是字符串）。
- **设置前先用 `openclaw config get <path>`** 读取当前值再做修改。
