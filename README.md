[English](README.md) | [简体中文](README.zhHans.md) | [繁体中文](README.zhHant.md) | [繁体中文香港](README.zhHantHK.md) | [Français](README.fr.md)

# @lansenger-pm/openclaw-lansenger-channel

Lansenger (蓝信) channel plugin for OpenClaw — WebSocket inbound, HTTP API outbound.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)

## Features

- **Real-time messaging** via WebSocket long-connection
- **Multi-bot support** — bind multiple Lansenger bots to different OpenClaw agents
- **Markdown support** using `formatText` msgType (default)
- **File/Image/Voice attachments** via `text` msgType with media upload
- **Approval cards** — interactive approval workflow with in-place status updates (pending → approved/denied)
- **Language detection** — auto-detect user language from messages for localized responses
- **Auto-routing via msgTarget** — all send methods auto-route to group chat or DM (private chat); no separate group/private methods
- **@Mentions** — support @all and @specific users in group chats
- **Inbound media processing** — download images/files/voice, detect extension, provide file paths to agent
- **Message revocation** — revoke previously sent messages (chatType: bot or group only)
- **Auto-start** — gateway automatically connects all configured bot accounts on boot
- **Inbound debounce** — merge rapid consecutive messages from the same sender using OpenClaw's `messages.inbound.debounceMs` config
- **Ack message** — send a brief "received, processing..." acknowledgment before the agent starts; auto-revoked after agent reply; language auto-detected
- **Zero core modification** — pure plugin mode, `git diff HEAD` stays PRISTINE

## Message Type Capability Matrix

| msgType     | Markdown | @mention | Attachments |
|-------------|----------|----------|-------------|
| `text`      | ✗        | ✓        | ✓           |
| `formatText`| ✓        | ✓ (reminder) | ✗           |

**Default strategy**: Use `formatText` first for Markdown replies. Fall back to `text` for attachments. Both `formatText` and `text` support @mention via `reminder` param — include "@姓名" in text content when mentioning.

## Agent Tools & CLI

Agent tools are **built into this plugin** — they are always available when the channel is configured and running. CLI is an optional alternative that works via bash.

Messages can be sent via **agent tools** (built-in) or **CLI commands** (optional alternative):

| Method | How to install | Usage |
|--------|---------------|-------|
| **Agent tools** (built-in) | Included in `@lansenger-pm/openclaw-lansenger-channel` | `lansenger_send_file`, `lansenger_send_text`, etc. |
| CLI commands (optional) | `pipx install lansenger-cli` (`pip install lansenger-cli` as alternative) | `lansenger message send-file`, `lansenger message send-text`, etc. |

> **Agent tools are always available** when the channel is configured and the gateway is running — no separate plugin needed. CLI commands are an optional alternative for environments where bash access is preferred; they require `lansenger-cli` (Python).

| Tool | Description |
|------|-------------|
| `lansenger_send_text` | Send plain text message with optional file attachment and @mentions (NO Markdown) |
| `lansenger_send_format_text` | Send Markdown-formatted text with optional @mentions |
| `lansenger_send_file` | Send file/image/video/voice from workspace or external path |
| `lansenger_send_image_url` | Send image by URL |
| `lansenger_send_link_card` | Send rich link preview card |
| `lansenger_send_app_card` | Send interactive/approval card |
| `lansenger_send_app_articles` | Send multi-article card |
| `lansenger_update_dynamic_card` | Update dynamic card status in-place |
| `lansenger_revoke_message` | Revoke a previously sent message |
| `lansenger_query_groups` | Query available groups |

Tools are also available via CLI: `lansenger message send-text`, `lansenger message send-file`, etc.

## Installation & Configuration

### Recommended setup

```bash
# 1. Install the channel plugin (includes agent tools)
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. Enable the plugin (if not auto-enabled)
openclaw config set plugins.entries.lansenger.enabled true

# 3. Configure the channel (interactive wizard)
openclaw channels add

# 4. Restart the gateway
openclaw gateway restart
```

