# Project Rules for openclaw-lansenger-channel

## Publish Checklist (MANDATORY before every `npm publish`)

This project has a `"files"` allowlist in `package.json`. Any file NOT explicitly listed there will be EXCLUDED from the npm tarball, even if it exists in `dist/`.

### 1. Check uncommitted changes and version BEFORE publishing

```bash
git status --short
echo "Current version: $(node -p "require('./package.json').version")"
cat VERSION
```

- **NEVER publish when there are modified or untracked source files** that `tsc` will compile.
- **Double-check the version number** is correct (semver). npm versions are permanent and CANNOT be deleted.
- **Update `VERSION` file** to match `package.json` version. This file is used by external tooling.
- `prepublishOnly` runs `tsc` against the WORKING DIRECTORY, not the committed code. Any uncommitted source changes will leak into the build output, and if the corresponding file is not in the `"files"` allowlist, the package will be BROKEN.

### 2. Verify tarball contents with `npm pack --dry-run`

```bash
npm run build && npm pack --dry-run 2>&1
```

Check that every file referenced by `import` statements in the compiled output is present in the tarball. Pay special attention to:

- New files added to `src/` must also be added to `package.json` `"files"` array by their `dist/` path.
- Files MUST use the explicit path pattern (e.g., `dist/src/new-file.*`) in the `"files"` array.

### 3. When adding a new source file to `src/`

Add the corresponding `dist/src/` pattern to `package.json` → `"files"` array immediately. Example:

```json
"dist/src/new-module.*"
```

### 4. Build and test before EVERY publish

```bash
npm run build && npm test
```

## Commit Rules

- Never leave modified source files uncommitted when publishing.
- Always `git status` before commit to ensure all related changes are staged.
- Do NOT selectively commit only the "fix" while leaving dependent changes (like new files) uncommitted.

## Past Incidents

**Work Rules**

- **Never `git checkout --` or `git restore` files to discard changes**. This irreversibly overwrites all local modifications. Use `git stash` instead if you need a clean state.
- **Discuss the plan before coding**. Before making changes, research how the OpenClaw core SDK and other channel plugins (Signal, Discord, Matrix, Telegram, etc.) implement similar functionality. Reference their patterns — never fabricate or guess SDK APIs.

### 2026-06-04 — v3.15.0 mistakenly published

- **Root cause**: During the gateway restart-recovery feature, the version in `package.json` was incorrectly bumped to `3.15.0` instead of `3.14.3`. The incorrect version was published to npm. A corrected `3.14.3` was published ~35 seconds later, but v3.15.0 cannot be deleted from npm.
- **Impact**: Users with `^3.14.0` dependency range resolved to `3.15.0` (highest semver match), getting the wrong version.
- **Fix**: Deprecated v3.15.0 on npm with a warning message.
- **Lesson**: **Double-check version number in package.json before publishing.** npm versions are permanent.

### 2026-06-17 — v3.14.5 broken (missing persistent-store.js)

- **Root cause**: `src/persistent-store.ts` was an uncommitted file. `src/runtime.ts` was modified (uncommitted) to import from it. When `prepublishOnly` ran `tsc`, it compiled both into `dist/`, producing `dist/src/runtime.js` with `import ... "./persistent-store.js"`. But `persistent-store.*` was NOT in `package.json` `"files"` allowlist, so it was excluded from the tarball. Users got a broken package.
- **Fix**: Committed `persistent-store.ts` and `runtime.ts`, added `dist/src/persistent-store.*` to `package.json` `"files"`.
- **Lesson**: Always check `git status` and `npm pack --dry-run` before publishing.

## Test Environment

### Accounts
- **测试账号**: `13107200-4218880`（t.lanxin.cn 测试网关）
- **另一个账号**: `2285568-10117376`（qianxin enterprise gateway）
- **测试用户 staff ID**: `13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk`

### Groups
- **群1 (PAaw)**: `13107200-x7u5atkggMJGS578zmRCG2o2gIGPAaw`
- **群2 (jM5e)**: `13107200-9WuAt5RRodktqvoDmrFrx9xkIBjM5e`

> 所有 ID 大小写敏感。群 ID 在 WS 事件中保留原始大小写，但 SDK session key 中为小写。

### Webhook 模拟测试
```bash
BASE="http://localhost:18789/lansenger/webhook?accountId=13107200-4218880"
curl -s -X POST "$BASE" -H "Content-Type: application/json" -d '{"events":[{"type":"bot_group_message","data":{"msgType":"text","msgData":{"text":{"content":"hello"}},"chatType":"group","from":"13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk","groupId":"13107200-x7u5atkggMJGS578zmRCG2o2gIGPAaw","reminder":{"isAtMe":true,"isAtAll":false}}}]}'
```

