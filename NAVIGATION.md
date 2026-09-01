# openclaw-lansenger-channel — 项目导航

> 快速定位代码与文档。深度机制见 [KNOWLEDGE.md](KNOWLEDGE.md)，开发纪律见 [AGENTS.md](AGENTS.md)。

## 项目身份

| 项 | 值 |
|---|---|
| 包名 | `@lansenger-pm/openclaw-lansenger-channel` |
| 角色 | OpenClaw 的蓝信（Lansenger）渠道插件 |
| 语言/运行时 | TypeScript / Node ≥20，`ws` 库 |
| 兼容基线 | OpenClaw **2026.7.1**（勿升 2026.8.x，见 KNOWLEDGE 约束 8） |
| 安装方式 | `openclaw plugins install --link .`（网关加载本目录 `dist/`） |
| 测试 | vitest，`npx vitest run`（473+ 用例） |

## 目录结构

```
openclaw-lansenger-channel/
├── src/
│   ├── client.ts            # LansengerClient：WS 连接/心跳/重连 + 全部出站 HTTP API
│   ├── runtime.ts           # 账号生命周期（互斥/采纳/巡检）+ 入站管线 + 网关方法
│   ├── channel.ts           # 渠道适配器：resolveAccount/策略/出站路由/审批卡能力
│   ├── tools.ts             # lansenger_* agent 工具（15 个）
│   ├── setup-wizard.ts      # openclaw channels add 交互向导
│   ├── command-i18n.ts      # 斜杠命令 5 语种文案
│   ├── persistent-store.ts  # 审批卡/回调持久化（~/.openclaw/lansenger-*.json）
│   ├── secret-contract.ts   # SecretRef 契约
│   ├── client.test.ts       # 客户端单测（含 WS mock）
│   ├── runtime.test.ts      # 运行时单测（入站管线/策略/投递）
│   ├── channel.test.ts      # 适配器单测（resolveAccount 等）
│   ├── lifecycle-fix.test.ts# ★ 生命周期回归套件（P1/P2/N1/N2 防回归）
│   └── *.test.ts            # 其余单测
├── skills/                  # 随插件分发的 SKILL（lansenger-messaging / lansenger-setup）
├── docs/
│   ├── zombie-lifecycle-postmortem.md   # ★ 假死事故复盘（必读）
│   └── self-test-plan.md                # ★ 完整自测计划
├── dist/                    # 构建产物（网关加载；改源码必须重新 build）
├── AGENTS.md / CLAUDE.md / KNOWLEDGE.md / NAVIGATION.md   # AI 开发文档体系
├── CHANGELOG.md
└── openclaw.plugin.json     # 插件清单（id=lansenger）
```

## 功能 → 代码索引

| 功能 | 入口 | 关键函数/位置 |
|---|---|---|
| WS 连接/心跳/重连 | `src/client.ts` | `connect` / `runWs` / `startHeartbeat` / `disconnect` / `closeWsWithFallback` |
| 账号启动（互斥/采纳） | `src/runtime.ts` | `withStartLock` / `startAccount` / `gatewayStartAccount` |
| 健康巡检/连接轮换 | `src/runtime.ts` | `healthPatrol` / `healAccount`（30s / 12h） |
| 账号解析（appId 反查） | `src/channel.ts` | `resolveAccount` / `listAccountIds` / `inspectAccount` |
| 入站管线（防抖→策略→路由→投递） | `src/runtime.ts` | `handleInbound` 及其子步骤 |
| 出站消息（text/formatText/卡片） | `src/client.ts` | `sendText` / `sendFormatText` / `sendAppCard` / … |
| 审批卡闭环 | `src/runtime.ts` + `src/channel.ts` | `pendingApprovalCallbacks` / `updateCardStatus` |
| 斜杠命令同步 | `src/runtime.ts` | `syncLansengerNativeCommands`（先删后建，30s 重试 ≤3） |
| 状态上报 | `src/runtime.ts` | `lansenger.status`（真实活性）+ `buildAccountSnapshot` |

## 关键数值速查

ping=服务端下发(20s) · pong 超时 15s · 重连退避 2/5/10/30/60s · 巡检 30s · 连接轮换 12h · 票据缓存 110min · 服务端会话 TTL 24h · 服务端读超时 52s · appToken 7200s（提前 300s 刷新）· 文本分块 4000 字符 · 群查询缓存 5min

## 常用命令

```bash
npx tsc --noEmit && npx vitest run && npm run build   # 提交前三连
npx vitest run src/lifecycle-fix.test.ts              # 生命周期回归
openclaw gateway restart                              # 实机加载修复版
grep -E 'patrol:|gateway:|WS |adopting' /tmp/openclaw/openclaw-$(date +%F).log | tail -30
```