> **Optional**: Install `lansenger-cli` for an alternative CLI-based messaging path: `pipx install lansenger-cli`.

> **Custom gateway**: For enterprise deployments (e.g. 奇安信), set `apiGatewayUrl` in `openclaw.json` or environment after configuration — see [Optional Configuration](#optional-configuration).

### Development install (linked)

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

### First message

The bot auto-connects via WebSocket on gateway restart. Send a DM to the bot — you'll receive a pairing code. Approve it:

```bash
openclaw pairing approve lansenger <code>
```

## Configuration

### Required Environment Variables

Add these to `~/.openclaw/.env` or your environment:

| Variable | Description | Example |
|----------|-------------|---------|
| `LANSENGER_APP_ID` | Personal bot App ID | `your-appid` |
| `LANSENGER_APP_SECRET` | Personal bot App Secret | `ABCDEF123456...` |
| `LANSENGER_API_GATEWAY_URL` | Lansenger API Gateway URL override | `https://open.e.lanxin.cn/open/apigw` |

Credentials can also be provided via `openclaw.json` config (see Optional Configuration below). Config values take precedence; env vars are used as fallback when config is unset.

> ⚠️ **Security: Migrate appSecret to SecretRef storage**
>
> As of v3.12.1, the Lansenger channel plugin supports OpenClaw SecretRef for `appSecret`. If your `appSecret` is stored as plaintext in `openclaw.json`, any workspace tool that reads config can see it. Migrate by running:
>
> ```
> openclaw secrets configure
> ```
>
> Select the `channels.lansenger.accounts.*.appSecret` field to convert it to a SecretRef. After migration, the config will contain `__OPENCLAW_SECRET__({ref_id})` instead of the raw secret value, while the actual value is stored in the system credential store.

### Get Credentials

**Lansenger Desktop** → **Contacts** → **Bots** → **Personal Bots** → click **ℹ️** icon

> ⚠️ **Mobile client does NOT support viewing credentials.** Use the desktop client only.

### Optional Configuration

```json
{
  "channels": {
    "lansenger": {
      "appId": "your-appid",
      "appSecret": "your-secret",
      "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw",
      "homeChannel": "xxx-xxx",
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

| Field | Description | Default |
|-------|-------------|---------|
| `appId` | Personal bot App ID | — |
| `appSecret` | Personal bot App Secret | — |
| `apiGatewayUrl` | API Gateway URL | `https://open.e.lanxin.cn/open/apigw` |
| `homeChannel` | Default chat ID for cron/notification delivery | — |
| `enabled` | Enable/disable the channel (runtime default: false without credentials) | `true` |
| `allowFrom` | User IDs allowed to DM the bot | `[]` |
| `dmPolicy` | DM policy: `pairing`, `allowlist`, `open`, `disabled` | `pairing` |
| `configWrites` | Allow Lansenger to write config in response to channel events | `true` |
| `name` | Display name for this account | — |
| `accounts` | Multi-bot configuration | — |
| `groupPolicy` | Group policy: `open`, `allowlist`, `disabled` | `allowlist` |
| `groupAllowFrom` | Group IDs allowed to trigger the bot | `[]` |
| `groups` | Per-group configuration (requireMention, enabled, allowFrom) | — |
| `ackMessage` | Send a brief acknowledgment message before agent processing | `false` |
| `revokeAckMessage` | Auto-revoke ack message after agent reply is delivered. Set `false` to keep ack visible (some users prefer it over a "message revoked" system notice) | `true` |
| `ackMessageTextZh` | Chinese ack message text | `收到，正在处理...` |
| `ackMessageTextEn` | English ack message text | `Received, processing...` |

### Inbound Debounce (Message Merging)

When users send multiple rapid messages, OpenClaw's debounce mechanism can merge them into a single agent turn. Configure in `openclaw.json`:

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

| Field | Description | Default |
|-------|-------------|---------|
| `messages.inbound.debounceMs` | Global debounce window (ms); same-sender consecutive messages within this window are merged | `0` (disabled) |
| `messages.inbound.byChannel.lansenger` | Per-channel override (takes precedence over global) | — |
| `messages.queue.mode` | Queue mode when agent is already processing: `steer`, `followup`, `collect`, `queue`, `interrupt` | `steer` (recommended) |

- Media messages and control commands are NOT debounced — they are processed immediately
- When debounce is active, merged messages' texts are joined with `\n`; media paths are concatenated; the last message's metadata is used

### Multi-Bot Configuration

For multiple bots, add additional accounts using `openclaw config set`:

```bash
# Add a second bot (replace appid/appsecret/gateway with your values)
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

# Restart to apply
openclaw gateway restart
```

The resulting config structure:

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

## Usage

The gateway auto-starts all configured accounts on boot. The `lansenger.start` method is available for dynamic start of additional accounts.

### Start the gateway (dynamic)

```bash
openclaw gateway call lansenger.start
```

### Stop the gateway

```bash
openclaw gateway call lansenger.stop
```

### Check status

```bash
openclaw channels status
# With health probe (shows "configured" and "works"):
openclaw channels status --probe
```

### Multi-agent routing

Use `bindings` to route Lansenger DMs or groups to different agents (same pattern as Feishu/WhatsApp/etc.):

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

Routing fields:
* `match.channel`: `"lansenger"`
* `match.peer.kind`: `"direct"` (DM) or `"group"` (group chat)
* `match.peer.id`: user ID (`xxx-xxx`) or group chat ID

In single-agent mode, all messages route to the default agent (`main`) automatically — no bindings needed.

### Supported Message Types

| Type | Description | API Method | Direction |
|------|-------------|------------|-----------|
| `text` | Plain text with optional @mentions and attachments | `sendText()` | Outbound |
| `formatText` | Markdown-formatted text (default) | `sendFormatText()` | Outbound |
| `image` | Image with optional caption | `sendFile()` | Outbound |
| `file` | Any file attachment | `sendFile()` | Outbound |
| `video` | Video attachment | `sendFile()` | Outbound |
| `voice` | Voice message | `sendFile()` | Outbound |
| `linkCard` | Rich link preview card | `sendLinkCard()` | Outbound |
| `i18nAppCard` | Reserved for future use; 5-language card | `sendI18nAppCard()` | Outbound |
| `appCard` | Approval cards with status updates | `sendAppCard()` | Outbound |
| `appArticles` | Multi-article card (field: `summary`, not `description`) | `sendAppArticles()` | Outbound |
| `position` | Location/position message | — | Inbound-only |
| `card` | Generic card message | — | Inbound-only |
| `sticker` | Sticker/emoji message | — | Inbound-only |

## Inbound Media Handling

When users send images, videos, files, or voice messages, the plugin:

1. Downloads all `mediaIds` via the Lansenger media API (video: first as video type, second as image type for cover)
2. Detects file extension from Content-Type/Content-Disposition headers (fallback: magic bytes)
3. Saves to temp files and attaches paths to `InboundEvent.mediaPaths[]`
4. Adds a hint in agent text: "Attached files saved locally — use the read tool to view"

## Approval Workflow

The plugin supports approval workflow cards:
- Approval requests are sent as **appCard** with `isDynamic=true`
- Status updates (pending → approved/denied) update the card in-place via **DynamicMsg**
- Language detection: the card is sent in the user's detected language (Chinese or English)
- **i18nAppCard** (5-language) is reserved for future use but not currently used for approval

## Important Notes

- **No staff chat** — Lansenger has group chat and DM (private chat) only; there is no "staff chat" concept.
- **Revoke chatType** — only `bot` or `group`; no `staff` chatType.
- **No sysMsg on revoke** — the API accepts `sysMsg` but does not display it.
- **No deleteMessage** — the API returns error 10000; deletion is unavailable.
- **appArticles** — uses `summary` field (not `description`).
- **linkCard** — `description`, `iconLink`, `fromName`, `fromIconLink` are required (empty strings as defaults).
- **msgTarget auto-routing** — all send methods route automatically; no separate group/private API calls.
- **Gateway URL per-environment** — e.g. `https://apigw.lx.qianxin.com` for 奇安信, `https://open.e.lanxin.cn/open/apigw` for standard Lansenger.
- **reminder** — optional in formatText; recommended in group chat. Include "@姓名" in text when mentioning.
- **Media** — `<media>` tags work for workspace files; for external paths use `lansenger_send_file`.
- **openclaw skill/message lansenger** — these CLI commands do NOT exist; use agent tools instead.
- **Agent tools** — agent tools (`lansenger_send_*`) are built into the channel plugin — always available when the channel is configured and running. CLI commands (`lansenger message send-*`) require `pipx install lansenger-cli` and are an optional alternative.
- **alsoAllow** — agent tools are registered by this channel plugin but may be **invisible** under restrictive tool profiles. Add `"tools": { "alsoAllow": ["group:plugins"] }` to `openclaw.json` to ensure the agent can see and use `lansenger_send_*` tools. Without this, tools may silently not appear in the agent's tool list.

## Development

### Build

```bash
npm install
npx tsc
```

### Test

```bash
npx vitest run
```

### Typecheck

```bash
npx tsc --noEmit
```

### Project Structure

```
openclaw-lansenger-channel/
├── src/
│   ├── client.ts       # Lansenger API client (WS, HTTP, media)
│   ├── channel.ts      # OpenClaw channel plugin
│   ├── runtime.ts      # Gateway runtime (methods, inbound handler)
│   ├── tools.ts        # Agent tool definitions (10 built-in tools)
│   ├── setup-wizard.ts # Setup wizard (multi-account config migration)
│   ├── channel.test.ts # Channel plugin tests
│   ├── client.test.ts  # API client tests
│   ├── runtime.test.ts # Runtime tests
│   ├── tools.test.ts   # Tool tests
│   └── setup-wizard.test.ts # Setup wizard tests
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # Agent messaging strategy (tools + CLI)
├── dist/               # Compiled JavaScript
├── index.ts            # Plugin entry point
├── setup-entry.ts      # Setup wizard entry
├── openclaw.plugin.json # Plugin metadata & GUI config
├── package.json
└── tsconfig.json
```

## Troubleshooting

### OpenClaw v2026.5.18+: Device pairing required

After upgrading OpenClaw to v2026.5.18 or later, **device pairing** is required before any client (browser Dashboard, Control UI) can connect. This also affects the Lansenger channel — if the gateway host's device is not approved, WebSocket connections may be blocked and pairing messages cannot be sent to Lansenger users.

**Fix — run these commands on the OpenClaw gateway host:**

```bash
# 1. List pending device pairing requests
openclaw devices list

# 2. Approve the latest request (preview first, then approve with exact ID)
openclaw devices approve --latest   # preview
openclaw devices approve <requestId>  # approve with the exact ID shown

# 3. Restart the gateway
openclaw gateway restart
```

See [OpenClaw devices documentation](https://docs.openclaw.ai/cli/devices) for full details.

### "Mobile client does NOT support viewing credentials"

Use the **Lansenger Desktop** client only. The mobile app does not display bot credentials.

### "No binding for botId"

Agent routing is handled by OpenClaw's `bindings[]` config — see [Multi-agent routing](#multi-agent-routing). In single-agent mode, no binding is needed; messages route to the default agent automatically.

### WebSocket disconnects

The plugin includes automatic reconnection with exponential backoff (2s, 5s, 10s, 30s, 60s) and heartbeat (ping every 30s).

### formatText vs text

- Use `formatText` for Markdown replies (default)
- Use `text` for attachments (no Markdown)
- Both support @mention via `reminder` — include "@姓名" in text content when mentioning
- For both Markdown AND a file, send two separate messages

### Dynamic card update fails

Approval status updates use the DynamicMsg appCard format. The `updateCardStatus()` method handles this automatically.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npx vitest run`
5. Submit a pull request