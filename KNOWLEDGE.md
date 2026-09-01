# KNOWLEDGE.md — openclaw-lansenger-channel 知识库

> 面向 AI 开发代理与新人工程师的项目知识库。事实均以代码与线上日志实证为准（2026-09-01 审计）。

## 1. 架构总览

```
┌────────────────────── OpenClaw 网关进程 ──────────────────────┐
│  openclaw (2026.7.1)                                           │
│   └─ 插件 lansenger（本仓库，dist/index.js，--link 安装）        │
│        ├─ runtime.ts   账号生命周期 + 入站管线 + 巡检            │
│        │    ├─ startAccount / _startAccountImpl   autoStart 路径│
│        │    ├─ gatewayStartAccount / gatewayStopAccount  宿主路径│
│        │    └─ healthPatrol / healAccount   30s 巡检 + 12h 轮换 │
│        ├─ client.ts    LansengerClient：WS 长连接（心跳/重连）    │
│        │                  + 全部出站 HTTP API + appToken 缓存    │
│        ├─ channel.ts   渠道适配器：账号解析/策略/出站路由/审批卡   │
│        ├─ tools.ts     15 个 lansenger_* agent 工具             │
│        └─ setup-wizard.ts  openclaw channels add 交互向导        │
└────────────────────────────────────────────────────────────────┘
     │ WS 纯入站（服务端推送，客户端只 ping）          ▲ HTTP 出站
     ▼                                              │
┌────────────────── 蓝信开平网关 lanxin-open-api-gateway ────────┐
│  /v1/ws/endpoint/create → wss://…/open/wss/v1?ticket=…          │
│  WsWorker: Redis 会话(24h TTL, 后写覆盖, 断连不清理) + 跨实例路由  │
│  /v1/apptoken/create、/v1/bot/messages/create、群/媒体/命令 API   │
└────────────────────────────────────────────────────────────────┘
```

## 2. 关键机制（数值全部实证）

### 2.1 心跳与重连（client.ts）

| 参数 | 值 | 来源 |
|---|---|---|
| ping 间隔 | **服务端下发**（endpoint/create 响应 `pingInterval` 秒→ms），当前 20000ms；缺省回退 20s | client.ts `getWsUrl` |
| pong 超时 | 15s（每个 ping 后臂定时器；超时 → 优雅 close → 5s terminate 兜底） | `PONG_TIMEOUT_MS` |
| 重连退避 | [2,5,10,30,60]s，成功清零，封顶 60s；每次重连重取新 URL | `RECONNECT_BACKOFF` |
| 僵尸检测 | lastPongAt 距今 > 2×心跳+15s（默认 55s）判死 | `isWsAlive()` |
| 巡检 | 30s 一次；连接年龄 > 12h 强制轮换（对冲服务端 24h 会话 TTL） | `healthPatrol` |

**关键前提**：重连仅在 `client.running === true` 时发生（runWs 在 closePromise 后检查）。`disconnect()` 置 `running=false` 后连接死亡即静默退出——这条路径现在有日志（`runWs: stopped ... exiting without reconnect`）。

### 2.2 账号生命周期（runtime.ts，2026-09-01 重构后）

```
三条创建客户端的路径，全部持有 withStartLock(key) 互斥：
  ① autoStart → startAccount（插件加载时，每次网关启动会跑 2 次：gateway + agent runtime）
  ② 宿主 → gatewayStartAccount（host 按 listAccountIds 通告的 appId 调用）
  ③ healthPatrol → healAccount（30s 巡检发现死连接/超龄连接）

锁内决策（gatewayStartAccount）：
  existing 存在？
    ├─ 配置未变 && isWsAlive → 采纳（adopt）：复用客户端，重绑 statusSink，不二次拨号
    └─ 配置已变 || 已死 → 有界 disconnect → 重建

abort 清理（P2 修复后）：按 client 引用身份判断，只拆自己创建/采纳的条目；
  条目已被新 context 接管时跳过并留日志。

采纳/重建/巡检异常/静默退出——全部有日志（grep 'adopting|reconnection|patrol:|exiting without'）。
```

### 2.3 账号标识语义（N2 修复后）

- `listAccountIds`（channel.ts）：对外**用 appId 作为账号 key** 通告给宿主。
- `resolveAccount`（channel.ts）：解析顺序 = 配置键字面匹配 → **appId 反查** → 首个有凭证账号（回退）→ 顶层 → 空。
- `inspectAccount`：同样含 appId 反查。**三处语义必须保持一致**。

### 2.4 服务端行为（排查时必须知道）

| 项 | 值 | 影响 |
|---|---|---|
| 票据缓存 | 110min（wss-endpoint-token-{appid}），**命中不验签** | appSecret 失效最多被掩蔽 110min；WS 能连 ≠ 凭证有效 |
| Redis 会话 | TTL 24h，断连**不清理**，同 appId **后写覆盖** | 旧连接死后会话仍指向死 connId → 推送失败 → 用户收"长连接异常断开"离线提示 |
| 服务端读超时 | 52s（32+20） | 客户端停 ping 52s 后被杀（客户端 15s pong 超时先触发） |
| 离线不补发 | STOP_IGNORE 位点照常推进 | 掉线期间消息不重推 |
| 事件合并 | bot_private_message 多事件只推最后一条 | 与插件侧防抖双重合并 |

