# CLAUDE.md — openclaw-lansenger-channel

> OpenClaw 蓝信渠道插件（TypeScript）。本文件是 Claude Code 的工作上下文；通用纪律见 [AGENTS.md](AGENTS.md)，深度机制见 [KNOWLEDGE.md](KNOWLEDGE.md)，文件地图见 [NAVIGATION.md](NAVIGATION.md)。

## 项目身份

- npm 包 `@lansenger-pm/openclaw-lansenger-channel`，以 `--link` 安装于 `~/.openclaw/extensions/openclaw-lansenger-channel`，OpenClaw 网关加载 `dist/index.js`。
- **兼容基线 OpenClaw 2026.7.1 + 2026.8.1 双版本**（onFlush 双契约自适应；改 SDK 交互代码需双版本验证）。
- 数据流：蓝信开平网关 --WS 推送--> 插件 --> OpenClaw agent --> 插件 --HTTP API--> 蓝信。WS 纯入站，HTTP 纯出站。

## 核心编码约束（带正反例）

### 1. 账号启动必须走 per-key 互斥

```ts
// ✅ 正确：所有创建客户端的路径（startAccount / gatewayStartAccount / healAccount）都持锁
await withStartLock(key, async () => { /* 检查 existing → 采纳或重建 */ });

// ❌ 错误：绕过锁直接 makeClient + connect
const client = makeClient(account, sdkLogger());
await client.connect();   // 与其他路径竞态 → 孤儿连接 → 假死（P1 事故）
```

### 2. 清理闭包按 client 身份判断，不按 key

```ts
// ✅ 正确：只拆自己创建/采纳的客户端
const e = runningAccounts.get(key);
if (e && e.client === clientRef) { await e.client.disconnect(); runningAccounts.delete(key); }

// ❌ 错误：按 key 拿到谁就拆谁（abort 误杀新 context 的活连接 → 服务端会话指向死连接）
const e = runningAccounts.get(key);
if (e) { await e.client.disconnect(); runningAccounts.delete(key); }
```

### 3. disconnect() 必须有界

```ts
// ✅ 正确：close + 5s terminate 兜底 + wsTask 10s 超时（见 client.ts disconnect/closeWsWithFallback）
// ❌ 错误：只 ws.close() 然后 await this.wsTask —— 半开 TCP / CONNECTING 期会永久挂起（N1 事故）
```

### 4. this.ws 在构造后立即赋值（不等 onopen）

```ts
// ✅ 正确：runWs 内 new WebSocket(url) 后立即 this.ws = ws
// ❌ 错误：在 onopen 里才赋值 —— disconnect() 在 CONNECTING 期找不到 socket（N1 事故根因）
```

### 5. 高危路径必须留日志

连接生死（带 appId、wsState、age）、采纳/重建决策、巡检异常、静默退出（`runWs: stopped ... exiting without reconnect`）——**宁可多不可无**。假死事故 8-24h 零日志，根因定位全靠事后补日志。

### 6. 账号标识三处必须一致

`listAccountIds`（对外通告 appId）、`resolveAccount`（key → 账号，**必须含 appId 反查**）、`inspectAccount`（含 appId 反查）。任何一处缺失反查 → host 用 appId 启动时解析回退到第一个账号 → 双启动（N2 事故）。

### 7. 日志带 appId 前缀

```ts
// ✅ `WS closed (appId=2285568-2580736 code=1005 ... age=3600s)`
// ❌ `WS closed (code=1005 ...)`  ← 多账号并发时无法归因
```

## 测试约束

- WS 用 `vi.mock("ws")`，fetch 用 `vi.stubGlobal`；禁止真实网络。
- 生命周期测试：`gatewayStartAccount` 返回的 promise 到 abort 才 resolve，**不要直接 await**（会超时）；`const p = ...` + `setTimeout` 等待 + `Promise.allSettled([p])` 收尾。
- 回归套件：`src/lifecycle-fix.test.ts`（P1/P2/N1/N2 专项，12 用例）+ `src/ws-robustness.test.ts`（长连接健壮性，30 用例）——改生命周期/连接代码后必跑。
- fake timers 用例必须 `vi.useRealTimers()` 兜底。

## 常用命令

```bash
npx tsc --noEmit && npx vitest run && npm run build   # 提交前三连
openclaw gateway restart                               # 实机加载（--link 安装，build 后重启即生效）
grep -E 'patrol:|gateway:|WS ' /tmp/openclaw/openclaw-$(date +%F).log | tail -30   # 看插件日志
```

## 排障速查（详见 KNOWLEDGE.md「排障」节）

| 症状 | 第一反应 |
|---|---|
| 机器人不回消息、无断连日志 | `lansenger.status` 看 wsAlive/wsState；看 `patrol:` 日志；数 ESTABLISHED 连接数 vs 账号数 |
| WS 能连但发消息失败 | appSecret 可能已失效（票据缓存掩蔽 110min）——直测 `/v1/apptoken/create` |
| 连接数 > 账号数 | 孤儿连接回归——检查启动路径是否都持锁 |
| 重启后主账号被启动两次 | resolveAccount appId 反查回归（N2） |
