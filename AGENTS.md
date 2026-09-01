# 项目指令（AGENTS.md）

> 本仓库为 **openclaw-lansenger-channel**：OpenClaw 的蓝信（Lansenger）渠道插件（TypeScript + ws，npm 包 `@lansenger-pm/openclaw-lansenger-channel`）。
> 以 `--link` 方式安装在 `~/.openclaw/extensions/openclaw-lansenger-channel`，由 OpenClaw 网关直接加载 `dist/`。
> 深度知识：[KNOWLEDGE.md](KNOWLEDGE.md)；导航：[NAVIGATION.md](NAVIGATION.md)；线上事故复盘：[docs/zombie-lifecycle-postmortem.md](docs/zombie-lifecycle-postmortem.md)。

## 项目身份（先读）

- **单一职责**：把蓝信个人机器人（INDIVIDUAL 应用，callback_type=websocket）接入 OpenClaw——WS 长连接收事件（入站），HTTP API 发消息（出站）。
- **运行环境**：OpenClaw 网关进程内（非独立进程）。一个插件实例管理**多账号**（每账号一个 WS 客户端）。
- **协议方向性**：WS 是**纯服务端推送通道**（服务端丢弃客户端上行数据帧）；所有出站走 HTTP API。心跳是客户端 ping → 服务端 pong。
- **兼容性基线**：OpenClaw **2026.7.1 与 2026.8.1 双版本**（`makeDualContractOnFlush` 运行时自适应防抖契约；devDep `>=2026.7.1 <2026.9.0`，内网源装 2026.7.1、外网源装 2026.8.1）。改 debounce/SDK 交互代码时必须在两个版本下各跑一遍 `npx vitest run`（`npm install openclaw@<版本> --no-save` 切换）。

## 搜索与文件检索纪律（强制）

1. 源码全部在 `src/`（约 3400 行），测试与源码同目录（`src/*.test.ts`）——检索直接指向 `src/`，禁止对仓库根全量 grep。
2. Grep 不遵循 .gitignore：命中 `node_modules/`、`dist/` 的结果视为无效，不得当结论引用。
3. 需要看运行日志时：`/tmp/openclaw/openclaw-$(date +%F).log`（JSON lines，取 `message` 字段）；launchd 日志可能被 doctor 输出污染，优先用前者。

## 单测纪律（核心，强制）

凡**新增或修改可测逻辑**，必须同步编写单测并**测试通过**，否则不得视为完成。

1. **强制配套**：测试放 `src/<模块>.test.ts` 或专门的回归套件（如 `src/lifecycle-fix.test.ts`）；覆盖正常路径 + ≥2 类边界（空值/非法输入/竞态/超时）。
2. **WS 必须 mock**：`vi.mock("ws", ...)`（参考 `src/client.test.ts` 的 MockWebSocket——构造后 `setTimeout(0)` 自动 open；`close()` 立即触发 onclose）。测试禁止真实网络。
3. **fetch 必须 stub**：`vi.stubGlobal("fetch", ...)`，按 URL 片段分流（`ws/endpoint` / `apptoken` / `messages/create`）。
4. **fake timers 纪律**：用到 `vi.useFakeTimers()` 的用例必须在 `afterEach` `vi.useRealTimers()` 兜底（vitest.config.ts 无全局 setup，靠用例自觉）。
5. **生命周期类测试不要直接 `await gatewayStartAccount(...)`**：它返回的 promise 到 abort 才 resolve——先 `const p = gatewayStartAccount(ctx)`，用 `setTimeout` 等待，最后 `await Promise.allSettled([p])`。
6. **提交前**：`npm test` 全绿（单元 + E2E）+ `npx tsc --noEmit` 0 error + `npm run build` 产出 `dist/`（网关加载的是 dist，**改完源码必须重新 build 才生效**）；改 SDK 交互代码需双版本验证（见约束 8）。

## 编码约束（红线，详见 KNOWLEDGE.md「核心编码约束」）

