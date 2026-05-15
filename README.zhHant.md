[English](README.md) | [简体中文](README.zhHans.md) | [繁体中文](README.zhHant.md) | [繁体中文香港](README.zhHantHK.md) | [Français](README.fr.md)

# @lansenger-pm/openclaw-lansenger-channel

> 💠 藍信 頻道插件，供 OpenClaw 使用 — WebSocket 入站，HTTP API 出站。

透過 WebSocket 長連線接收即時訊息，並透過 HTTP API 傳送訊息，將 OpenClaw 連接至 藍信——一個企業即時通訊平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)

## 功能特色

- **即時訊息**——透過 WebSocket 長連線實現
- **多機器人支援**——將多個藍信機器人綁定至不同的 OpenClaw 代理
- **Markdown 支援**——使用 `formatText` msgType（預設）
- **檔案/圖片/語音附件**——透過 `text` msgType 上傳媒體
- **審批卡片**——互動式審批流程，支援原地狀態更新（待審批 → 已通過/已拒絕）
- **語言偵測**——自動偵測使用者語言，提供本地化回應
- **msgTarget 自動路由**——所有傳送方法自動路由至群組聊天或私聊（DM）API；無需分別的群組/私聊方法
- **@提及**——支援群組聊天中 @所有人 和 @指定使用者
- **入站媒體處理**——下載圖片/檔案/語音，偵測副檔名，向代理提供檔案路徑
- **訊息撤回**——撤回已傳送的訊息（chatType 僅支援 bot 與 group）
- **自動啟動**——閘道啟動時自動連接所有已設定的機器人帳戶
- **零核心修改**——純插件模式，`git diff HEAD` 保持 PRISTINE

## 訊息類型能力矩陣

| msgType     | Markdown | @提及 | 附件 |
|-------------|----------|-------|------|
| `text`      | ✗        | ✓     | ✓    |
| `formatText`| ✓        | ✓ (reminder) | ✗    |

**預設策略**：優先使用 `formatText` 傳送 Markdown 回覆。附件使用 `text` 回退。兩種類型均支援 @mention（透過 `reminder` 參數）—提及使用者時在文字中包含「@姓名」。

## 代理工具 & CLI

**CLI 是主要方式** — 始終透過 bash 呼叫即可使用。代理工具為備選方式 — 在某些閘道版本中可能無法正確注入。

訊息可以透過**CLI 命令**（主要）或**代理工具**（備選）傳送：

| 方式 | 安裝方法 | 使用 |
|------|----------|------|
| **CLI 命令**（主要） | `pipx install lansenger-cli`（`pip install lansenger-cli` 為替代） | `lansenger message send-file`、`lansenger message send-text` 等 |
| 代理工具（備選） | `openclaw plugins install @lansenger-pm/openclaw-lansenger-tools` | `lansenger_send_file`、`lansenger_send_text` 等 |

> ⚠️ **代理工具需要 `lansenger-tools` 插件且閘道注入成功** — 若工具不可用，請使用 CLI 作為備選。CLI 命令需要 `lansenger-cli`（Python）。兩者均未安裝時，代理只能透過普通 Markdown 文字回覆。

## 安裝與設定

### 建議安裝流程

```bash
# 1. 安裝頻道插件
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. 安裝 CLI 或工具插件（至少需要一個來傳送訊息）
#    方案 A：Python CLI（主要 — 始終可透過 bash 呼叫）
pipx install lansenger-cli   # 或：pip install lansenger-cli
#    方案 B：OpenClaw 代理工具插件（備選 — 需閘道注入）
openclaw plugins install @lansenger-pm/openclaw-lansenger-tools

# 3. 啟用插件（如未自動啟用）
openclaw config set plugins.entries.lansenger.enabled true
openclaw config set plugins.entries.lansenger-tools.enabled true  # 使用方案 B 時

# 4. 配置頻道（互動式精靈）
openclaw channels add

# 5. 重啟閘道
openclaw gateway restart
```

> **注意**：代理工具（方案 B）在某些閘道版本中可能無法正確注入 — 請務必檢查代理工具列表中是否出現 `lansenger_send_*` 工具。若工具缺失，請使用 CLI（方案 A）。

`package.json` 的 `peerDependencies` 在 npm install 時會警告缺少 tools 插件。設定精靈也會提醒安裝。

