---
name: lansenger-messaging
description: How to communicate on Lansenger (蓝信) — choose the right tool, send rich content, approvals, and pitfalls
metadata: {"openclaw":{"requires":{"config":["channels.lansenger"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) Messaging — Agent Quick Reference

In a Lansenger session, **just write your reply normally** — Markdown renders automatically as formatText. No tool needed for formatted text unless you also need @mentions.

However, Markdown and file attachments are **mutually exclusive**. If you need both formatting AND a file, send the Markdown reply first, then call `lansenger_send_file` separately.

**Never put raw Markdown in lansenger_send_text** — it displays as ugly source code.

> ⚠️ This is reference documentation, NOT a CLI command. `openclaw skill lansenger-messaging` does not exist. Use the agent tools directly.

## Quick Decision: What Tool Do I Use?

Need to send something? Follow this decision tree:

1. Normal reply with formatting → JUST WRITE IT. No tool needed.
2. Markdown + @mention → lansenger_send_format_text (with reminder)
3. Plain text + @mention + file → lansenger_send_text (with reminder + filePath)
4. Send a FILE → lansenger_send_file
5. Send image from URL → lansenger_send_image_url
6. Link card → lansenger_send_link_card
7. Multi-article card (图文) → lansenger_send_app_articles
8. Rich formatted card → lansenger_send_app_card
9. Approval workflow → sendAppCard(isDynamic=true) → updateDynamicCard
10. Revoke a message → lansenger_revoke_message
11. Find group IDs → lansenger_query_groups

## Message Type Capability Matrix

| Type       | Markdown | @mention      | Attachments |
|------------|----------|---------------|-------------|
| formatText | ✓ (auto) | ✓ (reminder)  | ✗           |
| text       | ✗        | ✓             | ✓           |

- **formatText**: Markdown renders, supports @mention via reminder param (auto-fallback if API rejects). No file attachments.
- **text**: Plain text only. Supports @mention + file attachment. No Markdown rendering.
- These two types are **mutually exclusive** — pick one based on what you need.

## Tool Reference

All tools accept optional `to` (chatId). Leave empty to auto-detect current conversation. Only fill for different chat. chatId is case-sensitive — never truncate or modify.

### lansenger_send_file

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| filePath       | string   | ✅        | Absolute local path (workspace, /tmp, Desktop, etc.) |
| caption        | string   | ❌        | Plain-text caption (no Markdown)                   |
| to             | string   | ❌        | Target chatId (auto if omitted)                    |

> ⚠️ **MEDIA: tags currently broken** — they silently fail for ALL files, not just workspace ones. Use `lansenger_send_file` for every file attachment.

### lansenger_send_text

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| content        | string   | ✅        | Plain text only (NO Markdown)                      |
| filePath       | string   | ❌        | Optional file to attach (content becomes caption)   |
| to             | string   | ❌        | Target chatId                                      |
| reminderAll    | boolean  | ❌        | @mention all members (group only)                  |
| reminderUserIds | string[] | ❌        | @mention specific users (group only)               |

### lansenger_send_format_text

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| content        | string   | ✅        | Markdown text                                      |
| to             | string   | ❌        | Target chatId                                      |
| reminderAll    | boolean  | ❌        | @mention all (group only)                          |
| reminderUserIds | string[] | ❌        | @mention specific users (group only)               |

> Use when you need Markdown + @mention. No file attachments. Plugin auto-fallback if API rejects reminder.

### lansenger_send_image_url

| Param    | Type     | Required | Description                                        |
|----------|----------|----------|----------------------------------------------------|
| imageUrl | string   | ✅        | Directly reachable image URL                       |
| caption  | string   | ❌        | Plain-text caption (no Markdown)                   |
| to       | string   | ❌        | Target chatId                                      |

> URL must be reachable from the gateway host. For local files, use `lansenger_send_file`.

### lansenger_send_link_card

| Param        | Type   | Required | Description                                        |
|--------------|--------|----------|----------------------------------------------------|
| title        | string | ✅        | Card title                                         |
| link         | string | ✅        | Click-through URL                                  |
| description  | string | ❌        | Card description (API-required, defaults empty)     |
| iconLink     | string | ❌        | Icon URL (defaults empty)                          |
| pcLink       | string | ❌        | PC client link                                     |
| fromName     | string | ❌        | Source name (defaults empty)                       |
| fromIconLink | string | ❌        | Source icon URL (defaults empty)                   |
| to           | string | ❌        | Target chatId                                      |

### lansenger_send_app_articles

| Param    | Type     | Required | Description                                        |
|----------|----------|----------|----------------------------------------------------|
| articles | object[] | ✅        | Each: { imgUrl, title, url, summary?, pcUrl? }     |
| to       | string   | ❌        | Target chatId                                      |

> ⚠️ Article summary field is `summary`, NOT `description`. `description` is silently ignored by the API.

### lansenger_send_app_card

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| bodyTitle      | string   | ✅        | Card title (supports div-style)                    |
| headTitle      | string   | ❌        | Header title                                       |
| bodySubTitle   | string   | ❌        | Subtitle (supports div-style)                      |
| bodyContent    | string   | ❌        | Main content (supports div-style)                  |
| signature      | string   | ❌        | Footer signature                                   |
| isDynamic      | boolean  | ❌        | Enable approval workflow (default: false)           |
| headStatusInfo | object   | ❌        | { description, colour } — description: status TEXT (supports div-style for color, e.g. `<div style="color:#FFB116">待审批</div>`, max 30 bytes). colour: DOT/圆点 color (hex, e.g. #FFB116). These are TWO different things: text color vs dot color. |
| fields         | object[] | ❌        | Key-value pairs (max 10)                           |
| links          | object[] | ❌        | Links (max 3): { title, url }                      |
| cardLink       | string   | ❌        | Card click-through link                            |
| staffId        | string   | ❌        | Staff openId for sender avatar                     |
| headIconUrl    | string   | ❌        | Header icon URL                                    |
| to             | string   | ❌        | Target chatId                                      |

**div-style rules:**
- `color`: hex (e.g. #333, #007BFF)
- `font-size`: **MUST use pt** (12pt–36pt). px causes "invalid bodyContent" error.
- `text-align`: left, center, right
- `text-indent`: **MUST use 0em** — bare 0 causes silent failure

Example: `<div style="color:#333;font-size:14pt;text-indent:0em;text-align:left">Content here</div>`

### lansenger_update_dynamic_card

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| msgId          | string   | ✅        | Message ID from original send_app_card response    |
| headStatusInfo | object   | ❌        | { description, colour } — description: status TEXT (supports div-style for color). colour: DOT/圆点 color (hex). Independent. |
| links          | object[] | ❌        | Updated links (max 3)                              |
| isLastUpdate   | boolean  | ❌        | True = final state, card becomes static (default: false) |

> Set `isLastUpdate=true` on final approval decision. Intermediate updates: keep `isLastUpdate=false` (default).

### lansenger_revoke_message

| Param     | Type     | Required | Description                                        |
|-----------|----------|----------|----------------------------------------------------|
| messageIds | string[] | ✅        | List of message IDs to revoke                      |
| chatType  | string   | ❌        | bot (default) or group                             |
| senderId  | string   | ❌        | Required if chatType=group                         |

### lansenger_query_groups

| Param      | Type    | Required | Description                                        |
|------------|---------|----------|----------------------------------------------------|
| pageOffset | integer | ❌        | Page number (default: 1)                           |
| pageSize   | integer | ❌        | Groups per page (default: 100)                     |

> ⚠️ May return errCode=10005 "API服务无权限" on enterprise deployments. Ask user for group IDs manually.

## Approval Workflow Pattern

1. Send: `lansenger_send_app_card(bodyTitle="...", isDynamic=true, headStatusInfo={description: '<div style="color:#FFB116">待审批</div>', colour: "#FFB116"})`
2. User approves/denies → OpenClaw processes approval
3. Update: `lansenger_update_dynamic_card(msgId="<from step 1>", headStatusInfo={description: '<div style="color:#198754">已批准</div>', colour: "#198754"}, isLastUpdate=true)`

Status colors: #FFB116 (pending), #198754 (approved), #dc3545 (denied)

## @Mention Rules

Both `lansenger_send_format_text` and `lansenger_send_text` support @mentions via `reminderAll` + `reminderUserIds` params.

1. **Always include "@姓名" in message text** — reminder sends the push notification, "@姓名" makes it visible in the message itself. This is especially important in **group chat** — without "@姓名" the mentioned person won't see who is being addressed.
2. **reminder is optional** — use it when you want someone to receive a push notification about your message.

## Inbound Messages

| Type       | What you see                                      |
|------------|---------------------------------------------------|
| text       | Plain text content                                |
| formatText | Markdown text content                             |
| image      | [Image] + local file paths                        |
| video      | [Video] + local file paths                        |
| file       | [File] + local file paths                         |
| voice      | [Voice] + local file path                         |
| position   | [Location] name address lat,long                  |
| card       | [Contact Card] staffId                            |
| sticker    | [Sticker] stickerId                               |

## Common Pitfalls

| Pitfall                        | Fix                                                                              |
|--------------------------------|----------------------------------------------------------------------------------|
| Raw Markdown in text tool      | Never do this — shows as ugly source code. Write normally for Markdown.          |
| MEDIA: tag for file delivery   | ⚠️ Currently broken for ALL files. Use `lansenger_send_file` instead.            |
| AppArticles `description` field | Use `summary`, not `description`. `description` is silently ignored by the API.  |
| AppCard `font-size: px`        | Use `pt` units (12pt–36pt). px causes API "invalid bodyContent" error.           |
| AppCard `text-indent: 0`       | Use `0em` with unit. Bare 0 causes silent failure.                               |
| headStatusInfo div wrapping    | description supports div-style for color. colour is the DOT/圆点 color. Separate. |
| Message too long               | ~4000 character limit. Split into multiple messages.                              |
| `openclaw skill` command       | Does NOT exist. Use agent tools directly.                                         |