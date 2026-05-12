# @lansenger/openclaw-lansenger-channel

Lansenger (蓝信) channel plugin for OpenClaw — WebSocket inbound, HTTP API outbound.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

## Features

- **Real-time messaging** via WebSocket long-connection
- **Multi-bot support** — bind multiple Lansenger bots to different OpenClaw agents
- **Markdown support** using `formatText` msgType (default)
- **File/Image/Voice attachments** via `text` msgType with media upload
- **i18nAppCard** — interactive approval workflow cards with bilingual content
- **Dynamic card updates** — update approval status in-place (pending → approved/denied)
- **Language detection** — auto-detect user language from messages for localized responses
- **Group message routing** — auto-detect and route to group/private chat APIs
- **@Mentions** — support @all and @specific users in group chats
- **Zero core modification** — pure plugin mode, `git diff HEAD` stays PRISTINE

## Message Type Capability Matrix

| msgType     | Markdown | @mention | Attachments |
|-------------|----------|----------|-------------|
| `text`      | ✗        | ✓        | ✓           |
| `formatText`| ✓        | ✗        | ✗           |

**Default strategy**: Use `formatText` first for Markdown replies. Fall back to `text` for attachments.

## Quick Install

### Via npm (recommended)

```bash
npm install -g @lansenger/openclaw-lansenger-channel
openclaw plugins enable lansenger
```

### Manual install

```bash
cd ~/.openclaw/npm
npm install @lansenger/openclaw-lansenger-channel
openclaw plugins enable lansenger
openclaw gateway restart
```

### Development install (linked)

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw plugins enable lansenger
openclaw gateway restart
```

## Configuration

### Required Environment Variables

Add these to `~/.openclaw/.env` or your environment:

| Variable | Description | Example |
|----------|-------------|---------|
| `LANSENGER_APP_ID` | Personal bot App ID | `2285568-10117376` |
| `LANSENGER_APP_SECRET` | Personal bot App Secret | `57E718CA1CAC20F2...` |

### Get Credentials

**Lansenger Desktop** → **Contacts** → **Bots** → **Personal Bots** → click **ℹ️** icon

> ⚠️ **Mobile client does NOT support viewing credentials.** Use the desktop client only.

### Optional Configuration

```json
{
  "channels": {
    "lansenger": {
      "appId": "2285568-10117376",
      "appSecret": "your-secret",
      "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw",
      "allowFrom": ["2285568-xxx"],
      "dmSecurity": "allowlist",
      "accounts": {
        "2285568-10117376": {
          "appId": "2285568-10117376",
          "appSecret": "...",
          "agentId": "main",
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
| `allowFrom` | User IDs allowed to DM the bot | `[]` |
| `dmSecurity` | DM policy: `allowlist`, `open`, `paired` | `allowlist` |
| `accounts` | Multi-bot configuration | — |

### Multi-Bot Configuration

Each bot can be bound to a different OpenClaw agent:

```json
{
  "channels": {
    "lansenger": {
      "accounts": {
        "bot1-appid": {
          "appId": "2285568-xxx",
          "appSecret": "...",
          "agentId": "main-agent",
          "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw"
        },
        "bot2-appid": {
          "appId": "524288-yyy",
          "appSecret": "...",
          "agentId": "test-agent"
        }
      }
    }
  },
  "bindings": [
    { "match": { "channel": "lansenger", "accountId": "bot1-appid" }, "agentId": "main-agent" }
  ]
}
```

## Usage

### Start the gateway

```bash
openclaw gateway call lansenger.start
```

### Check status

```bash
openclaw channels status
# or
openclaw gateway call lansenger.status
```

### Bind a bot to an agent (dynamic)

```bash
openclaw gateway call lansenger.bind '{"botId":"2285668-xxx","agentId":"main"}'
```

### List bindings

```bash
openclaw gateway call lansenger.bindings
```

### Unbind a bot

```bash
openclaw gateway call lansenger.unbind '{"botId":"2285568-xxx"}'
```

## Supported Message Types

| Type | Description | API Method |
|------|-------------|------------|
| `text` | Plain text with optional @mentions and attachments | `sendText()` |
| `formatText` | Markdown-formatted text (default) | `sendFormatText()` |
| `image` | Image with optional caption | `sendFile()` |
| `file` | Any file attachment | `sendFile()` |
| `video` | Video attachment | `sendFile()` |
| `voice` | Voice message | `sendFile()` |
| `linkCard` | Rich link preview card | `sendLinkCard()` |
| `i18nAppCard` | Interactive approval card (bilingual) | `sendI18nAppCard()` |
| `appCard` | Dynamic app card with status updates | `sendAppCard()` |
| `appArticles` | Multi-article card (图文卡片) | `sendAppArticles()` |

## Approval Workflow

OpenClaw uses Lansenger's **i18nAppCard** for approval workflows:

- Approval requests appear as interactive cards
- Bilingual content (Chinese + English)
- Dynamic status updates (pending → approved/denied)
- Only users in `allowFrom` can approve

## Development

### Build

```bash
npm install
npm run build  # or npx tsc
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
│   ├── client.ts       # Lansenger API client
│   ├── channel.ts      # OpenClaw channel plugin
│   ├── runtime.ts      # Gateway runtime
│   └── bindings.ts     # Multi-bot binding manager
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # Agent messaging strategy
├── dist/               # Compiled JavaScript
├── index.ts            # Plugin entry point
├── setup-entry.ts      # Setup wizard entry
├── openclaw.plugin.json # Plugin metadata
├── package.json
└── tsconfig.json
```

## Troubleshooting

### "Mobile client does NOT support viewing credentials"

Use the **Lansenger Desktop** client only. The mobile app does not display bot credentials.

### "No binding for botId"

Run `lansenger.bind` to bind the bot to an agent, or configure `agentId` in the account config.

### WebSocket disconnects

The plugin includes automatic reconnection with exponential backoff (2s, 5s, 10s, 30s, 60s) and heartbeat (ping every 30s).

### formatText vs text

- Use `formatText` for Markdown replies (default)
- Use `text` for @mentions or attachments
- For both, send two separate messages

## License

MIT — see [LICENSE](LICENSE).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npx vitest run`
5. Submit a pull request
