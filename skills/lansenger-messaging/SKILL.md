---
name: lansenger-messaging
description: How to communicate on Lansenger (蓝信) — choose the right tool, when, send rich content, and pitfalls
metadata: {"openclaw":{"requires":{"config":["channels.lansenger"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) Messaging — Agent Quick Reference

You are on Lansenger. This skill tells you **what tool to use, when, and how**.

> ⚠️ This is reference documentation, NOT a CLI command. `openclaw skill lansenger-messaging` does not exist. Use the agent tools listed below directly.

---

## Quick Decision: What Tool Do I Use?
```
Need to send something? Follow this decision tree:

1. Normal reply with formatting (bold, lists, code, tables) → JUST WRITE IT. Markdown renders automatically. No tool needed.
2. Need Markdown + @mention someone → lansenger_send_format_text (with reminder)
3. Need plain text + @mention + file → lansenger_send_text (with reminder + filePath)
4. Need just a FILE (any local file) → lansenger_send_file
5. Need image from URL → lansenger_send_image_url
6. Need a link card → lansenger_send_link_card
7. Need multi-article card (图文) → lansenger_send_app_articles
8. Need a rich formatted card → lansenger_send_app_card
9. Need approval workflow → lansenger_send_app_card (isDynamic=true) → update via lansenger_update_dynamic_card
10. Need to revoke a message → lansenger_revoke_message
11. Need group IDs → lansenger_query_groups
```
> ⚠️ Group chat: appCard/linkCard/appArticles/formatText may be rejected by API. Fall back to lansenger_send_text.
```
---

## #1 Rule: Markdown Is Automatic
In a Lansenger session, **just write your reply normally** — Markdown is automatically rendered as formatText. You never need to call a tool for formatted text unless you also need @mentions.

However: Markdown and file attachments are **mutually exclusive**. If you need both formatting AND a file, send the Markdown reply first, then call `lansenger_send_file separately.
Never put raw Markdown in lansenger_send_text — it displays as ugly source code.

---

## Message Type Capability Matrix
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Type        │  Markdown    │  @mention    │  Attachments │
├──────────────┼──────────────┼──────────────┼──────────────┤
│  formatText  │  ✓ (auto)    │  ✓ (reminder)│  ✗           │
│  text        │  ✗           │  ✓           │  ✓           │
└──────────────┴──────────────┴──────────────┴──────────────┘
```
- formatText: default outbound type. Markdown renders automatically. Also supports @mentions via `reminder` param (auto-fallback if API rejects). No file attachments.
- text: plain text only. Supports @mentions + file attachments. No Markdown rendering.

- These two types are **mutually exclusive** — pick one based on what you need.
```
---

## Tool Reference
All tools accept optional `to` (chatId). Leave empty to auto-detect current conversation. Only fill for different chat. chatId is case-sensitive.
```
How to get chatId: Inbound message senderId/conversationId. Never truncate or modify a chatId.

```
---

### lansenger_send_file
| Param | Required | Description |
|-------|----------|-------------|
| filePath | ✅ | Absolute local path (workspace, /tmp, Desktop, etc.) |
| caption | ❌ | Plain-text caption (no Markdown) |
| to | ❌ | Target chatId (auto if omitted) |
> Use this instead of MEDIA: tags for non-workspace files. MEDIA: silently fails outside workspace.

### lansenger_send_text
| Param | Required | Description |
|-------|----------|-------------|
| content | ✅ | Plain text only (NO Markdown) |
| filePath | ❌ | Optional file to attach (content becomes caption) |
| to | ❌ | Target chatId |
| reminderAll | ❌ | @mention all members (group only) |
| reminderUserIds | ❌ | @mention specific users (group only) |

### lansenger_send_format_text
| Param | Required | Description |
|-------|----------|-------------|
| content | ✅ | Markdown text |
| to | ❌ | Target chatId |
| reminderAll | ❌ | @mention all (group only) |
| reminderUserIds | ❌ | @mention specific users (group only) |

> Use when you need Markdown + @mention. No file attachments. Plugin auto-fallback if API rejects reminder.

Always include "@姓名" in text when mentioning someone.

### lansenger_send_image_url
| Param | Required | Description |
|-------|----------|-------------|
| imageUrl | ✅ | Directly reachable image URL |
| caption | ❌ | Plain-text caption (no Markdown) |
| to | ❌ | Target chatId |

> URL must be reachable from gateway host. For local files use lansenger_send_file.

### lansenger_send_link_card
| Param | Required | Description |
|-------|----------|-------------|
| title | ✅ | Card title |
| link | ✅ | Click-through URL |
| description | ❌ | Card description (API-required, defaults empty) |
| iconLink | ❌ | Icon URL (defaults empty) |
| fromName | ❌ | Source name (defaults empty) |
| fromIconLink | ❌ | Source icon URL (defaults empty) |
| to | ❌ | Target chatId |

### lansenger_send_app_articles
| Param | Required | Description |
|-------|----------|-------------|
| articles | ✅ | Each: { imgUrl, title, url, summary? } |
| to | ❌ | Target chatId |

> ⚠️ Article summary field is `summary`, NOT `description`. `description` is silently ignored.

### lansenger_send_app_card
| Param | Required | Description |
|-------|----------|-------------|
| bodyTitle | ✅ | Card title (supports div-style) |
| headTitle | ❌ | Header title |
| bodyContent | ❌ | Content (supports div-style) |
| isDynamic | ❌ | Enable approval workflow (default: false) |
| headStatusInfo | ❌ | { description, colour } — description is status TEXT (supports div-style for color, e.g. `<div style="color:#FFB116">待审批</div>`, max 30 bytes), colour is the DOT/圆点 color (hex, e.g. #FFB116). These are TWO different things: text color vs dot color. |
| fields | ❌ | Key-value pairs (max 10) |
| links | ❌ | Links (max 3) |
| to | ❌ | Target chatId |

> ⚠️ **Group chat does NOT support appCard** — falls back to plain text. Approval workflows won't work in group chat.

```
---

div-style formatting rules:
- `color`: hex (e.g. #333, #007BFF)
- `font-size`: **MUST use pt** (12pt–36pt). px causes "invalid bodyContent" error.
- `text-align`: left, center, right
- `text-indent`: **MUST use 0em** — bare 0 causes silent failure
```

Example: `<div style="color:#333;font-size:14pt;text-indent:0em;text-align:left">Content here</div>`
```
---

### lansenger_update_dynamic_card
| Param | Required | Description |
|-------|----------|-------------|
| msgId | ✅ | Message ID from original send_app_card response |
| headStatusInfo | ❌ | { description, colour } — description is text (supports div-style for color; `<div style="color:#198754">已批准</div>`), max 30 bytes. colour is the DOT/圆点 color (hex like #198754). These are TWO different things: text color vs dot color. |
| isLastUpdate | ❌ | True = final state (default: false) |

> headStatusInfo.description supports div-style for coloring the text. headStatusInfo.colour controls the status dot color. They are independent.

### lansenger_revoke_message
| Param | Required | Description |
|-------|----------|-------------|
| messageIds | ✅ | List of message IDs |
| chatType | ❌ | bot (default) or group |
| senderId | ❌ | Required if chatType=group |

### lansenger_query_groups
| Param | Required | Description |
|-------|----------|-------------|
| pageOffset | ❌ | Page number (default: 1) |
| pageSize | ❌ | Groups per page (default: 100) |

> ⚠️ May return errCode=10005 "API服务无权限" on enterprise deployments. Ask user for group IDs manually.

---

## Approval Workflow Pattern
```
1. Send: lansenger_send_app_card(bodyTitle="...", isDynamic=true, headStatusInfo={description: '<div style="color:#FFB116">待审批</div>', colour: "#FFB116"})
2. User approves/denies → OpenClaw processes approval
3. Update: lansenger_update_dynamic_card(msgId="<from step 1>", headStatusInfo={description: '<div style="color:#198754">已批准</div>', colour: "#198754"}, isLastUpdate=true)
```
Status colors: #FFB116 (pending), #198754 (approved) #dc3545 (denied)

⚠️ **Approval only works in DM (1:1 chat)** — group chat de appCard falls back to plain text.

```
---

## @Mention Rules
Both formatText and text support @mentions:
- formatText: `reminderAll` + `reminderUserIds` params
- text: `reminderAll` + `reminderUserIds` params

Two rules:
1. Always include "@姓名" in message text — reminder sends the push, "@姓名" makes it visible
2. reminder is optional — use it in group chat when replying to someone so they notice your message

---

## Inbound Messages
| Type | What you see |
|------|-------------|
| text | Plain text |
| formatText | Markdown text |
| image | [Image] + local file paths |
| video | [Video] + local file paths |
| file | [File] + local file paths |
| voice | [Voice] + local file path |
| position | [Location] name address lat,long |
| card | [Contact Card] staffId |

---

## Common Pitfalls
| Pitfall | Fix |
|---------|-----|
| Raw Markdown in text tool | Never do this — shows as ugly source code. Write normally for Markdown. |
| MEDIA: tag for non-workspace file | Use lansenger_send_file. MEDIA: silently fails outside workspace. |
| AppArticles `description` field | Use `summary`, not `description`. `description` is ignored. |
| AppCard `font-size: 14px` | Use `font-size: 14pt`. px causes "invalid bodyContent". Range: 12pt–36pt. |
| AppCard `text-indent: 0` | Use `text-indent: 0em`. Bare 0 causes silent failure. |
| Dynamic card headStatusInfo div wrapping   │ description SUPPORTS div-style for color. colour is for the dot/圆点 only. They are separate. |
| Group chat appCard | Falls back to plain text. Approval workflows won't work. Use text + /approve. |
| Message too long | ~4000 character limit. Split long content into multiple messages. |
| `openclaw skill` command | Does NOT exist. Use agent tools directly. |