> **自訂閘道**：企業私有化部署（如奇安信）需在設定後透過 `openclaw.json` 或環境變數設定 `apiGatewayUrl` — 見[可選設定](#可選設定)。

### 開發安裝（本地連結）

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

### 取得憑證

**藍信桌面端** → **通訊錄** → **智慧機器人** → **個人機器人** → 點擊 **ℹ️** 圖標

> ⚠️ **行動端不支援查看憑證。** 請僅使用桌面端。

### 首次訊息

重啟後機器人自動透過 WebSocket 連線。給機器人發私聊訊息，會收到配對碼，核准配對：

```bash
openclaw pairing approve lansenger <配對碼>
```

## 設定

### 必要環境變數

將以下內容加入 `~/.openclaw/.env` 或環境變數：

| 變數 | 說明 | 範例 |
|------|------|------|
| `LANSENGER_APP_ID` | 個人機器人 App ID | `your-appid` |
| `LANSENGER_APP_SECRET` | 個人機器人 App Secret | `57E718CA1CAC20F2...` |
| `LANSENGER_API_GATEWAY_URL` | 藍信 API 閘道 URL 覆蓋 | `https://open.e.lanxin.cn/open/apigw` |

憑證也可透過 `openclaw.json` 配置提供（見下方可選設定）。當兩者同時設定時，環境變數優先。

### 取得憑證

**藍信桌面端** → **通訊錄** → **智慧機器人** → **個人機器人** → 點擊 **ℹ️** 圖標

> ⚠️ **行動端不支援查看憑證。** 請僅使用桌面端。

### 可選設定

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
| `appId` | 個人機器人 App ID | — |
| `appSecret` | 個人機器人 App Secret | — |
| `apiGatewayUrl` | API 閘道 URL | `https://open.e.lanxin.cn/open/apigw` |
| `homeChannel` | 代理路由的預設頻道 | `lansenger` |
| `enabled` | 啟用/禁用頻道 | `true` |
| `allowFrom` | 允許私聊的使用者 ID | `[]` |
| `dmPolicy` | 私聊策略：`pairing`、`allowlist`、`open`、`disabled` | `pairing` |
| `accounts` | 多機器人設定 | — |
| `groupPolicy` | 群聊策略：`open`（所有群）、`allowlist`（僅允許列表群）、`disabled`（禁止群訊息） | `allowlist` |
| `groupAllowFrom` | 允許觸發機器人的群 ID | `[]` |
| `groups` | 群級設定（requireMention、enabled、allowFrom） | — |

### 多機器人設定

新增多個機器人時，使用 `openclaw config set` 配置 `accounts` 結構：

```bash
# 新增第二個機器人（替換 appid/appsecret/gateway 為你的值）
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

閘道啟動時自動連接所有已設定的帳戶。`lansenger.start` 方法可用於動態啟動額外帳戶。

### 啟動閘道（動態）

```bash
openclaw gateway call lansenger.start
```

### 停止閘道

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

使用 `bindings` 將藍信私聊或群組聊天路由至不同的 Agent（與飛書/WhatsApp 等相同模式）：

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

路由欄位：
* `match.channel`: `"lansenger"`
* `match.peer.kind`: `"direct"`（私聊）或 `"group"`（群組聊天）
* `match.peer.id`: 使用者 ID（`2285568-xxx`）或群組聊天 ID

單 Agent 模式下，所有訊息自動路由至預設 Agent（`main`），無需 bindings 設定。

### 羣聊策略

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

當使用者傳送圖片、影片、檔案或語音訊息時，插件會：

1. 透過藍信媒體 API 下載所有 `mediaIds`
2. 從 Content-Type/Content-Disposition 標頭偵測副檔名（回退：檔案魔數）
3. 儲存至暫存檔案，將路徑附加至 `InboundEvent.mediaPaths[]`
4. 在代理文字中加入提示：「附件已儲存至本地——使用讀取工具查看」

## 審批流程

支援審批卡片：
- 審批請求透過 **appCard**（`isDynamic=true`）傳送
- 狀態更新（待審批 → 已通過/已拒絕）透過 **DynamicMsg** 原地更新卡片
- 根據使用者偵測到的語言傳送中文或英文卡片
- **i18nAppCard**（5 語言）保留供未來使用，目前不用於審批

## 重要說明

- **無員工聊天概念**——藍信僅有群組聊天與私聊（DM），沒有「員工聊天」類型。
- **撤回 chatType**——僅支援 `bot` 與 `group`，沒有 `staff` 類型。
- **撤回無 sysMsg**——API 接受 `sysMsg` 但不會顯示。
- **無 deleteMessage**——API 回傳錯誤碼 10000，刪除訊息不可用。
- **appArticles**——使用 `summary` 欄位（不是 `description`）。
- **linkCard**——`description`、`iconLink`、`fromName`、`fromIconLink` 為必填欄位（可用空字串作為預設值）。
- **msgTarget 自動路由**——所有傳送方法自動路由，無需分別呼叫群組/私聊 API。
- **閘道 URL 因環境不同**——如 `https://apigw.lx.qianxin.com` 用於奇安信部署，`https://open.e.lanxin.cn/open/apigw` 用於標準藍信。
- **reminder**——formatText 中可選欄位；群組聊天中建議使用。提及使用者時在文字中包含「@姓名」。
- **媒體標籤**——`<media>` 標籤適用於工作區檔案；外部路徑請使用 `lansenger_send_file`。
- **openclaw skill/message lansenger**——這些 CLI 命令不存在；請使用代理工具。
- **代理工具**——代理工具（`lansenger_send_*`）需要工具插件且閘道注入成功——若工具不可用，請使用 CLI 作為備選。CLI 命令（`lansenger message send-*`）需要 `pipx install lansenger-cli`。

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
│   ├── channel.ts      # OpenClaw 頻道插件
│   ├── channel.test.ts # 頻道插件測試
│   └── runtime.ts      # 閘道運行時（方法、入站處理器）
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

### "行動端不支援查看憑證"

請僅使用**藍信桌面端**。行動端應用不顯示機器人憑證。

### "No binding for botId"

Agent 路由由 OpenClaw 的 `bindings[]` 設定管理——見[多 Agent 路由](#多-agent-路由)。單 Agent 模式下無需 bindings，訊息自動路由至預設 Agent。

### WebSocket 斷線

插件內建自動重連（指數退避：2s、5s、10s、30s、60s）與心跳（每 30s ping）。

### formatText vs text

- 使用 `formatText` 傳送 Markdown 回覆（預設）
- 使用 `text` 傳送附件（無 Markdown）
- 兩種類型均支援 @mention（透過 `reminder`）—提及時在文字中包含「@姓名」
- 兩者都需要時，傳送兩條獨立訊息

### 動態卡片更新失敗

審批狀態更新使用 DynamicMsg appCard 格式，`updateCardStatus()` 方法自動處理。

## 更新日誌

- **v3.1** — 多帳號設定精靈；dmPolicy 對齊 OpenClaw 標準（dmSecurity→dmPolicy + paired→pairing）；中英雙語提示文案；憑證 shouldPrompt 跳過已設定步驟；多帳號設定遷移清理
- **v3.0** — 新增 `lansenger_send_format_text` 工具（Markdown + @提及）；重寫 SKILL.md；修正 headStatusInfo description+colour 語義
- **v2.10** — appCard font-size px→pt 自動轉換；sendImageUrl 錯誤分類；工具註冊日誌
- **v2.9** — 狀態適配器；環境變數回退；uiHints 中文標籤；README 精簡（5 語言）
- **v2.8** — OpenClaw `bindings[]` 多 Agent 路由；groupPolicy/groupAllowFrom/groups 羣聊准入；SKILL.md AgentSkills 規範
- **v2.7** — 純物件工具註冊；運行時狀態取得 client/target
- **v2.6** — 無條件註冊工具；移除幽靈 delete_message
- **v2.5** — formatText reminder；AppArticles `summary`；撤回僅 bot/group
- **v2.4** — 修復訊息體組裝；appArticles/linkCard 欄位修復
- **v2.3** — 移除遺留群組/私聊傳送；全部透過 msgTarget 路由
- **v2.2** — 新增 9 個 agent 工具
- **v2.0** — 初始發佈

## 授權條款

MIT——詳見 [LICENSE](LICENSE)。

## 貢獻

1. Fork 此儲存庫
2. 建立功能分支
3. 進行修改
4. 執行測試：`npx vitest run`
5. 提交 Pull Request