### 2.5 出站 HTTP API 速查

`GET /v1/apptoken/create`（缓存至 expiresIn-300s）｜`POST /v1/bot/messages/create`（私聊，仅 owner）｜`POST /v1/messages/group/create`｜`POST /v1/app/medias/create`｜`GET /v1/medias/{id}/fetch`｜`POST /v1/messages/revoke`｜`POST /v1/messages/dynamic/update`｜`POST /v1/bot/commands/*`｜`GET /v2/groups/*`

msgType：text / formatText（Markdown，reminder 失败自动降级）/ linkCard / appCard（px→pt clamp[12,36]）/ approveCard / appArticles。

## 3. 核心编码约束（红线）

| # | 约束 | 违背后果（事故） |
|---|---|---|
| 1 | 账号启动必须走 `withStartLock(key)` 互斥 | P1：双客户端孤儿连接 → 假死 |
| 2 | 清理闭包按 client 身份判断，禁止只按 key | P2：abort 误杀新条目 → 静默死亡 |
| 3 | `disconnect()` 有界：close + 5s terminate + wsTask 10s 超时 | N1/P3：永久挂起 + running=false 假活 |
| 4 | `this.ws` 构造后立即赋值（不等 onopen） | N1：CONNECTING 期 disconnect 摸不到 socket |
| 5 | 高危路径必须留日志（带 appId） | 事故 8-24h 零日志无法定位 |
| 6 | 账号标识三处一致（含 appId 反查） | N2：主账号被宿主双启动 |
| 7 | debounce `onFlush` 必须走 `makeDualContractOnFlush`（运行时自适应双契约），禁止手写任一版本专属签名 | 单版本签名在另一版本上运行时 TypeError |
| 8 | devDependency `openclaw` 保持 `>=2026.7.1 <2026.9.0`（双源可解析）；改 SDK 交互后双版本各跑一遍测试 | 装不上依赖 / 单版本验证遗漏 |

## 4. 排障手册

### 4.1 机器人假死（不回消息、状态"正常"）

```bash
# ① 真实活性（P4 修复后 status 输出 wsAlive/wsState/lastPongAgeSec）
openclaw gateway call lansenger.status   # 或经 gateway method
# ② 巡检日志（30s 一次快照，异常有 warn）
grep -E 'patrol:|adopting|reconnection|exiting without' /tmp/openclaw/openclaw-$(date +%F).log | tail
# ③ 连接数 vs 账号数（应相等；多出的即孤儿）
lsof -p $(pgrep -f 'gateway --port 18789' | head -1) -nP | grep ESTABLISHED | grep -v 127.0.0.1 | wc -l
# ④ 服务端视角：用户发消息是否收到"机器人长连接异常断开"→ 是则服务端会话指向死连接
```

### 4.2 WS 能连但发消息失败

appSecret 大概率已失效（服务端轮换），票据缓存（110min）掩蔽了 WS 侧。直测：

```bash
curl "${apiGatewayUrl}/v1/apptoken/create?grant_type=client_credential&appid=${appId}&secret=${secret}"
# errCode=40018 → 密钥失效，去蓝信开平后台重置并更新 openclaw.json
```

### 4.3 启动期竞态验证

```bash
openclaw gateway restart && sleep 25
grep -E 'auto-started|gateway: (started|adopting|disconnecting)|WS connected' /tmp/openclaw/openclaw-$(date +%F).log | tail -15
# 健康形态：每 key 恰好一条 started 或 adopting；无同 key 双 started；连接数=账号数
```

## 5. 目录与模块速查

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/client.ts` | WS 客户端 + HTTP API + token 缓存 | `LansengerClient`、`MAX_CONNECTION_AGE_MS` |
| `src/runtime.ts` | 账号生命周期 + 入站管线 + 巡检 + 网关方法 | `startLansengerGateway`、`gatewayStartAccount/Stop`、`_clearTestState` |
| `src/channel.ts` | 渠道适配器（账号解析/策略/路由/审批） | `lansengerPlugin`、`resolveAccount` |
| `src/tools.ts` | 15 个 agent 工具 | — |
| `src/setup-wizard.ts` | channels add 向导 | `lansengerSetupWizard` |
| `src/lifecycle-fix.test.ts` | 生命周期回归套件（P1/P2/N1/N2） | — |
| `src/ws-robustness.test.ts` | 长连接健壮性套件（心跳/退避/容错/自愈） | — |
| `openclaw.plugin.json` | 插件清单（id=lansenger，工具契约） | — |

## 6. 事故档案

- **2026-09-01 假死事故（P1/P2/N1/N2）**：完整根因链与证据见 [docs/zombie-lifecycle-postmortem.md](docs/zombie-lifecycle-postmortem.md)。防回归测试：`src/lifecycle-fix.test.ts`。
