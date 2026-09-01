# 功能测试方案（自动化回归保障）

> 目标：每次修改后，一条命令验证插件全部原有功能正常。当前状态：**530 个自动化测试**（507 单元 + 23 E2E），双 OpenClaw 版本（2026.7.1 / 2026.8.1）全绿。

## 一、测试金字塔（四层）

```
L3  真实网关冒烟（可选/夜间）   openclaw gateway + 假服务器 + 真实 agent
L2  E2E 功能测试 ★本次新增      真实插件代码 ↔ 真实本地服务器（假蓝信网关），零 mock
L1  单元测试（507）             快速、mock ws/fetch，覆盖分支与边界
L0  静态检查                    tsc --noEmit + build
```

## 二、L2 E2E 架构（test/e2e/）

```
┌────────────────────────────────────────────────────┐
│ vitest E2E（test/e2e/*.e2e.test.ts，23 用例）        │
│                                                     │
│  ┌──────────────┐  真实协议   ┌──────────────────┐ │
│  │ 真实插件代码   │ ←────────→ │ FakeLansengerServer│ │
│  │ client.ts     │  HTTP+WS   │ （node http + ws） │ │
│  │ runtime.ts    │            │ · 真实 API 契约    │ │
│  │ channel.ts    │            │ · 可控故障注入     │ │
│  │ （零 mock）    │            │ · 出站调用录制     │ │
│  └──────┬───────┘            └──────────────────┘ │
│         │ messageHandler                            │
│  ┌──────▼───────────────┐                           │
│  │ MiniHost（helpers.ts）│ 仅 OpenClaw 宿主面 stub   │
│  │ agent turn = 记录桩   │ （策略/防抖/投递=真实代码）│
│  └──────────────────────┘                           │
└────────────────────────────────────────────────────┘
```

**关键设计**：
- **零 ws/fetch mock**——生产客户端跑真实线协议（ping/pong 帧、close 码、HTTP 请求形状）
- **服务端可控故障注入**：`stopRespondingPongs()`（静默服务器，需翻转 ws 的 `_autoPong` 私有标志——ws 库默认自动回 pong）、`killAllSockets()`（服务端断连）、`rejectNextEndpoint()`（凭证失败 40018）
- **服务端连接计数 = 孤儿连接的"生产级神谕"**：`server.connectionCount(appId)` 直接断言"每账号恰一条连接"——正是线上假死症状的协议级回归检查
- **出站调用录制**：所有 HTTP 请求（路径/query/body）被记录，逐字段断言契约形状
- **测试隔离**：`cleanupRuntime()` 每用例后断开残留客户端并排空服务端 socket（否则连接计数跨用例泄漏）；`execFileSync` 已 mock（防真实写配置，见事故记录）

## 三、当前覆盖（23 E2E 用例）

| 套件 | 覆盖 |
|---|---|
| **connection（8）** | 连接+真实心跳保活；服务端断连→退避重连+新票据；**pong 超时→僵尸关闭→重连（真实 17s）**；凭证失败不拨号；多账号并行隔离；**孤儿连接回归（服务端连接数=1）**；巡检自愈；status 真实活性全程跟踪 |
| **messaging（8）** | DM/group 出站契约形状（userIdList/groupId）；formatText formatType=1；appCard px→pt 转换（description 字段）；appToken 缓存（两次发送一次取 token）；revoke/dynamic update 契约；入站事件播种 chatTypeCache→出站自动路由 |
| **pipeline（7）** | DM open→防抖→路由（文本+sessionKey）；allowlist 拒绝/放行；**防抖合并（两条消息一个 turn）**；ack 中文/英文语言检测+真实 HTTP 发送；pairing 配对码真实回复+消息丢弃；群 requireMention 开关 |
| **cli（5）** | 真实 `openclaw` CLI + 隔离 state dir：插件安装（版本自适应 flags）→ `channels add` 向导契约（appId/apiGatewayUrl 写入）→ 重复 add 幂等更新 → `channels list` 渠道识别 → `config validate` |
| **tools（7）** | 15 个工具注册完整性；send_text/format_text 契约 + deliveryContext 目标解析；显式 `to` 覆盖（入站播种群路由）；query_groups/revoke/send_approve_card 契约 |
| **approval（4）** | 审批卡闭环：授权审批人→卡片三态更新（真实 HTTP）；**未授权 staff→拒绝通知+卡片不动**；deny→红色拒绝态；未知 requestId→静默忽略 |

