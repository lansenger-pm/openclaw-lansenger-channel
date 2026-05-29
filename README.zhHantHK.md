[English](README.md) | [简体中文](README.zhHans.md) | [繁体中文](README.zhHant.md) | [繁体中文香港](README.zhHantHK.md) | [Français](README.fr.md)

# @lansenger-pm/openclaw-lansenger-channel

> 💠 藍信 頻道插件，供 OpenClaw 使用 — WebSocket 入站，HTTP API 出站。

透過 WebSocket 長連線接收即時訊息，並透過 HTTP API 發送訊息，將 OpenClaw 連接至 藍信 — 一個企業訊息平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)

## 功能特色

- **即時訊息** — 透過 WebSocket 長連線實現
- **多機械人支援** — 將多個藍信機械人綁定至不同的 OpenClaw 代理
- **Markdown 支援** — 使用 `formatText` msgType（預設）
- **檔案/圖片/語音附件** — 透過 `text` msgType 上傳媒體
- **審批卡片**——互動式審批流程，支援原地狀態更新（待審批 → 已通過/已拒絕）
- **語言偵測** — 自動偵測使用者語言，提供本地化回應
- **msgTarget 自動路由** — 所有發送方法自動路由至群組聊天或私聊（DM）API；無需分別的群組/私聊方法
- **@提及** — 支援群組聊天中 @所有人 和 @指定使用者
- **入站媒體處理** — 下載圖片/檔案/語音，偵測副檔名，向代理提供檔案路徑
- **訊息撤回** — 撤回已發送的訊息（chatType 僅支援 bot 與 group）
- **自動啟動** — 網關啟動時自動連接所有已設定的機械人帳戶
- **入站防抖合併** — 利用 OpenClaw 的 `messages.inbound.debounceMs` 配置，合併同一發送者的連續快速訊息
- **確認訊息** — 在代理處理前發送「收到，正在處理...」確認訊息，代理回覆後自動撤回，語言自動偵測
- **零核心修改** — 純插件模式，`git diff HEAD` 保持 PRISTINE

## 訊息類型能力矩陣

| msgType     | Markdown | @提及 | 附件 |
|-------------|----------|-------|------|
| `text`      | ✗        | ✓     | ✓    |
| `formatText`| ✓        | ✓ (reminder) | ✗    |

**預設策略**：優先使用 `formatText` 發送 Markdown 回覆。附件使用 `text` 回退。兩種類型均支援 @mention（透過 `reminder` 參數）—提及使用者時在文字中包含「@姓名」。

## 代理工具 & CLI

代理工具**已內建於此插件** — 頻道設定並執行時始終可用。CLI 為可選替代方案，透過 bash 呼叫。

訊息可以透過**代理工具**（內建）或**CLI 命令**（可選替代）發送：

| 方式 | 安裝方法 | 使用 |
|------|----------|------|
| **代理工具**（內建） | 已包含在 `@lansenger-pm/openclaw-lansenger-channel` | `lansenger_send_file`、`lansenger_send_text` 等 |
| CLI 命令（可選） | `pipx install lansenger-cli`（`pip install lansenger-cli` 為替代） | `lansenger message send-file`、`lansenger message send-text` 等 |

> **代理工具始終可用** — 頻道設定且網關執行時即可使用，無需單獨安裝插件。CLI 命令為可選替代方案，適合偏好 bash 呼叫的場景；需安裝 `lansenger-cli`（Python）。

| 工具 | 說明 |
|------|------|
| `lansenger_send_text` | 發送純文字訊息，不支援 Markdown |
| `lansenger_send_format_text` | 發送 Markdown 格式文字，支援 @提及 |
| `lansenger_send_file` | 發送檔案/圖片/影片/語音（工作區或外部路徑） |
| `lansenger_send_image_url` | 透過 URL 發送圖片 |
| `lansenger_send_link_card` | 發送富連結預覽卡片 |
| `lansenger_send_app_card` | 發送互動/審批卡片 |
| `lansenger_send_app_articles` | 發送多文章卡片 |
| `lansenger_update_dynamic_card` | 原地更新動態卡片狀態 |
| `lansenger_revoke_message` | 撤回已發送的訊息 |
| `lansenger_query_groups` | 查詢可用羣組 |

工具也可透過 CLI 使用：`lansenger message send-text`、`lansenger message send-file` 等。

## 安裝與設定

### 建議安裝流程