1. **同一 appId 任意时刻最多一个活动客户端**——所有账号启动路径必须走 `withStartLock(key, ...)` 互斥（P1 教训：两条启动路径互不感知 → 孤儿连接 → 假死）。
2. **清理闭包必须按身份（client 引用）判断，禁止只按 key**（P2 教训：abort 误杀新条目 → 服务端会话指向死连接 → 静默假死）。
3. **`disconnect()` 必须有界返回**：close + 5s terminate 兜底 + wsTask 10s 超时（N1 教训：CONNECTING 期 this.ws 为 null → 永久挂起）。
4. **高危路径必须留日志**：连接生死、采纳/重建、巡检发现异常、静默退出——宁可多不可无（教训：假死 8-24h 零日志无法定位）。
5. **`resolveAccount` 与 `listAccountIds`/`inspectAccount` 的账号标识语义必须一致**（N2 教训：appId 反查缺失 → 主账号被双启动）。
6. 改 `onFlush` debounce 契约前先确认 OpenClaw 版本：2026.7.1 是 `Promise<void>`，2026.8.1 是 `InboundDebounceFlush`。
7. 日志必须带 `appId=`（多账号并发时否则无法归因）。

## 提交纪律

1. **提交前验证（缺一不可）**：`npx tsc --noEmit` + `npx vitest run` 全绿 + `npm run build` 成功。
2. **独立需求原子提交**：修复 / 文档 / 测试分开提交；提交信息标注缺陷标识（如 `fix(P1): ...`、`fix(N2): ...`）。
3. **git 红线**：永远不要自行执行 `git stash` / `git reset --hard` / `git checkout .` 等丢弃改动类命令；只提交自己本次任务的改动。
4. 发布走 `prepublishOnly`（tsc + vitest）；版本号遵循 semver，CHANGELOG.md 必须同步。

## 约束沉淀纪律（每个任务收尾自查）

1. 开发中发现新的坑/反模式且具备普适性 → 沉淀到 [KNOWLEDGE.md](KNOWLEDGE.md)「核心编码约束」（带 ✅/❌ 正反例）。
2. 线上问题必须写复盘（`docs/<问题>-postmortem.md`）：根因链 + 证据 + 修复 + 防回归测试。
3. 新增目录/入口/依赖 → 同步 [NAVIGATION.md](NAVIGATION.md)。
4. 自查结论（更新了什么 / 为什么无需更新）在交付报告中说明。

## 常用命令

```bash
npm install            # 安装依赖（内网 registry，openclaw 依赖 ^2026.7.1）
npm run build          # tsc → dist/（网关加载的是 dist，改完必须 build）
npx tsc --noEmit       # 类型检查
npm test               # 全量：单元 + E2E（530+，约 1 分钟）
npm run test:unit     # 仅单元（快速反馈）
npm run test:e2e      # 仅 E2E（真实协议，test/e2e/）

# 实机验证（插件以 --link 安装，改完 build + 重启网关即生效）
openclaw gateway restart
tail -f /tmp/openclaw/openclaw-$(date +%F).log | grep -E 'lansenger|gateway:|patrol:|WS '
lsof -p $(pgrep -f 'gateway --port 18789' | head -1) -nP | grep ESTABLISHED | grep -v 127.0.0.1 | wc -l   # 连接数应=账号数
```

## 已知技术要点（避坑）

- 服务端票据缓存 110min：WS 端点签发命中缓存时**不重新验签**——appSecret 失效最多被掩蔽 110 分钟（排查凭证问题时先 `GET /v1/apptoken/create` 直测，别信 WS 能连=凭证正常）。
- 服务端 Redis 会话 TTL 24h、断连不清理、同 appId 后写覆盖——插件侧靠 12h 连接轮换（`MAX_CONNECTION_AGE_MS`）对冲。
- 服务端读超时 52s（32+20）：客户端 ping 停止 52s 后服务端杀连接；客户端侧 pong 超时 15s 先触发。
- `expiresIn` 字段插件未消费（依赖重连换新 URL 兜底）。
- 多账号日志归因靠 `appId=` 前缀（v3.18.3 之前的日志没有，翻旧日志时注意）。