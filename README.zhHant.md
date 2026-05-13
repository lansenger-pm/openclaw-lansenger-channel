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
- **群組訊息路由**——自動偵測並路由至群組/私聊 API
- **@提及**——支援群組聊天中 @所有人 和 @指定使用者
- **入站媒體處理**——下載圖片/檔案/語音，偵測副檔名，向代理提供檔案路徑
- **訊息撤回**——撤回已傳送的訊息
- **自動啟動**——閘道啟動時自動連接所有已設定的機器人帳戶
- **零核心修改**——純插件模式，`git diff HEAD` 保持 PRISTINE

## 訊息類型能力矩陣

| msgType     | Markdown | @提及 | 附件 |
|-------------|----------|-------|------|
| `text`      | ✗        | ✓     | ✓    |
| `formatText`| ✓        | ✗     | ✗    |

**預設策略**：優先使用 `formatText` 傳送 Markdown 回覆。附件使用 `text` 回退。

## 快速安裝

### 透過 OpenClaw CLI（建議）

```bash
# 1. 安裝插件
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. 複製到 extensions 目錄（因 OpenClaw CLI 發現機制 bug）
mkdir -p ~/.openclaw/extensions/lansenger
cp -r ~/.openclaw/npm/node_modules/@lansenger-pm/openclaw-lansenger-channel/* \
     ~/.openclaw/extensions/lansenger/

# 3. 重啟閘道
openclaw gateway restart
```

> ⚠️ 第2步是必需的，因為 `openclaw channels add` 只發現 `extensions/` 目錄下的插件。這是 [OpenClaw 上游 bug](https://docs.openclaw.ai)。

### 透過 npm

```bash
# First install the npm package manually, then configure via CLI
npm install -g @lansenger-pm/openclaw-lansenger-channel
openclaw channels add --channel Lansenger --app-token "your-appid" --secret "your-appsecret"
```

### 開發安裝（本地連結）

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

## 快速配置

安裝後，配置憑證：

> **單帳號**：`channels add` 仅建立一個帳號。如需多個機器人，見下方[多機器人設定](#多機器人設定)。

```bash
# 標準安裝（使用預設閘道 https://open.e.lanxin.cn/open/apigw）
openclaw channels add --channel Lansenger \
  --app-token "你的-appid" \
  --secret "你的-appsecret"

# 企業私有化部署（自訂閘道地址）
openclaw channels add --channel Lansenger \
  --app-token "你的-appid" \
  --secret "你的-appsecret" \
  --base-url "https://apigw.lx.qianxin.com"
```

然後重啟：
```bash
openclaw gateway restart
```

取得憑證：**藍信桌面端** → **通訊錄** → **智慧機器人** → **個人機器人** → 點擊右側 **ℹ️** 圖標（行動端不支援查看憑證）。

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

### 取得憑證

**藍信桌面端** → **通訊錄** → **智能機器人** → **個人機器人** → 點擊 **ℹ️** 圖標

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
      "dmSecurity": "paired",
      "accounts": {
        "your-appid": {
          "appId": "your-appid",
          "appSecret": "...",
          "agentId": "main",
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
| `dmSecurity` | 私聊策略：`paired`、`allowlist`、`open` | `paired` |
| `accounts` | 多機器人設定 | — |

### 多機器人設定

> ⚠️ `openclaw channels add` 僅支援單帳號，每次執行會**覆蓋**之前的帳號。新增多個機器人需使用 `openclaw config set` 配置 `accounts` 結構。

透過 `channels add` 新增第一個帳號後，用 `openclaw config set` 新增更多機器人：

```bash
# 新增第二個機器人（替換 appid/appsecret/gateway 為你的值）
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

# 將不同機器人綁定至不同代理
openclaw config set channels.lansenger.accounts.your-appid-2.agentId "main"
openclaw config set channels.lansenger.accounts.your-appid-1.agentId "test"

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
      "dmSecurity": "paired",
      "accounts": {
        "your-appid-2": {
          "appId": "your-appid-2",
          "appSecret": "...",
          "agentId": "main",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        },
        "your-appid-1": {
          "appId": "your-appid-1",
          "appSecret": "...",
          "agentId": "test",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        }
      }
    }
  }
}

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
# 或
openclaw gateway call lansenger.status
```

### 綁定機器人至代理（配置方式）

機器人與代理的綁定透過帳戶設定的 `agentId` 或 OpenClaw `bindings[]` 實現：

```bash
# 按帳號設定 agentId（建議）
openclaw config set channels.lansenger.accounts.your-appid.agentId "main"

# 或透過 OpenClaw bindings[]
openclaw config set bindings '[{"agentId":"main","match":{"channel":"lansenger","peer":{"kind":"direct","id":"your-userid"}}}]'
```

> 多代理路由見[多機器人設定](#多機器人設定)。

## 支援的訊息類型

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
| `appArticles` | 多文章卡片 | `sendAppArticles()` | 出站 |
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
│   ├── runtime.ts      # 閘道運行時（方法、入站處理器）
│   └── bindings.ts     # 多機器人綁定管理器
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # 代理訊息策略
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

在帳戶設定中設定 `agentId`，或使用 OpenClaw `bindings[]` 設定多代理路由。

### WebSocket 斷線

插件內建自動重連（指數退避：2s、5s、10s、30s、60s）與心跳（每 30s ping）。

### formatText vs text

- 使用 `formatText` 傳送 Markdown 回覆（預設）
- 使用 `text` 傳送 @提及或附件
- 兩者都需要時，傳送兩條獨立訊息

### 動態卡片更新失敗

審批狀態更新使用 DynamicMsg appCard 格式，`updateCardStatus()` 方法自動處理。

## 授權條款

MIT——詳見 [LICENSE](LICENSE)。

## 貢獻

1. Fork 此儲存庫
2. 建立功能分支
3. 進行修改
4. 執行測試：`npx vitest run`
5. 提交 Pull Request