```bash
# 1. 安裝頻道插件（包含代理工具）
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. 啟用插件（如未自動啟用）
openclaw config set plugins.entries.lansenger.enabled true

# 3. 配置頻道（互動式精靈）
openclaw channels add

# 4. 重啟網關
openclaw gateway restart
```

> **可選**：安裝 `lansenger-cli` 作為 CLI 替代方案：`pipx install lansenger-cli`。

> **自訂閘道**：企業私有化部署（如奇安信）需在設定後透過 `openclaw.json` 或環境變數設定 `apiGatewayUrl` — 見[可選設定](#可選設定)。

### 開發安裝（本地連結）

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

### 取得憑證

**藍信桌面端** → **通訊錄** → **智能機械人** → **個人機械人** → 點擊 **ℹ️** 圖標

> ⚠️ **行動端不支援查看憑證。** 請僅使用桌面端。

### 首次訊息

重啟後機械人自動透過 WebSocket 連線。給機械人發私聊訊息，會收到配對碼，核准配對：

```bash
openclaw pairing approve lansenger <配對碼>
```

## 設定

### 必要環境變數

將以下內容加入 `~/.openclaw/.env` 或環境變數：

| 變數 | 說明 | 範例 |
|------|------|------|
| `LANSENGER_APP_ID` | 個人機械人 App ID | `your-appid` |
| `LANSENGER_APP_SECRET` | 個人機械人 App Secret | `ABCDEF123456...` |
| `LANSENGER_API_GATEWAY_URL` | 藍信 API 網關 URL 覆蓋 | `https://open.e.lanxin.cn/open/apigw` |

憑證也可透過 `openclaw.json` 配置提供（見下方可選設定）。配置值優先；環境變數僅在配置未設定時作為回退。

### 取得憑證

**藍信桌面端** → **通訊錄** → **智能機械人** → **個人機械人** → 點擊 **ℹ️** 圖標

> ⚠️ **行動端不支援查看憑證。** 請僅使用桌面端。

### 可選設定

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

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `appId` | 個人機械人 App ID | — |
| `appSecret` | 個人機械人 App Secret | — |
| `apiGatewayUrl` | API 網關 URL | `https://open.e.lanxin.cn/open/apigw` |
| `homeChannel` | 定時任務/通知遞送的預設聊天 ID | — |
| `enabled` | 啟用/禁用頻道（運行時預設：無憑證時為 false） | `true` |
| `allowFrom` | 允許私聊的使用者 ID | `[]` |
| `dmPolicy` | 私聊策略：`pairing`、`allowlist`、`open`、`disabled` | `pairing` |
| `configWrites` | 允許藍信回應頻道事件寫入配置 | `true` |
| `name` | 此帳戶的顯示名稱 | — |
| `accounts` | 多機械人設定 | — |
| `groupPolicy` | 羣聊策略：`open`（所有羣）、`allowlist`（僅允許列表羣）、`disabled`（禁止羣訊息） | `allowlist` |
| `groupAllowFrom` | 允許觸發機械人的羣 ID | `[]` |
| `groups` | 羣級設定（requireMention、enabled、allowFrom） | — |
| `ackMessage` | 在代理處理前發送確認訊息 | `false` |
| `revokeAckMessage` | 代理回覆遞送後自動撤回確認訊息。設為 `false` 則保留確認訊息可見（有些使用者偏好看到確認訊息而非撤回的系統通知） | `true` |
| `ackMessageTextZh` | 中文確認訊息文案 | `收到，正在處理...` |
| `ackMessageTextEn` | 英文確認訊息文案 | `Received, processing...` |

### 入站防抖合併（訊息合併）

當使用者連續發送多條訊息時，OpenClaw 的防抖機制可以將它們合併為一次代理對話。在 `openclaw.json` 中設定：

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

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `messages.inbound.debounceMs` | 全域防抖視窗（毫秒）；同一發送者在視窗內的連續訊息會被合併 | `0`（停用） |
| `messages.inbound.byChannel.lansenger` | 藍信頻道專屬覆蓋（優先於全域） | — |
| `messages.queue.mode` | 代理處理中的佇列模式：`steer`、`followup`、`collect`、`queue`、`interrupt` | `steer`（推薦） |

- 媒體訊息和控制命令不走防抖，立即處理
- 防抖生效時，合併訊息的文字以 `\n` 拼接；媒體路徑合併；使用最後一條訊息的元資料

### 多機械人設定

新增多個機械人時，使用 `openclaw config set` 配置 `accounts` 結構：

透過 `channels add` 新增第一個帳號後，用 `openclaw config set` 新增更多機械人：

```bash
# 新增第二個機械人（替換 appid/appsecret/gateway 為你的值）
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

# 重啟生效
openclaw gateway restart
```

最終設定結構：

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

## 使用

網關啟動時自動連接所有已設定的帳戶。`lansenger.start` 方法可用於動態啟動額外帳戶。

### 啟動網關（動態）

```bash
openclaw gateway call lansenger.start
```

### 停止網關

```bash
openclaw gateway call lansenger.stop
```

### 查看狀態

```bash
openclaw channels status
# 含健康探測（顯示「configured」和「works」）：
openclaw channels status --probe
```

### 多 Agent 路由

使用 `bindings` 將藍信私聊或羣組聊天路由至不同的 Agent（與飛書/WhatsApp 等相同模式）：

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

路由欄位：
* `match.channel`: `"lansenger"`
* `match.peer.kind`: `"direct"`（私聊）或 `"group"`（羣組聊天）
* `match.peer.id`: 使用者 ID（`xxx-xxx`）或羣組聊天 ID

單 Agent 模式下，所有訊息自動路由至預設 Agent（`main`），無需 bindings 設定。

### 支持的訊息類型

| 類型 | 說明 | API 方法 | 方向 |
|------|------|----------|------|
| `text` | 純文字，支援可選 @提及與附件 | `sendText()` | 出站 |
| `formatText` | Markdown 格式文字（預設） | `sendFormatText()` | 出站 |
| `image` | 圖片，支援可選說明 | `sendFile()` | 出站 |
| `file` | 任意檔案附件 | `sendFile()` | 出站 |
| `video` | 影片附件 | `sendFile()` | 出站 |
| `voice` | 語音訊息 | `sendFile()` | 出站 |
| `linkCard` | 富連結預覽卡片 | `sendLinkCard()` | 出站 |
| `i18nAppCard` | 保留供未來使用；5 語言卡片 | `sendI18nAppCard()` | 出站 |
| `appCard` | 審批卡片（支援狀態更新） | `sendAppCard()` | 出站 |
| `appArticles` | 多文章卡片（欄位為 `summary`，不是 `description`） | `sendAppArticles()` | 出站 |
| `position` | 位置/定位訊息 | — | 僅入站 |
| `card` | 通用卡片訊息 | — | 僅入站 |
| `sticker` | 貼紙/表情訊息 | — | 僅入站 |

## 入站媒體處理

當使用者發送圖片、影片、檔案或語音訊息時，插件會：

1. 透過藍信媒體 API 下載所有 `mediaIds`（影片：第一個以影片類型下載，第二個以圖片類型下載作為封面）
2. 從 Content-Type/Content-Disposition 標頭偵測副檔名（回退：檔案魔數）
3. 儲存至暫存檔案，將路徑附加至 `InboundEvent.mediaPaths[]`
4. 在代理文字中加入提示：「附件已儲存至本地 — 使用讀取工具查看」

## 審批流程

支援審批卡片：
- 審批請求透過 **appCard**（`isDynamic=true`）發送
- 狀態更新（待審批 → 已通過/已拒絕）透過 **DynamicMsg** 原地更新卡片
- 根據使用者偵測到的語言發送中文或英文卡片
- **i18nAppCard**（5 語言）保留供未來使用，目前不用於審批

## 重要說明

- **無員工聊天概念** — 藍信僅有群組聊天與私聊（DM），沒有「員工聊天」類型。
- **撤回 chatType** — 僅支援 `bot` 與 `group`，沒有 `staff` 類型。
- **撤回無 sysMsg** — API 接受 `sysMsg` 但不會顯示。
- **無 deleteMessage** — API 回傳錯誤碼 10000，刪除訊息不可用。
- **appArticles** — 使用 `summary` 欄位（不是 `description`）。
- **linkCard** — `description`、`iconLink`、`fromName`、`fromIconLink` 為必填欄位（可用空字串作為預設值）。
- **msgTarget 自動路由** — 所有發送方法自動路由，無需分別呼叫群組/私聊 API。
- **網關 URL 因環境不同** — 如 `https://apigw.lx.qianxin.com` 用於奇安信部署，`https://open.e.lanxin.cn/open/apigw` 用於標準藍信。
- **reminder** — formatText 中可選欄位；群組聊天中建議使用。提及使用者時在文字中包含「@姓名」。
- **媒體標籤** — `<media>` 標籤適用於工作區檔案；外部路徑請使用 `lansenger_send_file`。
- **openclaw skill/message lansenger** — 這些 CLI 命令不存在；請使用代理工具。
- **代理工具** — 代理工具（`lansenger_send_*`）需要工具插件且網關注入成功 — 若工具不可用，請使用 CLI 作為備選。CLI 命令（`lansenger message send-*`）需要 `pipx install lansenger-cli`。
- **alsoAllow** — 本插件註冊了 agent 工具（`lansenger_send_*`），但在嚴格工具策略下可能**不可見**。需在 `openclaw.json` 中新增 `"tools": { "alsoAllow": ["group:plugins"] }` 以確保 agent 能看到並使用這些工具。否則工具可能靜默不出現在 agent 工具列表中。

## 開發

### 建置

```bash
npm install
npx tsc
```

### 測試

```bash
npx vitest run
```

### 類型檢查

```bash
npx tsc --noEmit
```

### 專案結構

```
openclaw-lansenger-channel/
├── src/
│   ├── client.ts       # 藍信 API 客戶端（WS、HTTP、媒體）
│   ├── channel.ts      # OpenClaw 频道插件
│   ├── runtime.ts      # 網關運行時（方法、入站處理器）
│   ├── tools.ts        # 代理工具定義（10 個內建工具）
│   ├── setup-wizard.ts # 設定精靈（多帳號配置遷移）
│   ├── channel.test.ts # 频道插件測試
│   ├── client.test.ts  # API 客戶端測試
│   ├── runtime.test.ts # 運行時測試
│   ├── tools.test.ts   # 工具測試
│   └── setup-wizard.test.ts # 設定精靈測試
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # 代理訊息策略（工具 + CLI）
├── dist/               # 編譯後的 JavaScript
├── index.ts            # 插件入口
├── setup-entry.ts      # 設定精靈入口
├── openclaw.plugin.json # 插件元資料與 GUI 設定
├── package.json
└── tsconfig.json
```

## 故障排除

### OpenClaw v2026.5.18+：需要設備配對

升級 OpenClaw 至 v2026.5.18 或更高版本後，**任何客戶端（瀏覽器 Dashboard、Control UI）連線前必須完成設備配對**。這也影響藍信頻道——如果網關主機的設備未經審批，WebSocket 連線可能被阻止，配對訊息無法發送給藍信使用者。

**修復——在 OpenClaw 網關主機上執行以下命令：**

```bash
# 1. 查看待審批的設備配對請求
openclaw devices list

# 2. 審批最近的請求（先預覽，再使用確切 ID 審批）
openclaw devices approve --latest   # 預覽
openclaw devices approve <requestId>  # 使用顯示的確切 ID 審批

# 3. 重啟網關
openclaw gateway restart
```

詳見 [OpenClaw 設備文件](https://docs.openclaw.ai/cli/devices)。

### "行動端不支援查看憑證"

請僅使用**藍信桌面端**。行動端應用不顯示機械人憑證。

### "No binding for botId"

Agent 路由由 OpenClaw 的 `bindings[]` 設定管理——見[多 Agent 路由](#多-agent-路由)。單 Agent 模式下無需 bindings，訊息自動路由至預設 Agent。

### WebSocket 斷線

插件內建自動重連（指數退避：2s、5s、10s、30s、60s）與心跳（每 30s ping）。

### formatText vs text

- 使用 `formatText` 發送 Markdown 回覆（預設）
- 使用 `text` 發送附件（無 Markdown）
- 兩種類型均支援 @mention（透過 `reminder`）—提及時在文字中包含「@姓名」
- 兩者都需要時，發送兩條獨立訊息

### 動態卡片更新失敗

審批狀態更新使用 DynamicMsg appCard 格式，`updateCardStatus()` 方法自動處理。

## 更新日誌

完整版本歷史見 [CHANGELOG.md](CHANGELOG.md)。

## 授權條款

MIT — 詳見 [LICENSE](LICENSE)。

## 貢獻

1. Fork 本 repo
2. 建立功能分支
3. 進行修改
4. 執行測試：`npx vitest run`
5. 提交 Pull Request