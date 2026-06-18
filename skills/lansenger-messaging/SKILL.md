---
name: lansenger-messaging
description: How to communicate on Lansenger (蓝信) — send rich content via message tool, agent tools, CLI, approvals, and pitfalls
metadata: {"openclaw":{"requires":{"config":["channels.lansenger"],"cli":["lansenger"]},"primaryEnv":"LANSENGER_APP_ID"}}
---

# Lansenger (蓝信) Messaging — Agent Quick Reference

In a Lansenger session, **just write your reply normally** — Markdown renders automatically as formatText. No tool needed for formatted text unless you also need @mentions.

You can send messages via **CLI commands** (alternative) or **agent tools** (built-in):

- **Agent tools** (PRIMARY): `lansenger_send_file`, `lansenger_send_text`, etc. — built into the channel plugin, always available when the channel is configured and running.
- **CLI commands** (ALTERNATIVE): `lansenger message send-file`, `lansenger message send-text`, etc. — via bash exec. Requires `pipx install lansenger-cli` or `pip install lansenger-cli`.

> 💡 **CLI is an optional alternative**: `pipx install lansenger-cli` (or `pip install lansenger-cli`). Agent tools are built into the channel plugin and available when the channel is running.

However, Markdown and file attachments are **mutually exclusive**. If you need both formatting AND a file, send the Markdown reply first, then call `lansenger_send_file` or `lansenger message send-file` separately.

**Never put raw Markdown in lansenger_send_text / send-text** — it displays as ugly source code.

## CLI Credential Sync (凭证同步)

Lansenger-CLI supports **multi-credential profiles** via the global `-P <profile>` flag. The profile name is the App ID. Before calling any CLI command, you must ensure the credential for the current appId is available in CLI's config store.

**Every CLI call MUST include `-P <appId>`** (placed immediately after `lansenger`, before the subcommand group) where `<appId>` is the Lansenger App ID from the current session's OpenClaw config. This ensures the CLI uses the correct bot credentials.

### Before first CLI call — sync credentials

Run this check-and-sync sequence **once** before your first CLI command in a session:

```bash
# Step 1: Check if the profile already exists
lansenger -P <appId> config show

# Step 2: If the profile does NOT exist (returns error / "not configured"), write credentials from OpenClaw config:
lansenger -P <appId> config set app_id <appId>
lansenger -P <appId> config set app_secret <appSecret>
lansenger -P <appId> config set api_gateway_url <apiGatewayUrl>
lansenger -P <appId> config set passport_url <passportUrl>            # optional
```

The `<appId>`, `<appSecret>`, `<apiGatewayUrl>`, and `<passportUrl>` values come from the OpenClaw config:
- Single-account: `channels.lansenger.appId`, `channels.lansenger.appSecret`, `channels.lansenger.apiGatewayUrl`
- Multi-account: `channels.lansenger.accounts.<key>.appId`, `.appSecret`, `.apiGatewayUrl`
- Environment variables: `LANSENGER_APP_ID`, `LANSENGER_APP_SECRET`, `LANSENGER_API_GATEWAY_URL`

### Verify sync worked

```bash
lansenger -P <appId> config show
# Should show "Credentials configured: True"
```

### List all existing profiles

```bash
lansenger config list-profiles
```

### Manage profiles

```bash
lansenger config show                       # view current (default) profile
lansenger -P <appId> config show            # view specific profile
lansenger -P <appId> config clear           # delete specific profile
lansenger config clear --all                # delete all profiles
```

> **Tip**: After syncing once, the profile persists in `~/.lansenger/sdk_state.json`. You only need to sync again if credentials change or a new bot is added.

## Quick Decision: What Tool/Command Do I Use?

Need to send something? Follow this decision tree:

