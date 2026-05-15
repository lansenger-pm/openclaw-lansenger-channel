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
- **Zero core modification** — pure plugin mode, `git diff HEAD` stays PRISTINE

## Message Type Capability Matrix

| msgType     | Markdown | @mention | Attachments |
|-------------|----------|----------|-------------|
| `text`      | ✗        | ✓        | ✓           |
| `formatText`| ✓        | ✓ (reminder) | ✗           |

**Default strategy**: Use `formatText` first for Markdown replies. Fall back to `text` for attachments. Both `formatText` and `text` support @mention via `reminder` param — include "@姓名" in text content when mentioning.

## Agent Tools

| Tool | Description |
|------|-------------|
| `lansenger_send_text` | Send text or formatText message (Markdown by default) |
| `lansenger_send_file` | Send file/image/video/voice from workspace or external path |
| `lansenger_send_image_url` | Send image by URL |
| `lansenger_send_link_card` | Send rich link preview card |
| `lansenger_send_app_card` | Send interactive/approval card |
| `lansenger_send_app_articles` | Send multi-article card |
| `lansenger_update_dynamic_card` | Update dynamic card status in-place |
| `lansenger_revoke_message` | Revoke a previously sent message |
| `lansenger_query_groups` | Query available groups |

## Installation & Configuration

### Recommended 4-step flow

```bash
# 1. Install the plugin
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. Enable the plugin (if not auto-enabled)
openclaw config set plugins.entries.lansenger.enabled true

# 3. Configure the channel (interactive wizard)
openclaw channels add --channel lansenger
#   OR non-interactive:
openclaw channels add --channel lansenger --token "appId:appSecret"

# 4. Restart the gateway
openclaw gateway restart
```

The `openclaw.install` metadata in `package.json` (`npmSpec`, `localPath`, `defaultChoice`) enables **install-on-demand**: if a user runs `openclaw channels add --channel lansenger` before the plugin is installed, OpenClaw can automatically install it using this metadata.

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
| `LANSENGER_APP_SECRET` | Personal bot App Secret | `57E718CA1CAC20F2...` |
| `LANSENGER_API_GATEWAY_URL` | Lansenger API Gateway URL override | `https://open.e.lanxin.cn/open/apigw` |

Credentials can also be provided via `openclaw.json` config (see Optional Configuration below). Env vars take precedence when both are set.

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
      "homeChannel": "lansenger",
      "enabled": true,
      "allowFrom": ["your-appid"],
      "dmSecurity": "paired",
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
| `homeChannel` | Default channel for agent routing | `lansenger` |
| `enabled` | Enable/disable the channel | `true` |
| `allowFrom` | User IDs allowed to DM the bot | `[]` |
| `dmSecurity` | DM policy: `paired`, `allowlist`, `open` | `paired` |
| `accounts` | Multi-bot configuration | — |
| `groupPolicy` | Group policy: `open`, `allowlist`, `disabled` | `allowlist` |
| `groupAllowFrom` | Group IDs allowed to trigger the bot | `[]` |
| `groups` | Per-group configuration (requireMention, enabled, allowFrom) | — |

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
      "dmSecurity": "paired",
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

Routing fields:
* `match.channel`: `"lansenger"`
* `match.peer.kind`: `"direct"` (DM) or `"group"` (group chat)
* `match.peer.id`: user ID (`2285568-xxx`) or group chat ID

In single-agent mode, all messages route to the default agent (`main`) automatically — no bindings needed.

### Group policy

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

1. Downloads all `mediaIds` via the Lansenger media API
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
│   ├── channel.test.ts # Channel plugin tests
│   └── runtime.ts      # Gateway runtime (methods, inbound handler)
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # Agent messaging strategy
├── dist/               # Compiled JavaScript
├── index.ts            # Plugin entry point
├── setup-entry.ts      # Setup wizard entry
├── openclaw.plugin.json # Plugin metadata & GUI config
├── package.json
└── tsconfig.json
```

## Troubleshooting

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

- **v3.1** — Multi-account setup wizard; dmPolicy/dmSecurity→dmPolicy+pairing (OpenClaw standard); bilingual prompts; credential shouldPrompt skips configured steps; clean multi-account config migration
- **v3.0** — Add `lansenger_send_format_text` tool (Markdown + @mention); rewrite SKILL.md; fix headStatusInfo description+colour semantics
- **v2.10** — font-size px→pt auto-conversion; sendImageUrl error classification; tool registration logging
- **v2.9** — Status adapter; env var fallback; uiHints; README cleanup (5 locales)
- **v2.8** — OpenClaw `bindings[]` multi-agent routing; groupPolicy/groupAllowFrom/groups access control; SKILL.md AgentSkills spec
- **v2.7** — Plain-object tool registration; runtime state for client/target
- **v2.6** — Register tools unconditionally; removed phantom delete_message
- **v2.5** — formatText reminder; appArticles `summary`; revoke chatType bot/group only
- **v2.4** — Fix message body assembly; appArticles/linkCard field fixes
- **v2.3** — Remove legacy group/private send; all routing via msgTarget
- **v2.2** — Add 9 agent tools
- **v2.0** — Initial release

## License

MIT — see [LICENSE](LICENSE).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npx vitest run`
5. Submit a pull request