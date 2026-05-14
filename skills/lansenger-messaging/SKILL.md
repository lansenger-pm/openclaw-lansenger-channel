---
name: lansenger-messaging
version: 2.3.0
category: communication
description: How to communicate effectively on Lansenger (蓝信) — message types, formatting rules, media, cards, approvals, and pitfalls
trigger: When the current session channel is lansenger, or when you need to send a message, file, image, card, or approval via Lansenger
---

# Lansenger (蓝信) Messaging Guide for Agents

You are communicating on Lansenger, an enterprise messaging platform. Understanding its message type rules is critical — choosing the wrong type causes silent feature loss (Markdown ignored, attachments dropped, @mentions invisible).

**This SKILL is reference documentation, NOT a CLI command.** Do NOT generate commands like `openclaw skill lansenger-messaging --message ...` — that command does not exist and will fail. To send messages, use the agent tools (`lansenger_send_file`, `lansenger_send_text`, etc.) directly.

## Auto-Routing: msgTarget(chatId)

All outbound methods use the `msgTarget` helper internally — **no separate group/private methods exist**. Just pass the chatId and routing happens automatically:

- Group chatId → `/v1/messages/group/create` (payload wrapped with `groupId`)
- Private chatId → `/v1/bot/messages/create` (payload wrapped with `userIdList`)
- Detection: `chatTypeMap.get(chatId) === "group"` OR `chatId.startsWith("group:")`

## The #1 Rule: Markdown Is Automatic

When you write a reply in a Lansenger session, **your Markdown is automatically rendered**. You don't need to pick a message type or call any special function — just write normally with headings, bold, code blocks, lists, tables, links, etc. The plugin handles delivery.

**However**, Markdown and other features are mutually exclusive. See below.

## Message Type Rules (Critical)

Lansenger has two outbound text types that cannot be combined:

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Type        │  Markdown    │  @mention    │  Attachments │
├──────────────┼──────────────┼──────────────┤──────────────┤
│  formatText  │  ✓ (default) │  ✗           │  ✗           │
│  text        │  ✗           │  ✓           │  ✓           │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

### What this means for you

- **Normal replies** → just write Markdown. It's automatically sent as formatText.
- **@mention is optional, but recommended in group chat** → In group chat, @mention the person you're replying to so they know the message is directed at them. When using reminder, include "@姓名" in the text. Example: `"@张三 明天开会"` with `reminderUserIds: ["staffId-of-张三"]`. Old API silently accepts reminder but won't show notification — the "@姓名" in text ensures clarity regardless.
- **Need to attach a file/image/video** → Markdown won't work. Use `lansenger_send_file`. If you need both formatting AND a file, send the Markdown reply first, then call `lansenger_send_file` separately.
- **Never put raw Markdown in a plain-text message** — it displays as ugly source code to the user.

## Available Tools

| Tool | Purpose | Message Type |
|------|---------|-------------|
| `lansenger_send_file` | Send a local file/image/video | text (with attachment) |
| `lansenger_send_text` | Send plain text with optional attachment + @mentions | text |
| `lansenger_send_image_url` | Send an image from a URL | text (with attachment) |
| `lansenger_send_link_card` | Send a link preview card | linkCard |
| `lansenger_send_app_articles` | Send a multi-article card (图文卡片) | appArticles |
| `lansenger_send_app_card` | Send a rich formatted card (应用卡片) | appCard |
| `lansenger_update_dynamic_card` | Update a dynamic card's status | dynamic update |
| `lansenger_revoke_message` | Revoke previously sent messages | — |
| `lansenger_query_groups` | List bot's group IDs | — |

All tools accept an optional `to` parameter (chat ID). **LEAVE EMPTY** to auto-detect the current conversation target — only fill it if you need to send to a different chat. chatId is case-sensitive.

## DM vs Group

The plugin auto-routes via `msgTarget(chatId)` — you never need to specify which endpoint:
- **DM (1:1 chat)** → private message endpoint (`userIdList: [chatId]`)
- **Group chat** → group message endpoint (`groupId: chatId`)
- Detection is automatic from session context or `group:` prefix in chatId

**Group API limitation**: The Lansenger group endpoint (4.6.2) officially only supports `text` and `oacard` msgTypes. The plugin routes all msgTypes via msgTarget, but `appCard`, `linkCard`, `appArticles`, `formatText` may be rejected by the API in group context. If a group send fails, try falling back to plain text.

## Sending Files

Two ways to send files, depending on location:

1. **Workspace files** → MEDIA: tags work fine. The plugin's `delivery.deliver` processes `payload.mediaUrls` and sends them via `client.sendFile`. Just write normally and reference files with MEDIA: syntax.

2. **Non-workspace files** (Documents, Desktop, /tmp, external paths) → MEDIA: tags are silently dropped by `mediaLocalRoots` restrictions. Use `lansenger_send_file` instead:

```
lansenger_send_file(filePath=<absolute local path>, caption=<optional plain-text>, to=<optional chatId>)
```

- Any local path works — workspace, Documents, Desktop, /tmp, etc.
- `caption` is plain text only (Markdown will NOT render)
- If you need both formatted explanation AND a file, send the Markdown reply first, then call `lansenger_send_file` separately

## Sending Text with Attachments or @Mentions

When you need plain text + attachment or @mentions in group chat, use `lansenger_send_text`:

