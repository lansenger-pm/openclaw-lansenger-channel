---
name: lansenger-messaging
description: How to communicate on Lansenger (蓝信) — choose the right tool or CLI command, send rich content, approvals, and pitfalls
metadata: {"openclaw":{"requires":{"config":["channels.lansenger"],"plugins":["lansenger-tools"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) Messaging — Agent Quick Reference

> ⚠️ **Agent tools require the `lansenger-tools` plugin** — install with `openclaw plugins install @lansenger-pm/openclaw-lansenger-tools`. Without it, only normal Markdown replies and CLI commands work.

In a Lansenger session, **just write your reply normally** — Markdown renders automatically as formatText. No tool needed for formatted text unless you also need @mentions.

You can send messages via **agent tools** or **CLI commands**. Both work. Choose whichever is available:

- **Agent tools**: `lansenger_send_file`, `lansenger_send_text`, etc. — available when `lansenger-tools` plugin is installed.
- **CLI commands**: `lansenger message send-file`, `lansenger message send-text`, etc. — available via bash.

However, Markdown and file attachments are **mutually exclusive**. If you need both formatting AND a file, send the Markdown reply first, then call `lansenger_send_file` or `lansenger message send-file` separately.

**Never put raw Markdown in lansenger_send_text / send-text** — it displays as ugly source code.

## Quick Decision: What Tool/Command Do I Use?

Need to send something? Follow this decision tree:

1. Normal reply with formatting → JUST WRITE IT. No tool needed.
2. Markdown + @mention → `lansenger_send_format_text` or `lansenger message send-markdown`
3. Plain text + @mention + file → `lansenger_send_text` or `lansenger message send-text`
4. Send a FILE → `lansenger_send_file` or `lansenger message send-file`
5. Send image from URL → `lansenger_send_image_url` or `lansenger message send-image-url`
6. Link card → `lansenger_send_link_card` or `lansenger message send-link-card`
7. Multi-article card (图文) → `lansenger_send_app_articles` or `lansenger message send-app-articles`
8. Rich formatted card → `lansenger_send_app_card` or `lansenger message send-app-card`
9. Approval workflow → sendAppCard(isDynamic=true) → updateDynamicCard
10. Revoke a message → `lansenger_revoke_message` or `lansenger message revoke`
11. Find group IDs → `lansenger_query_groups` or `lansenger message query-groups`

## Message Type Capability Matrix

| Type       | Markdown | @mention      | Attachments |
|------------|----------|---------------|-------------|
| formatText | ✓ (auto) | ✓ (reminder)  | ✗           |
| text       | ✗        | ✓             | ✓           |

- **formatText**: Markdown renders, supports @mention via reminder param (auto-fallback if API rejects). No file attachments.
- **text**: Plain text only. Supports @mention + file attachment. No Markdown rendering.
- These two types are **mutually exclusive** — pick one based on what you need.

## Agent Tool Reference

All tools accept optional `to` (chatId). Leave empty to auto-detect current conversation. Only fill for different chat. chatId is case-sensitive — never truncate or modify.

### lansenger_send_file

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| filePath       | string   | ✅        | Absolute local path (workspace, /tmp, Desktop, etc.) |
| caption        | string   | ❌        | Plain-text caption (no Markdown)                   |
| to             | string   | ❌        | Target chatId (auto if omitted)                    |

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

### lansenger_send_image_url

| Param    | Type     | Required | Description                                        |
|----------|----------|----------|----------------------------------------------------|
| imageUrl | string   | ✅        | Directly reachable image URL                       |
| caption  | string   | ❌        | Plain-text caption (no Markdown)                   |
| to       | string   | ❌        | Target chatId                                      |

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

### lansenger_update_dynamic_card

| Param          | Type     | Required | Description                                        |
|----------------|----------|----------|----------------------------------------------------|
| msgId          | string   | ✅        | Message ID from original send_app_card response    |
| headStatusInfo | object   | ❌        | { description, colour } — description: status TEXT (supports div-style for color). colour: DOT/圆点 color (hex). Independent. |
| links          | object[] | ❌        | Updated links (max 3)                              |
| isLastUpdate   | boolean  | ❌        | True = final state, card becomes static (default: false) |

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

## CLI Command Reference

All commands use `lansenger message <subcommand>`. chatId is case-sensitive.

### lansenger message send-text

```bash
lansenger message send-text <chat_id> <content> [--file <path>] [--mention-all] [--mention <uid1> [--mention <uid2>]]
```

### lansenger message send-markdown

```bash
lansenger message send-markdown <chat_id> <content> [--mention-all] [--mention <uid>]
```

### lansenger message send-file

```bash
lansenger message send-file <chat_id> <file_path> [--caption <text>] [--media-type <1|2|3>]
```

### lansenger message send-image-url

```bash
lansenger message send-image-url <chat_id> <image_url> [--caption <text>]
```

### lansenger message send-link-card

```bash
lansenger message send-link-card <chat_id> <title> <link> [--desc <text>] [--icon <url>] [--pc-link <url>] [--from-name <name>] [--from-icon <url>]
```

### lansenger message send-app-articles

```bash
lansenger message send-app-articles <chat_id> '{"title":"T","url":"U","imgUrl":"I","summary":"S"}' '{"title":"T2","url":"U2"}'
```

> ⚠️ Article field is `summary`, NOT `description`. `description` is silently ignored by the API.

### lansenger message send-app-card

```bash
lansenger message send-app-card <chat_id> <body_title> [--head-title <t>] [--sub-title <t>] [--content <t>] [--signature <t>] [--card-link <url>] [--dynamic] [--staff-id <id>] [--head-icon <url>] [--status-desc <div>] [--status-colour <hex>] [--field <json>] [--link <json>]
```

**headStatusInfo**: `--status-desc` = status TEXT (supports div-style for text color), `--status-colour` = DOT/圆点 colour (hex). These are TWO different things: text color vs dot color.

### lansenger message update-dynamic-card

```bash
lansenger message update-dynamic-card <msg_id> [--last] [--status-desc <div>] [--status-colour <hex>] [--link <json>]
```

### lansenger message revoke

```bash
lansenger message revoke <msg_id1> <msg_id2> [--chat-type bot|group] [--sender-id <id>]
```

### lansenger message query-groups

```bash
lansenger message query-groups [--page <n>] [--size <n>]
```

## Approval Workflow Pattern

**Via tools:**
1. `lansenger_send_app_card(bodyTitle="...", isDynamic=true, headStatusInfo={description: '<div style="color:#FFB116">待审批</div>', colour: "#FFB116"})`
2. `lansenger_update_dynamic_card(msgId="<from step 1>", headStatusInfo={description: '<div style="color:#198754">已批准</div>', colour: "#198754"}, isLastUpdate=true)`

**Via CLI:**
```bash
lansenger message send-app-card <chat_id> "审批" --dynamic --status-desc '<div style="color:#FFB116">待审批</div>' --status-colour "#FFB116"
lansenger message update-dynamic-card <msg_id> --last --status-desc '<div style="color:#198754">已批准</div>' --status-colour "#198754"
```

Status colors: #FFB116 (pending), #198754 (approved), #dc3545 (denied)

## @Mention Rules

1. **Always include "@姓名" in message text** — reminder sends the push notification, "@姓名" makes it visible in the message itself. Especially important in **group chat**.
2. **reminder is optional** — use it when you want someone to receive a push notification about your message.

## Inbound Messages

| Type       | What you see                                      |
|------------|---------------------------------------------------|
| text       | Plain text content                                |
| formatText | Markdown text content                             |
| image      | Local file paths (use read tool to view)          |
| video      | Local file paths                                  |
| file       | Local file paths                                  |
| voice      | Local file path (.amr)                            |
| position   | Location name, address, lat/long                  |
| card       | Contact card with staffId                         |
| sticker    | Sticker/emoji message                             |

## Common Pitfalls

| Pitfall                        | Fix                                                                              |
|--------------------------------|----------------------------------------------------------------------------------|
| Raw Markdown in text tool/CLI  | Never do this — shows as ugly source code. Write normally for Markdown.          |
| MEDIA: tag for file delivery   | ⚠️ Currently broken for ALL files. Use `lansenger_send_file` instead.            |
| AppArticles `description` field | Use `summary`, not `description`. `description` is silently ignored by the API.  |
| AppCard `font-size: px`        | Use `pt` units (12pt–36pt). px causes API "invalid bodyContent" error.           |
| AppCard `text-indent: 0`       | Use `0em` with unit. Bare 0 causes silent failure.                               |
| headStatusInfo div wrapping    | description supports div-style for color. colour is the DOT/圆点 color. Separate. |
| Message too long               | ~4000 character limit. Split into multiple messages.                              |
| Tools not available            | Install `lansenger-tools` plugin: `openclaw plugins install @lansenger-pm/openclaw-lansenger-tools` |