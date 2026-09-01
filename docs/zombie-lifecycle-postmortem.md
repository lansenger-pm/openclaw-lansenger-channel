# 假死事故复盘（zombie-lifecycle postmortem）

> 事故：蓝信机器人运行 8–24 小时后"假死"——不回消息、插件状态显示运行中、无任何断连日志；服务端给用户推"机器人长连接异常断开"离线提示。
> 审计日期：2026-09-01（基于 v3.18.3 源码 + 当日网关日志 + 受控复现）。
> 修复分支：`fix/zombie-lifecycle`（基于 v3.18.3）。防回归测试：`src/lifecycle-fix.test.ts`（12 用例）。

## 1. 根因链（实证）

```
网关重启/配置变更
  ├─ 路径A: autoStart → startAccount（startingAccounts 互斥）
  └─ 路径B: 宿主 → gatewayStartAccount（无互斥；且 N2 使主账号被宿主调 2 次）
       │
       ├─ 交错①（实测 13:37:18）：双方各建一条连接 → runningAccounts 最后写入者胜出
       │    → 孤儿客户端：连接健康、无人引用、永不清理（3 账号 6 连接实锤）
       │
       ├─ 交错②（实测 13:21:46）：gatewayStartAccount 在 autoStart 客户端 CONNECTING 期
       │    调 disconnect() → this.ws 为 null → close() 跳过 → await wsTask 永久挂起
       │    → gatewayStartAccount promise 永久泄漏；客户端 running=false 但握手照常完成
       ▼
  【潜伏期：数小时～一天】连接健康，机器人正常工作
       ▼ 首次网络抖动 / pong 超时（15s 检测）
  连接死亡：
  ├─ 交错② 的 running=false 客户端 → runWs 直接 return：不重连、零日志（静默死亡）
  ├─ 交错① + P2：abort 清理按 key 误杀新条目 → 服务端 Redis 会话指向死 connId
       ▼
  服务端会话（TTL 24h、断连不清理、后写覆盖）→ 推送失败 → 用户收离线提示
  插件侧 lansenger.status 硬编码 running:true，无周期巡检 → 假死不可见
```

## 2. 缺陷清单与修复对照

| ID | 缺陷 | 修复 | 测试 |
|---|---|---|---|
| P1 | `gatewayStartAccount` 无 in-flight 去重，与 `startAccount` 互不感知 | 统一 `withStartLock(key)` per-key 互斥；锁内"采纳或重建"决策 | `concurrent starts create exactly ONE client` |
| P2 | abort 清理闭包只捕获 key，误杀新 context 的条目 | 按 client 引用身份判断；条目已被接管时跳过并留日志 | `abort cleanup does not kill a newer context's client` |
| N1/P3 | `disconnect()` 在 CONNECTING 期 `this.ws` 为 null → close 跳过 → `await wsTask` 永久挂起 | `this.ws` 构造后立即赋值；close+5s terminate 兜底；wsTask 10s 有界等待 | `assigns this.ws while CONNECTING` / `terminates ... half-open` / `gives up waiting` |
| N2 | `listAccountIds` 通告 appId，但 `resolveAccount` 无 appId 反查 → host 启动 log-report 时解析回退到主账号 → 主账号双启动 | `resolveAccount` 增加 appId 反查（与 `inspectAccount` 对齐） | `resolves an account by its appId` |
| P4 | `lansenger.status` 硬编码 running:true；无周期巡检 | status 输出 wsAlive/wsState/connectedAt/lastPongAgeSec；30s 巡检 + 死连接自愈 + 12h 连接轮换 | （巡检由实机验证覆盖） |

## 3. 补充日志（高危场景全覆盖）

| 场景 | 日志 |
|---|---|
| 静默退出（旧版零日志的直接死因） | `runWs: stopped while WS closed — exiting without reconnect (appId=…)` |
| 连接生死 | `WS connected (appId=… url=…)` / `WS closed (appId=… code=… age=…s)` |
| 采纳决策 | `gateway: adopting existing healthy WS (key=… age=…s)` |
| 重建决策 | `gateway: disconnecting existing WS for reconnection (key=… reason=config-changed|ws-dead)` |
| abort 身份跳过 | `gateway: abort cleanup skipped — entry now owned by another context` |
| disconnect 异常路径 | `no live WS reference` / `graceful close incomplete … terminating` / `runWs did not settle within 10s` |
| 巡检 | 快照（每 5min）`patrol: key=… wsState=… alive=… age=… lastPongAge=…`；异常 `patrol: dead WS detected … self-healing` / `connection age …h — rotating` |
| 重连 | `WS reconnect in Ns (attempt M, appId=…)` |

## 4. 遗留风险（插件侧无法根治，需服务端配合）

1. 服务端 Redis 会话断连不清理 + 24h TTL + 后写覆盖——插件侧靠 12h 轮换对冲，根治需服务端续期/清理。
2. 心跳只验证传输层，路由层失效（会话丢失/错位）协议上不可见——靠巡检 + 轮换降低暴露窗口。
3. 票据缓存 110min 掩蔽凭证失效（当日实测：主账号 appSecret 13:20 失效，WS 正常到 13:49）。

## 5. 教训（已沉淀为红线，见 KNOWLEDGE.md §3）

- 生命周期代码的清理闭包**永远按身份（对象引用）判断**，不按 key。
- 任何 `await` 一个不受自己控制的 promise 的地方，**必须有超时**。
- 异步状态机的每个退出路径**必须有日志**——"零日志"本身就是缺陷。
- 对外通告的标识（appId）与内部解析（配置键）之间**必须有双向映射**。