```
lansenger_send_text(content=<plain text>, filePath=<optional local path>, to=<optional chatId>,
                    reminderAll=<bool>, reminderUserIds=<list>)
```

- **NO Markdown** — content is plain text only
- `filePath` optional — if provided, content becomes caption for the attachment
- `reminderAll` / `reminderUserIds` — optional @mention. In group chat, recommended to @mention the person you're replying to so they know the message is for them. When using reminder, include "@姓名" in the text. (works in both DM and group, but usually only needed in group)

## Sending Images from URLs

```
lansenger_send_image_url(imageUrl=<URL>, caption=<optional plain-text>, to=<optional chatId>)
```

Downloads the image first, then uploads and sends. For local files, use `lansenger_send_file` instead.

## Rich Content Types

### Link Card (`lansenger_send_link_card`)
A rich link preview card. Requires `title` + `link`. Optional: `description`, `iconLink`, `pcLink`, `fromName`, `fromIconLink`.

### AppArticles (`lansenger_send_app_articles`)
Multi-article card (图文卡片). Each article needs `imgUrl`, `title`, `url`. Optional: `description` (article summary), `pcUrl` (PC link).

### AppCard (`lansenger_send_app_card`)
Rich formatted card (应用卡片). Supports div-style HTML in body fields (color, font-size, text-align, text-indent).
- ⚠️ **`text-indent` MUST have units** — bare `0` causes silent API failure; always use `0em`
- ⚠️ **Dynamic cards (`isDynamic=true`) require `headStatusInfo`** — plugin auto-fills "Active" default if omitted
- Card content should be **single-language** based on user's detected language
- Optional: `headTitle`, `bodySubTitle`, `signature`, `fields` (key-value pairs, max 10), `links` (max 3), `cardLink`, `staffId`, `headIconUrl`

### i18nAppCard
Internal method only — no agent tool exposes this. For non-approval cards needing 5-locale rendering. Does NOT support dynamic updates.

## Approval Workflow

The plugin integrates with OpenClaw's approval system:

1. **Pending card** sent via `lansenger_send_app_card` (isDynamic=true)
2. **User clicks approve/deny** → approval processed by OpenClaw runtime
3. **Card updates in-place** via `lansenger_update_dynamic_card` — status badge changes, card locks on final decision

Card status text is language-aware (CJK ratio ≥ 0.6 = Chinese).

## Revoking Messages

```
lansenger_revoke_message(messageIds=<list of IDs>, chatType=<bot|group>, senderId=<optional>)

For group chat, `senderId` is required.

## Querying Groups

```
lansenger_query_groups(pageOffset=<1>, pageSize=<100>)
```

Returns `totalGroupIds` (count) and `groupIds` (list). Use to discover group chat IDs before sending messages to groups.

## What You Receive (Inbound Messages)

| Type | What you see |
|------|-------------|
| text | Plain text content |
| formatText | Markdown text content |
| image | `[Image]` or `[Image: 3 files]` + local file paths |
| video | `[Video]` or `[Video: 2 files]` + local file paths |
| file | `[File]` or `[File: 2 files]` + local file paths |
| voice | `[Voice]` + local file path (AMR/WAV) |
| position | `[Location] name address lat,long link` |
| card | `[Contact Card] staffId` |
| sticker | `[Sticker] stickerId` |

## Multi-Bot / Agent Binding

Multiple Lansenger bots can run simultaneously, each bound to a different OpenClaw agent:

```json
{
  "channels": {
    "lansenger": {
      "accounts": {
        "bot-alpha": { "appId": "xxx", "agentId": "security-agent" },
        "bot-beta":  { "appId": "aaa", "agentId": "hr-agent" }
      }
    }
  }
}
```

Binding is **config-based** — set `agentId` per account in config.

## DM Security

Default policy is **paired** — the first DM from a new user triggers a pairing code. The user must get approval via:
```
openclaw pairing approve lansenger <code>
```

## Critical Pitfalls

- **Markdown is default** — write normally, it renders automatically
- **Never put Markdown in a plain-text message** — displays as raw source code
- **@mention in group chat is recommended** — when replying to someone in a group, @mention them so they know the message is for them; include "@姓名" in the text
- **MEDIA: tags work for workspace files** — for non-workspace paths (Documents, /tmp, etc.), use `lansenger_send_file` instead
- **AppArticles uses `description` not `summary`** — the article description field is called `description`, not `summary`
- **`text-indent` MUST have units** — bare `0` causes empty API response; use `0em`
- **Dynamic cards require `headStatusInfo`** — auto-filled if omitted, but explicit is better
- **Gateway URL is per-environment** — the plugin uses whatever `apiGatewayUrl` is configured (e.g. `https://apigw.lx.qianxin.com` for 奇安信 environments, or `https://open.e.lanxin.cn/open/apigw` for standard Lansenger). All API endpoints are appended to this base URL. Do NOT assume the default gateway — always use the configured value.
- **`openclaw skill` and `openclaw message lansenger` do NOT exist** — this SKILL is documentation only, not a CLI command. Third-party plugin channels are not in `openclaw message send --channel`. To send messages, use agent tools directly.
- **Message length limit** ~4000 characters
- **File size limits** depend on organization's Lansenger configuration
- **Credentials** in Lansenger Desktop → Contacts → Bots → Personal Bot → ℹ️ icon