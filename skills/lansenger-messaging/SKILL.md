---
name: lansenger-messaging
version: 1.1.0
category: communication
description: Lansenger (蓝信) messaging strategy — text/formatText boundaries, group routing, media handling, dynamic cards, multi-bot binding, @mentions, language detection, and approval workflows
trigger: When you need to send any message, file, image, or notification via Lansenger, or when the current session channel is lansenger, or when handling inbound media files, approval cards, or group messages.
---

# Lansenger Messaging Strategy

Lansenger has two distinct outbound message types with different capabilities. Picking the wrong type causes feature loss (e.g., Markdown silently ignored, attachments dropped). The plugin also handles group vs DM routing, inbound media download, dynamic card updates, multi-bot binding, and language-aware card rendering.

## Outbound Message Type Capability Matrix

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  msgType     │  Markdown    │  @mention    │  Attachments │
├──────────────┼──────────────┼──────────────┤──────────────┤
│  text        │  ✗           │  ✓           │  ✓           │
│  formatText  │  ✓           │  ✗           │  ✗           │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

## Default Strategy: formatText First, text Fallback

The outbound `deliverReply` function uses this priority:

1. **formatText** (Markdown rendered) → sent first
2. **text** (plain) → fallback if formatText fails

Group messages follow the same priority using `sendGroupFormatText` → `sendGroupText`.

### DM vs Group Routing

The plugin automatically routes outbound replies:
- **DM** → `sendFormatText` / `sendText` (private message API `/v1/bot/messages/create`)
- **Group** → `sendGroupFormatText` / `sendGroupText` (group message API `/v1/messages/group/create`)
- Chat type is cached per `chatId` on inbound events
- `chatId` starting with `group:` is always treated as group

## Decision Tree

### 1. Markdown-formatted text (code, tables, lists, bold, etc.)
→ **formatText (default)** — sent automatically by `deliverReply`
- Supports: headings, bold, italic, code blocks, lists, links, tables
- Does NOT support: @mentions, file/image/video attachments

### 2. Plain text + file/image/video attachment
→ **text (msgType=text)** with `mediaType` + `mediaIds`
- caption = plain text only (Markdown NOT rendered)
- mediaType: 1=video, 2=image, 3=file
- Example: "Here is this week's report" + PDF file

### 3. Markdown text + attachment (need both)
→ **Send TWO separate messages:**
1. formatText for the formatted text
2. text with media for the file
- Reason: formatText cannot carry attachments

### 4. @mention someone in a group
→ **text (msgType=text)** with `reminder` parameter
- formatText does NOT support @mentions
- `reminder: { all: true }` — @all members
- `reminder: { userIds: ["id1", "id2"] }` — @specific users
- If you need Markdown + @mention, send formatText first, then text with reminder

### 5. Link card (rich link preview)
→ **linkCard** — `title` + `link` required, optional: description, icon_link, from_name

### 6. Approval / interactive card
→ **appCard** (with `isDynamic=true` + `headStatusInfo`) — dynamic approval card with /approve and /deny buttons
- Supports: div-style HTML formatting (color, font-size, text-align, text-indent)
- ⚠️ **`text-indent` values MUST have units** — bare `0` causes empty API response (content-length=0); use `0em` instead. Applies to all div-style fields.
- Fields: headTitle, bodyTitle, bodySubTitle, bodyContent, signature, fields, buttons, headStatusInfo
- **⚠️ `isDynamic=true` requires `headStatusInfo`** — API returns errCode 40060 without it. `sendAppCard()` auto-fills default "Active" status if missing.
- Language: send single-language content based on getUserLang() detection (NOT bilingual text)

### 7. i18nAppCard (reserved, not currently used for approval)
→ **i18nAppCard** — multilingual card (5 locales: zhHans, zhHant, zhHantHK, en, fr)
- Supports full i18n fields: i18nHeadTitle, i18nBodyTitle, i18nBodyContent, i18nSignature, i18nFields
- Does NOT support: dynamic updates, headStatusInfo
- Reserved for future use when per-locale rendering is needed

### 8. Article list card
→ **appArticles** — multi-article card, each with title, description, imgUrl, url
- Optional: sourceName, sourceIcon

## Inbound Media Handling

When users send images, videos, files, or voice messages, the plugin:

1. **Downloads all `mediaIds`** via `downloadAllMedia()` → saves to temp files
2. **Detects file extension** from Content-Type/Content-Disposition headers (falls back to magic bytes: PDF `\x25\x50\x44\x46`, ZIP `PK\x03\x04`, WAV `RIFF....WAVE`, etc.)
3. **Attaches file paths** to `InboundEvent.mediaPaths[]`
4. **Adds hint text** to agent input: "Attached files saved locally — use the read tool to view"

### Inbound Message Types

```
┌──────────────┬──────────────────────────────────────────────────────┐
│  msgType     │  Agent receives                                      │
├──────────────┼──────────────────────────────────────────────────────┤
│  text        │  Plain text content                                  │
│  formatText  │  Markdown text content                               │
│  image       │  "[Image]" or "[Image: N files]" + media paths      │
│  video       │  "[Video]" or "[Video: N files]" + media paths      │
│  file        │  "[File]" or "[File: N files]" + media paths        │
│  voice       │  "[Voice]" + media paths (AMR/WAV)                  │
│  position    │  "[Location] name address lat,long link"             │
│  card        │  "[Contact Card] staffId"                            │
│  sticker     │  "[Sticker] stickerId"                               │
└──────────────┴──────────────────────────────────────────────────────┘
```

