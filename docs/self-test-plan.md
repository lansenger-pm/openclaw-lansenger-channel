# 完整自测计划（self-test-plan）

> 适用：`fix/zombie-lifecycle` 分支（基于 v3.18.3，兼容 OpenClaw 2026.7.1）。
> 目标：验证 P1/P2/N1/N2/P4 五项修复 + 高危场景日志完整性，确保无行为回归。
> 执行环境：本机（macOS，OpenClaw 网关本地运行，插件 `--link` 安装）。
> 前置：`npm install` 已完成；`~/.openclaw/openclaw.json` 已配置 ≥2 个 lansenger 账号（含一个键名 ≠ appId 的账号，如 `log-report`）。

---

## L0 静态检查（每次改动后必跑）

| # | 命令 | 通过标准 |
|---|---|---|
| 0.1 | `npx tsc --noEmit` | 0 error |
| 0.2 | `npm run build` | 成功产出 `dist/index.js`、`dist/setup-entry.js` |

## L1 单元测试（每次改动后必跑）

| # | 命令 | 通过标准 |
|---|---|---|
| 1.1 | `npx vitest run` | 全绿（基线 503 通过 + 1 skipped） |
| 1.2 | `npx vitest run src/lifecycle-fix.test.ts src/ws-robustness.test.ts` | 42 用例全绿（12 生命周期回归 + 30 长连接健壮性） |

### 长连接健壮性套件覆盖点（`src/ws-robustness.test.ts`，30 用例）

| 分组 | 覆盖点 |
|---|---|
| 1. 心跳与 pong 超时（6） | 健康多周期无假超时；15s 静默→优雅关闭→重连；半开 TCP→5s terminate 兑底；CLOSING 套接字→terminate；disconnect 后无 ping 泄漏；服务端关闭后心跳停止 |
| 2. 重连退避（6） | 2s 首次退避；连续失败递退 2→5→10s；成功 open 重置；60s 封顶；disconnect 后不重连（僵尸抑制）；onerror+onclose 双发只重连一次 |
| 3. 连接建立（6） | 端点 API 错误（40018）不建连；fetch 抛错不 crash；缺凭证快速失败；pingInterval 秒→毫秒转换与 20s 回退；重连采纳新间隔；双重 connect 防重复拨号 |
| 4. 入站消息（5） | 非文本帧跳过；Buffer 帧解码；畸形 JSON 忽略且连接存活；handler 异常隔离（连接不中断）；空 events 不触发 |
| 5. 巡检与自愈（7） | 僵尸检测自愈；12h 年龄轮换；健康连接不扰动；healAccount 身份跳过；lansenger.status 真实活性；lansenger.start 僵尸自愈；gatewayStartAccount 不采纳僵尸 |

### 生命周期回归套件覆盖点（`src/lifecycle-fix.test.ts`）

| 用例 | 验证的修复 |
|---|---|
| `assigns this.ws while CONNECTING … no eternal hang` | N1：CONNECTING 期 disconnect 有界返回 |
| `terminates a socket whose graceful close never completes` | P3：半开 TCP terminate 兜底 |
| `gives up waiting on a runWs loop that never settles` | P3：wsTask 10s 有界等待 |
| `reports connection age and pong age` | P4：可观测性访问器 |
| `resolves an account by its appId …`（4 例） | N2：appId 反查 + 原有回退行为保持 |
| `concurrent starts … exactly ONE client` | P1：互斥 + 采纳（旧代码会产生 2 个客户端） |
| `adopts the existing healthy client from autoStart` | P1：启动竞态采纳，不二次拨号 |
| `reconnects when config actually changed` | 采纳不会误吞配置变更 |
| `abort cleanup does not kill a newer context's client` | P2：身份检查防误杀 |

## L2 实机验证（构建后重启网关）

### 2.1 启动竞态（P1+N2 核心场景）

```bash
npm run build && openclaw gateway restart && sleep 25
```

**检查 1 — 日志形态**：
```bash
grep -E 'auto-started|gateway: (started|adopting|disconnecting)|WS connected' /tmp/openclaw/openclaw-$(date +%F).log | tail -15
```
- ✅ 每个账号 key 恰好一条 `gateway: started` **或** `gateway: adopting existing healthy WS`
- ✅ **不出现**同一 key 的两条 `gateway: started`（旧版 N2 实锤形态：`key=2285568-2580736 accountId=2285568-2580736` 与 `accountId=2285568-9937152` 同秒各一条）
- ✅ 不出现 `gateway: disconnecting existing WS` 后**没有** `gateway: started`（旧版 N1 挂起形态）

**检查 2 — 连接数**：
```bash
lsof -p $(pgrep -f 'gateway --port 18789' | head -1) -nP | grep ESTABLISHED | grep -v 127.0.0.1 | wc -l
```
- ✅ 等于**配置的账号数**（旧版实测 6/3，存在孤儿）

**检查 3 — 重复重启稳定性**：连续执行 2.1 三次，每次连接数均等于账号数。

### 2.2 巡检与健康快照（P4）