## 四、日常使用

```bash
npm test            # 全量：L0+L1+L2（约 1 分钟）
npm run test:unit   # 仅单元（约 20s，改代码快速反馈）
npm run test:e2e    # 仅 E2E（约 40s）

# 双版本验证（改 SDK 交互代码后必做）
npm install openclaw@2026.7.1 --no-save && npm test
npm install openclaw@2026.8.1 --no-save && npm test
```

### CLI 测试要点（踩坑记录）

- 向导输出经 `/dev/tty` 渲染——无 TTY 环境（CI/vitest worker）**不可捕获输出**，断言以**配置文件产物**为准
- 命名账号（`--account <id>`）流程被宿主 TTY 交互门控——无 TTY 下安全跳过（applySet 逻辑由单元测试覆盖），TTY 手动验证清单见下
- 插件安装 flags 随版本自适应：2026.8.1 需 `--force --accept-capabilities`（信任/能力门禁），2026.7.1 不支持该组合
- vitest 的 PATH 含 `node_modules/.bin` → CLI 测试自动使用矩阵版本的 openclaw（双版本 CLI 面覆盖）
- 安装记录写入 config（plugins.entries）——测试重置配置时须保留安装后基线

### 手动 TTY 验证清单（发布前）

```bash
# 交互式向导完整流（含 secret 掩码输入——自动化无法覆盖的部分）
openclaw channels add --channel lansenger          # 默认账号：appId → secret(掩码) → baseUrl
openclaw channels add --channel lansenger --account team-bot   # 命名账号流
```

## 五、CI（.github/workflows/ci.yml）

矩阵 `openclaw × [2026.7.1, 2026.8.1]`：tsc + 单元 + E2E，PR 与 main 推送触发。**任何 PR 必须双版本全绿才可合并。**

## 六、扩展指南（新功能如何补测试）

| 新功能类型 | 补测位置 | 模式 |
|---|---|---|
| 新出站 API | messaging.e2e | 调真实 client 方法 → 断言 server.calls() 的路径+body 形状 |
| 新入站策略 | pipeline.e2e | makeMiniHost 配置覆盖 → pushEvent → 断言 inbound.run / 出站录制 |
| 连接行为 | connection.e2e | FakeLansengerServer 故障注入旋钮 → waitFor 服务端可观测状态 |
| 新 SDK 依赖 | 双版本各跑一遍 | `npm install openclaw@<版本> --no-save && npm test` |

**新故障注入旋钮**：在 FakeLansengerServer 加可控行为（如延迟推送、错误码序列、半开握手脚本），比 mock 更接近真实。

## 七、L3 真实网关冒烟（可选，夜间）

```bash
# 隔离实例 + 假服务器 + 真实插件加载
OPENCLAW_STATE_DIR=/tmp/oc-smoke OPENCLAW_CONFIG_PATH=/tmp/oc-smoke/config.json \
  openclaw gateway --port 28789 &
# config: channels.lansenger.accounts.*.apiGatewayUrl → 假服务器地址
# 验证：插件加载日志、连接建立、假服务器 push → agent 回复 → 出站录制
```
适用发布前验证；日常回归以 L2 为准（已覆盖插件全部自有逻辑，L3 差异仅在 OpenClaw 宿主侧）。

## 八、战果记录（E2E 已发现的真实 bug）

1. **心跳 pong 超时在 `pingInterval < 15s` 时永不触发**（每个 ping 重新武装定时器互相取消；registry 允许 0-180s）——修复为逐 tick 陈旧度检查（阈值 15s+interval，兼顾首 pong宽限）
2. **心跳重写的首 tick 误杀**（20s 间隔下新连接 staleness=20s>15s 必误判）——阈值修正为 `PONG_TIMEOUT_MS + heartbeatIntervalMs`
3. **审批回调清理被网关解析阻塞**（双版本 E2E 发现）：`resolveApprovalOverGateway` 无活动网关时在 2026.7.1 上挂起 → 回调映射清理被阻塞 → 重复点击可重复处理。修复为**先清理映射再尽力解析**（防重复处理更安全）
4. **测试基建教训**：ws 库服务器自动回 pong（RFC 6455）——静默模拟必须翻转 `_autoPong`；`_clearTestState` 不断连接 → 跨用例连接泄漏 → 服务端计数神谕失效；向导输出走 `/dev/tty` → CLI 断言以配置产物为准；异步清理断言必须用 waitFor 而非立即断言