### 查看日志
```bash
tail -f ~/Library/Logs/openclaw/gateway.log | grep -E "group allowed|group dropped|requireMention|sender.*not in"
```

### SDK 要点

- **ID 大小写**: 所有 Lansenger ID 大小写敏感，从 WS 事件原样保留。但 SDK `resolveAgentRoute` 会把 session key 中的 ID 转小写。
- **`resolveRequireMention`**: SDK 只读取 `groups.<id>.requireMention`（per-group 级别）。如果需要在 account/section 级设置，需要通过 `requireMentionOverride` 参数传入。
- **`resolveGroupPolicy` workaround**: SDK 在 `open` 模式下，如果配置了 groups 条目，会把不在 map 里的群误拦。需要在代码中 workaround。
- **`openclaw config unset` 陷阱**: `unset groups.<id>.enabled` 如果对象里还有其他字段，会留下空对象 `{}`，SDK 将其视为有效 groupConfig。需要 `unset` 整个 `groups.<id>`。
- **Command 接口限制**: 不带 `/` 前缀，name 只允许 `[a-zA-Z0-9_]`。scopeType: 5=所有群，6=所有私聊。

### 配置优先级总览

| 配置项 | 优先级 |
|--------|--------|
| `groupPolicy` | account > section（含 SDK workaround 判断） |
| `groupAllowFrom` | per-group > account > section |
| `requireMention` | per-group(SDK) > account(override) > section(override) > SDK default |
| `autoMentionReply/autoQuoteReply` | per-group > account > section |
| `respondToAtAll` | per-group > account > section > false |

## Local Testing Workflow

**OpenClaw 插件加载机制**：OpenClaw 使用自己的扩展目录 `~/.openclaw/extensions/<plugin-id>/`，不读取 npm 全局安装路径。`npm link` 和 `npm install -g` **均无效**。

### 本地安装插件（每次代码修改后）

```bash
# 构建 → 测试 → 安装到 OpenClaw 扩展目录 → 重启网关
npm run build && npm test && openclaw plugins install . --force && openclaw gateway restart
```

**参数说明**：
- `openclaw plugins install .` — 从当前目录安装插件到 `~/.openclaw/extensions/`
- `--force` — 强制覆盖已存在的插件
- `openclaw gateway restart` — 重启网关加载新插件

### 调试流程

```bash
# 编译到 /tmp（避免 IDE 安全限制阻止写入 ~/.openclaw）
npm run build
# 然后用 openclaw 命令安装（它会自动复制 dist/ 到扩展目录）
openclaw plugins install . --force
openclaw gateway restart
# 查看日志
tail -f ~/Library/Logs/openclaw/gateway.log
```

### 关键陷阱

- **绝对不要 `git checkout --` 恢复文件再批量修改**，会覆盖掉已有改动。先用 `git stash` 或直接在当前文件上改。
- **`openclaw.plugin.json` 不会被 `tsc` 编译**，是静态复制到扩展目录的。修改后直接 `openclaw plugins install . --force` 即可。
- **`contracts.tools` 在 `package.json` 中声明**，新增工具必须同步更新。
- **工具注册是 session 级别的**，新增工具后需要重开 session（不只是刷新，是新对话）。
- **LLM 看不到自定义 ctxPayload 字段**（如 `AppId`），但能看到标准字段（`SessionKey`、`From`、`To` 等）。传递凭证给 LLM 时使用 `SessionKey`。

### 凭证解析策略

LLM 调用工具时，通过 `sessionKey` 参数传递 `SessionKey`（格式：`agent:<agentId>:lansenger:...`），代码解析 `agentId`，从 `openclaw.json` 的 `bindings` 中查找对应的 `accountId`：

```json
// openclaw.json
"bindings": [
  { "agentId": "lx-newbot", "match": { "channel": "lansenger", "accountId": "13107200-4218880" } }
]
```

```
SessionKey → "agent:lx-newbot:..." → agentId="lx-newbot" → bindings → accountId="13107200-4218880"
```

### 测试文档

`docs/test-plan-group-policy.md` — 27 手工用例 + 单元测试覆盖映射表。

## Debug Logging Rules

- **调试日志使用 `debug` 级别，不要用 `info`。** `info` 会打印到生产日志中污染输出。
- **不要删除调试日志。** 排查问题需要这些日志。用 `log.debug()` 替代 `log.info()`，日常不输出，需要时通过 OpenClaw 日志级别配置开启。
- 关键入站/出站路径应保留 `debug` 日志：
  - `processRawMessage` — 打印原始入站 JSON
  - webhook handler — 打印原始 webhook body
  - 其他需要排查的数据路径