1. Normal reply with formatting → JUST WRITE IT. No tool needed.
2. Markdown + @mention → `lansenger_send_format_text` or `lansenger message send-markdown`
3. Plain text + @mention + file → `lansenger_send_text` or `lansenger message send-text`
4. Send a FILE → **`message(action=send, filePath=<path>)`** (always available, no extra permissions needed, any file type) or `lansenger_send_file` or `lansenger message send-file`
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
| coverImagePath | string   | ❌*       | **Required for video**: cover/thumbnail image path. API requires mediaIds=[video, cover]. Extract with: `ffmpeg -i video.mp4 -vframes 1 -q:v 2 cover.jpg` |
| videoWidth     | integer  | ❌*       | **Required for video**: video width in pixels. Get with: `ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 video.mp4` |
| videoHeight    | integer  | ❌*       | **Required for video**: video height in pixels. Get with: `ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 video.mp4` |
| videoDuration  | integer  | ❌*       | **Required for video**: video duration in seconds. Get with: `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 video.mp4` |
| to             | string   | ❌        | Target chatId (auto if omitted)                    |

\* *Required when sending video files (`.mp4`, `.mov`, etc.). The Lansenger API mandates cover image + metadata for video type. If these are missing, the send will fail with an error message.*

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

All commands use `lansenger <group> <subcommand>`. chatId is case-sensitive.