```bash
sleep 310   # 等第 10 个巡检 tick（每 30s 一次，每 10 tick 输出快照）
grep 'patrol:' /tmp/openclaw/openclaw-$(date +%F).log | tail -5
```
- ✅ 每账号一条快照：`patrol: key=… wsState=OPEN alive=true age=…s lastPongAge=…s`
- ✅ 无 `patrol: dead WS detected`（健康时）

### 2.3 状态真实性（P4）

经网关方法或 dashboard 查看 `lansenger.status`：
- ✅ 每账号输出 `wsAlive: true`、`wsState: "OPEN"`、`connectionAgeSec`、`lastPongAgeSec`
- ✅ `running` 字段 = 真实活性（非硬编码 true）

## L3 故障注入（验证自愈与日志，一项一项做）

### 3.1 配置变更重启（P2 身份检查）

```bash
openclaw config set channels.lansenger.accounts.<某账号>.ackMessageTextZh "测试"
# 触发网关重启后：
grep -E 'gateway: (disconnecting|started|stopped on abort|abort cleanup skipped)' /tmp/openclaw/openclaw-$(date +%F).log | tail -10
```
- ✅ 出现 `reason=config-changed` 的重建日志
- ✅ 若有 `abort cleanup skipped — entry now owned by another context` → P2 生效证明
- ✅ 重启后连接数仍 = 账号数

### 3.2 杀连接（自愈 + 静默死亡防回归）

```bash
# 找到一条 WS 连接并杀掉（替换 PID 为网关进程）
kill -9 <某个 node 子进程>   # 或断网 30s / 服务端重启
sleep 40
grep -E 'WS closed|WS reconnect|runWs: stopped|patrol: dead' /tmp/openclaw/openclaw-$(date +%F).log | tail -10
```
- ✅ 出现 `WS closed (appId=… age=…s)` + `WS reconnect in Ns` → 正常重连
- ✅ **不出现**只有 `WS closed` 而无后续 `WS reconnect`/`patrol:` 自愈（旧版静默死亡形态）
- ✅ 若 30s 内未重连，巡检 `patrol: dead WS detected … self-healing` 兜底

### 3.3 凭证失效（票据缓存掩蔽已知，验证报错可见性）

```bash
# 直测 token（预期 errCode=40018 的账号是已知问题账号）
curl -s "${apiGatewayUrl}/v1/apptoken/create?grant_type=client_credential&appid=${appId}&secret=${secret}"
```
- ✅ 失效账号在日志中有 `getAppToken: errCode=40018`（持续可见，不静默）
- ⚠️ 已知：WS 侧因 110min 票据缓存仍可连——这是服务端行为，插件侧无法修复

### 3.4 disconnect 竞态（N1 防回归，可选）

在 2.1 的重启窗口内（启动后 1s 内）观察：
- ✅ 若出现 `gateway: disconnecting existing WS`，其后**必然**跟着 `gateway: started` 或 `adopting`（旧版会永久挂起，`gateway: started` 永不出现）

## L4 功能回归（修复不应影响消息链路）

| # | 操作 | 通过标准 |
|---|---|---|
| 4.1 | 蓝信私聊机器人发 "hi" | 收到回复；日志有 `inbound` → `deliverReply` 全链路 |
| 4.2 | 群里 @机器人 | 收到回复（requireMention 语义不变） |
| 4.3 | 发图片/文件给机器人 | 媒体下载 + agent 处理正常 |
| 4.4 | 让 agent 用 `lansenger_send_format_text` 发 Markdown | formatText 正常（debounce onFlush 契约未破坏） |
| 4.5 | 审批卡按钮点击 | 卡片就地更新三态色 |
| 4.6 | 连发多条消息 | 防抖合并行为不变（debounceMs 配置） |

## L5 长稳观察（发布前 24h）

```bash
# 定期（或次日）检查：
lsof -p $(pgrep -f 'gateway --port 18789' | head -1) -nP | grep ESTABLISHED | grep -v 127.0.0.1 | wc -l   # 仍=账号数
grep -c 'patrol: dead WS' /tmp/openclaw/openclaw-$(date +%F).log    # 自愈次数（应为 0 或极少）
grep 'patrol:' /tmp/openclaw/openclaw-$(date +%F).log | tail -6     # 快照健康
```
- ✅ 24h 内连接数恒定 = 账号数；无孤儿累积；机器人全程响应；无"长连接异常断开"用户投诉

---

## 通过标准汇总

- L0/L1 全绿（**门禁，不过不进入实机**）
- L2.1 连续 3 次重启连接数 = 账号数，无同 key 双启动、无挂起形态
- L2.2/2.3 巡检快照与真实状态输出正常
- L3.1–3.3 各故障场景日志完整、自愈生效
- L4 消息链路 6 项全过
- L5 24h 长稳无异常

## 已知不修（服务端侧，记录在案）

1. Redis 会话断连不清理/24h TTL/后写覆盖 → 插件以 12h 连接轮换对冲
2. 票据缓存 110min 掩蔽凭证失效
3. 路由层失效协议不可见（无注册确认帧/路由心跳）