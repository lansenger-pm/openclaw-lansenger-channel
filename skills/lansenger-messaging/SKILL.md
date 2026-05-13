---
name: lansenger-messaging
version: 2.1.0
category: communication
description: How to communicate effectively on Lansenger (蓝信) — message types, formatting rules, media, cards, approvals, and pitfalls
trigger: When the current session channel is lansenger, or when you need to send a message, file, image, card, or approval via Lansenger
---

# Lansenger (蓝信) Messaging Guide for Agents

You are communicating on Lansenger, an enterprise messaging platform. Understanding its message type rules is critical — choosing the wrong type causes silent feature loss (Markdown ignored, attachments dropped, @mentions invisible).

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
- **Need @mention** → Markdown won't work. You must use plain text only. If you need both formatting AND @mention, send the formatted content first, then a separate plain-text message with the @mention.
- **Need to attach a file/image/video** → Markdown won't work. Caption must be plain text. If you need both formatting AND an attachment, send the formatted content first, then a separate message with the file.
- **Never put raw Markdown in a plain-text message** — it displays as ugly source code to the user.

## DM vs Group

The plugin automatically routes to the right API:
- **DM (1:1 chat)** → private message endpoint
- **Group chat** → group message endpoint
- You don't need to specify which — it's detected from the session

## Rich Content Types

Beyond plain text and Markdown, Lansenger supports these special message types:

### Link Card
A rich link preview card. Requires `title` + `link`. Optional: description, icon_link, from_name.

### AppCard (Approval / Interactive Card)
Dynamic card with buttons (approve/deny). Used for the approval system.
- Supports div-style HTML in body fields (color, font-size, text-align, text-indent)
- ⚠️ **`text-indent` MUST have units** — bare `0` causes silent API failure; always use `0em`
- ⚠️ **Dynamic cards (`isDynamic=true`) require `headStatusInfo`** — API rejects without it; plugin auto-fills "Active" default if omitted
- Card content should be **single-language** based on the user's detected language (Chinese for CJK users, English otherwise) — appCard does NOT support i18n multi-locale rendering

### i18nAppCard (Multi-language Card)
For non-approval cards where you need 5-locale rendering (zhHans, zhHant, zhHantHK, en, fr). Does NOT support dynamic updates or headStatusInfo.

### AppArticles
Multi-article card with title, description, imgUrl, url per article. Optional: sourceName, sourceIcon.

## Approval Workflow

The plugin integrates with OpenClaw's approval system. When a high-risk action needs approval:

1. **Pending card** sent to the user — with approve/deny buttons
2. **User clicks a button** → approval/denial processed by OpenClaw runtime
3. **Card updates in-place** — status badge changes (Pending → Approved/Denied), color changes, card locks on final decision

Card status text is language-aware:
- Chinese users see: 待审批 → 已批准 / 已拒绝
- English users see: Pending → Approved / Denied

Language is detected from the user's message content (CJK character ratio ≥ 0.6 = Chinese).

## What You Receive (Inbound Messages)

When users message you on Lansenger, you receive:

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

When files are attached, they're downloaded to local temp paths. Use the `read` tool to view images, the appropriate tool to process other files.

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

Binding is **config-based** — set `agentId` per account in config. OpenClaw's `bindings[]` route format also works for dynamic routing.

## DM Security

Default policy is **paired** — the first DM from a new user triggers a pairing code. The user must get approval from the bot owner via:
```
openclaw pairing approve lansenger <code>
```

This is the correct model for personal bots — they only receive DMs from approved users.

## Sending Files to Users (CRITICAL)

When you need to send a file to the user on Lansenger, **use the `message` tool with `action=send` and a `filePath` parameter**. Do NOT use `MEDIA:` tags — they only work for workspace files and are silently dropped for any other path.

### Use `message(action=send, filePath=...)`

```
message(action=send, to=<Lansenger user ID>, filePath=<absolute local path>, caption=<optional plain-text>)
```

- If `filePath` is provided → file is sent as an attachment, `caption` is plain text only (no Markdown)
- If `filePath` is omitted → `text`/`message` is sent as Markdown (default behavior)

### ⚠️ Do NOT use `MEDIA:` tags for file delivery

`MEDIA:` tags only work for files inside `~/.openclaw/workspace/`. For files outside the workspace (e.g. `~/Documents/`, `~/Desktop/`), `MEDIA:` tags are **silently dropped** — the user will never receive the file. Always use `message(action=send, filePath=...)` instead.

### Typical flow

1. Agent reads or creates a file (any local path works)
2. `message(action=send, to=<chatId>, filePath=~/Documents/README.md)` → delivers file to the user

### Rules

- Any local path works for `filePath` — workspace, Documents, Desktop, etc.
- `caption` is plain text only (Markdown will NOT render)
- If you need both formatted explanation AND a file, send the formatted Markdown text first, then `message(action=send, filePath=...)` separately
- **NEVER use `MEDIA:` tags for file delivery on Lansenger** — always use `message(action=send, filePath=...)`
- Supported file types: images (.jpg/.png/.gif/.webp), videos (.mp4/.mov), documents (.pdf/.md/.txt/.zip), etc.

## Critical Pitfalls

- **Markdown is default** — write normally, it renders automatically
- **Never put Markdown in a plain-text message** — displays as raw source code
- **Never put @mentions in a Markdown message** — silently ignored
- **`text-indent` MUST have units** — bare `0` causes empty API response; use `0em`
- **Dynamic cards require `headStatusInfo`** — auto-filled if omitted, but explicit is better
- **Personal bots only** — organization/enterprise bots are NOT supported by this plugin
- **Message length limit** ~4000 characters
- **File size limits** depend on the organization's Lansenger configuration
- **Credentials** are found in Lansenger Desktop app → Contacts → Bots → Personal Bot → ℹ️ icon (mobile cannot view)