**Every CLI command MUST include `-P <appId>`** (global flag, placed after `lansenger` and before the subcommand) to select the correct credential profile. See [CLI Credential Sync](#cli-credential-sync-凭证同步) above for how to ensure the profile exists before calling.

### lansenger message send-text

```bash
lansenger -P <appId> message send-text <chat_id> <content> [--file <path>] [--mention-all] [--mention <uid1> [--mention <uid2>]]
```

### lansenger message send-markdown

```bash
lansenger -P <appId> message send-markdown <chat_id> <content> [--mention-all] [--mention <uid>]
```

### lansenger message send-file

```bash
lansenger -P <appId> message send-file <chat_id> <file_path> [--caption <text>] [--media-type <1|2|3>]
```

### lansenger message send-image-url

```bash
lansenger -P <appId> message send-image-url <chat_id> <image_url> [--caption <text>]
```

### lansenger message send-link-card

```bash
lansenger -P <appId> message send-link-card <chat_id> <title> <link> [--desc <text>] [--icon <url>] [--pc-link <url>] [--from-name <name>] [--from-icon <url>]
```

### lansenger message send-app-articles

```bash
lansenger -P <appId> message send-app-articles <chat_id> '{"title":"T","url":"U","imgUrl":"I","summary":"S"}' '{"title":"T2","url":"U2"}'
```

> ⚠️ Article field is `summary`, NOT `description`. `description` is silently ignored by the API.

### lansenger message send-app-card

```bash
lansenger -P <appId> message send-app-card <chat_id> <body_title> [--head-title <t>] [--sub-title <t>] [--content <t>] [--signature <t>] [--card-link <url>] [--dynamic] [--staff-id <id>] [--head-icon <url>] [--status-desc <div>] [--status-colour <hex>] [--field <json>] [--link <json>]
```

**headStatusInfo**: `--status-desc` = status TEXT (supports div-style for text color), `--status-colour` = DOT/圆点 colour (hex). These are TWO different things: text color vs dot color.

### lansenger message update-dynamic-card

```bash
lansenger -P <appId> message update-dynamic-card <msg_id> [--last] [--status-desc <div>] [--status-colour <hex>] [--link <json>]
```

### lansenger message revoke

```bash
lansenger -P <appId> message revoke <msg_id1> <msg_id2> [--chat-type bot|group] [--sender-id <id>]
```

### lansenger message query-groups

```bash
lansenger -P <appId> message query-groups [--page <n>] [--size <n>]
```

## Approval Workflow Pattern

**Via tools:**
1. `lansenger_send_app_card(bodyTitle="...", isDynamic=true, headStatusInfo={description: '<div style="color:#FFB116">待审批</div>', colour: "#FFB116"})`
2. `lansenger_update_dynamic_card(msgId="<from step 1>", headStatusInfo={description: '<div style="color:#198754">已批准</div>', colour: "#198754"}, isLastUpdate=true)`

**Via CLI:**
```bash
lansenger -P <appId> message send-app-card <chat_id> "审批" --dynamic --status-desc '<div style="color:#FFB116">待审批</div>' --status-colour "#FFB116"
lansenger -P <appId> message update-dynamic-card <msg_id> --last --status-desc '<div style="color:#198754">已批准</div>' --status-colour "#198754"
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
| video      | Local file paths (video + cover image)            |
| file       | Local file paths                                  |
| voice      | Local file path (.amr)                            |
| position   | Location name, address, lat/long                  |
| card       | Contact card with staffId                         |
| sticker    | Sticker/emoji message                             |

## File Delivery: MEDIA: Tags vs. message Tool

OpenClaw's `MEDIA:` tag mechanism has a **MIME whitelist** — only these file types can be delivered via MEDIA: tags:

| Allowed by MEDIA:              | Examples                                      |
|---------------------------------|-----------------------------------------------|
| Images (image/*)               | .png, .jpg, .gif, .bmp, .webp, .svg          |
| Audio (audio/*)                | .mp3, .wav, .ogg, .m4a                        |
| Video (video/*)                | .mp4, .mov, .avi, .mkv                        |
| PDF                             | .pdf                                          |
| Office documents               | .doc, .xls, .ppt, .docx, .xlsx, .pptx        |
| Archives                        | .zip, .gzip, .7z, .tar                        |
| CSV                             | .csv                                          |
| Markdown                        | .md                                           |

**All other file types are BLOCKED by MEDIA: tags** and produce "⚠️ Media failed." in the reply. Specifically:

| Blocked by MEDIA: | Examples |
|-------------------|----------|
| Plain text        | .txt     |
| JSON              | .json    |
| Code/config       | .py, .js, .ts, .yaml, .xml, .toml, .ini, .cfg, .conf |
| Data              | .db, .sql, .parquet |
| Executables       | .exe, .sh, .bat |
| Other binary      | .bin, .dat, .so, .dll |

**To send blocked file types, use `message(action=send, filePath=<path>)`** — it bypasses the MEDIA whitelist and uploads any file type directly via the Lansenger API. You can also rename the file to `.md` (wrapping content in a Markdown code block) to make it MEDIA-compatible.

## Common Pitfalls

| Pitfall                        | Fix                                                                              |
|--------------------------------|----------------------------------------------------------------------------------|
| Raw Markdown in text tool/CLI  | Never do this — shows as ugly source code. Write normally for Markdown.          |
| AppArticles `description` field | Use `summary`, not `description`. `description` is silently ignored by the API.  |
| AppCard `font-size: px`        | Use `pt` units (12pt–36pt). px causes API "invalid bodyContent" error.           |
| AppCard `text-indent: 0`       | Use `0em` with unit. Bare 0 causes silent failure.                               |
| headStatusInfo div wrapping    | description supports div-style for color. colour is the DOT/圆点 color. Separate. |
| Message too long               | ~4000 character limit. Split into multiple messages.                              |
| Video missing cover or metadata  | **The API requires:** 1) `coverImagePath` (cover/thumbnail image) — mediaIds must be `[videoId, coverId]`; 2) `videoWidth` + `videoHeight` + `videoDuration` — the upload API requires these params. Before sending a video, you MUST: extract a cover frame (`ffmpeg -i video.mp4 -vframes 1 -q:v 2 cover.jpg`) and probe metadata (`ffprobe`). Provide all four as tool params. |
| Tools not available            | Tools are built into the channel plugin. If unavailable, use `message(action=send, filePath=...)` for file sending (works without `group:plugins`). As a last resort, use CLI: `pipx install lansenger-cli`, then `lansenger message send-text <chatId> <content>`. |
| CLI command not found          | Install: `pipx install lansenger-cli` or `pip install lansenger-cli`. Then verify: `lansenger --help`. |
| CLI wrong credentials / sends as wrong bot | **Always use `-P <appId>`** (global flag after `lansenger`). Without it, CLI uses the `default` profile which may be a different bot. Sync first: `lansenger -P <appId> config show` → if missing, run `lansenger -P <appId> config set` commands. |
| CLI "Credentials configured: False" | Run credential sync: `lansenger -P <appId> config set app_id <appId>` + `lansenger -P <appId> config set app_secret <appSecret>`. |