### Multi-image/file messages

- A single inbound message can contain multiple `mediaIds` (e.g., 3 images in one message)
- Label format: `[Image: 3 files]`, `[Video: 2 files]`, etc.
- Each mediaId is downloaded separately, all paths listed in `mediaPaths`

## Dynamic Card Updates (Approval Status)

Three card types serve different purposes — **appCard is used for approval**:

| Card Type | Multi-language | Dynamic Update | headStatusInfo | Current Usage |
|-----------|---------------|---------------|---------------|---------------|
| i18nAppCard | ✓ (5 locales) | ✗ | ✗ | Reserved for future |
| appCard | ✗ | ✓ (isDynamic) | ✓ | Approval cards |
| DynamicMsg appCard | ✗ | ✓ (appCardUpdateMsg) | ✓ | Approval status updates |

### Initial Send (appCard)
- `msgType: "appCard"` with `isDynamic=true` + `headStatusInfo` (pending status)
- Uses `sendAppCard()` with full `AppCardData` fields (bodyTitle, bodyContent, signature, fields, etc.)
- Content uses single-language text selected by getUserLang() since appCard does NOT support i18n per-locale rendering
- **⚠️ `text-indent` values MUST have units** — bare `0` causes empty API response; use `0em`
- **⚠️ `isDynamic=true` requires `headStatusInfo`** — auto-filled with "Active" default if omitted

### Status Update (DynamicMsg appCard)
- `msgType: "appCard"` with `appCardUpdateMsg` — NOT a new card, updates existing card in-place
- Uses `updateCardStatus()` with `headStatusInfo`:
  - `isLastUpdate: true` when approved/denied (locks the card, no further updates)
  - `isLastUpdate: false` when still pending (allows future updates within 30 days)
  - `headStatusInfo.description` — div-style HTML status badge (e.g. `<div style="color:#198754;text-align:left">已批准</div>`)
  - `headStatusInfo.colour` — colored circle indicator

### Language-Aware Updates

The plugin detects user language from inbound text:
- **CJK ratio ≥ 0.6** → "zh" (Chinese)
- **CJK ratio < 0.6** → "en" (English)
- Language cached per `senderId` in `userLangMap`
- Status text uses detected language: "待审批/已批准/已拒绝" (zh) or "Pending/Approved/Denied" (en)

## Multi-Bot Binding

The plugin supports multiple Lansenger bots bound to different OpenClaw agents:

### Configuration
```json
{
  "channels": {
    "lansenger": {
      "accounts": {
        "bot-alpha": { "appId": "xxx", "appSecret": "yyy", "agentId": "security-agent" },
        "bot-beta":  { "appId": "aaa", "appSecret": "bbb", "agentId": "hr-agent" }
      }
    }
  }
}
```
- Account key = `appId` (NOT `__default__` or custom names)
- `accountId` in OpenClaw = the appId

### Gateway Methods

| Method | Description |
|--------|-------------|
| `lansenger.start` | Connect WebSocket for a bot account (params: accountId) |
| `lansenger.stop` | Disconnect a bot (params: accountId) |
| `lansenger.bind` | Bind botId → agentId (params: botId, agentId) |
| `lansenger.unbind` | Remove binding (params: botId) |
| `lansenger.bindings` | List all bindings |
| `lansenger.status` | Show running accounts |
| `lansenger.sendCard` | Send test appCard (params: chatId, lang) |
| `lansenger.updateCard` | Update card status (params: messageId, status, lang) |

### Binding Resolution
- Inbound messages resolve `agentId` from: BindingManager → account config → "default"
- Each inbound turn passes `agentId` to session store for correct agent routing

## Revocation

- **Must use `chatType="bot"`** for revoking bot messages (NOT "staff")
- "staff" chatType requires `senderId` and only works for staff-sent messages
- Revocation shows a fixed system message — the text cannot be customized

## Key Reminders

- **formatText is the default** — you don't need to do anything special for Markdown output
- **Never put Markdown in a text-type caption** — it will display as raw text
- **Never put @mentions in a formatText message** — they will be silently ignored
- **DM security default is pairing** — first DM triggers pairing code; approve with `openclaw pairing approve lansenger <code>`. Personal bots only receive DMs from their owner, so pairing is the correct model (not allowlist).
- **File size limits** determined by organization's Lansenger configuration
- **Message length limit** ~4000 characters for both text and formatText
- **Revocation** always uses `chatType="bot"` for bot messages
- **Dynamic card updates** use `updateCardStatus()` with `headStatusInfo` (NOT i18nAppCard)
- **`text-indent` values MUST have units** — bare `0` causes empty API response; always use `0em`
- **`isDynamic=true` requires `headStatusInfo`** — auto-filled with "Active" default if omitted
- **Personal bots only** — organization bots are NOT supported
- **Credentials path**: Lansenger Desktop → Contacts → Bots → Personal Bot → ℹ️ icon (mobile cannot view credentials)
- **Default gateway**: `https://open.e.lanxin.cn/open/apigw` (Lansenger public cloud)
- **Group API**: `/v1/messages/group/create` (different endpoint from DM `/v1/bot/messages/create`)