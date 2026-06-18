# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.14.7] - 2026-06-18

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Bug Fixes

- **`lansenger_send_*` tools multi-account routing**: All `lansenger_send_*` tools used `getRunningClient()` which always returned the first entry from `runningAccounts` Map, causing cross-account message sending in multi-bot setups. Fixed by:
  - Added `getRunningEntryByAccount(accountId)` in runtime.ts that matches by account key/ID, with single-account fallback.
  - Changed tool registration to use OpenClaw's tool factory pattern (`api.registerTool((ctx) => {...})`), resolving the correct client via `ctx.agentAccountId` from the OpenAI-compatible tool context.

## [3.14.6] - 2026-06-17

> **Hotfix**: v3.14.5 was published with a broken `dist/src/runtime.js` that imports `./persistent-store.js` but the file was missing.

### Bug Fixes

- **Missing `persistent-store.js` in npm bundle**: `src/persistent-store.ts` was uncommitted but referenced by modified `src/runtime.ts`. `prepublishOnly` ran `tsc` against the working directory, producing `dist/src/runtime.js` with the import, but the compiled `dist/src/persistent-store.js` was excluded from the npm tarball. Now committed and included.

## [3.14.5] - 2026-06-17

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Bug Fixes

- **Group chat reply routing**: Outbound adapters (`sendText`, `sendMedia`, `sendFormattedText`, `sendPayload`, `beforeDeliverPayload`) created fresh `LansengerClient` instances via `makeClient()`, which had an empty `chatTypeMap` cache. `isGroupChat()` then fell back to `chatId.startsWith("group:")` — which never matches Lansenger group IDs — causing all group replies to be sent via private-message API instead of group-message API. Fixed by using `getRunningClient() ?? makeClient()` so the cached client (with populated `chatTypeMap`) handles routing.

## [3.14.4] - 2026-06-15

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Bug Fixes

- **`recoverPendingInboundContexts` duplicate restart notice**: Gateway restart-recovery sent multiple "system restart" notices to the same chat due to two issues:
  1. `startLansengerGateway` was called from both runtime extension and channel extension initialization paths, causing `recoverPendingInboundContexts` to execute twice. Added a module-level `recoveryGuard` flag for idempotency.
  2. Even within a single invocation, multiple pending contexts for the same `chatId` would each trigger a separate notice. Added `chatId` deduplication — only one notice per chat per recovery cycle.
- **`recoverPendingInboundContexts` duplicate ack revoke**: Same guard prevents the stale ack message from being revoked twice.
- **WS reconnection without exponential backoff**: `backoffIdx` was reset to 0 immediately after `new WebSocket()` instead of on actual connection (`ws.onopen`). This caused every reconnect attempt to use a fixed 2s delay and log `attempt 1` regardless of retry count. Moved `this.backoffIdx = 0` into `ws.onopen` so the `[2, 5, 10, 30, 60]` backoff array is properly utilized.

## [3.14.3] - 2026-06-04

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Features

- **Gateway restart-recovery inbound context persistence**: Active inbound sessions are persisted to `~/.openclaw/lansenger-inbound-contexts.json` before `inbound.run`. On gateway restart/plugin upgrade, `recoverPendingInboundContexts` detects interrupted sessions, revokes stale ack messages, and sends a "system restart, reprocessing..." notification. Contexts older than 5 minutes are discarded.
- **User notification**: Sends a locale-aware restart notice (`zh`/`en`) to the affected chat after recovery.

## [3.14.2] - 2026-06-04

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Features

- **`reply_payload_sending` fallback delivery**: Tracks active `inbound.run` sessions via `activeDeliverySessions` set. When `reply_payload_sending` fires for a session without an active `inbound.run` (e.g., after gateway restart/turn timeout), the reply is delivered directly via the Lansenger client instead of being silently dropped. Extracts `chatId` from `sessionKey` to resolve delivery target.

## [3.14.1] - 2026-06-04

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Bug Fixes

- **`ackMessage` default**: Changed from `false` to `true`; `revokeAckMessage` from `true` to `false`, aligning with the `after_agent_dispatch` ack policy.
- **`pendingApprovalCards` persistence**: Migrated from in-memory `Map` to `~/.openclaw/lansenger-approval-cards.json` file-backed store, surviving gateway restarts.
- **Group ingress fallback**: Added `requireMention` + `isAtMe` check to prevent non-@ messages from triggering the bot.
- **`isPathAllowed` security hardening**: Empty `mediaLocalRoots` now defaults to `[cwd, tmpdir]` instead of allowing any path.
- **Dead code removal**: Removed unused `debounceMs` statement in `runtime.ts`.
- **`convertPxToPtDeep` → `convertPxToPtCard`**: Only transforms known style fields; skips URL/link fields to avoid corruption.
- **Documentation**: All 5 locale READMEs updated with new defaults and `mediaLocalRoots` docs.

## [3.14.0] - 2026-06-04

> **Compatible with OpenClaw `^2026.6.1`** (tested against `2026.6.1`).

### Message Adapter (New `ChannelPlugin.message`)

- **`lansengerMessageAdapter`**: New `ChannelMessageAdapterShape` mounted on `lansengerPlugin.message`, built via `createChannelMessageAdapterFromOutbound` from the OpenClaw SDK. This bridges the legacy `outbound` adapter into the new message adapter contract, enabling OpenClaw core to use the standardized `send.text / send.media / send.payload` + `durableFinal` + `receive` + `live` adapter facets.
- **`lansengerOutboundBridge`**: `ChannelMessageOutboundBridgeAdapter` implementation with `sendText`, `sendMedia`, and `sendPayload` methods. All send methods now return `ChannelMessageOutboundBridgeResult` with a normalized `MessageReceipt` (via `createMessageReceiptFromOutboundResults`) instead of the legacy `OutboundDeliveryResult`.
- **`sendText`**: Maps to `client.sendFormatText` — sends Markdown-formatted text with standard receipt.
- **`sendMedia`**: Full media handling — URL images (`sendImageUrl`), local files (`sendFile`), buffered uploads (`mediaReadFile`) — identical logic to the former `outbound.attachedResults.sendMedia`, now with receipt normalization.
- **`sendPayload`**: Consolidates `normalizePayload` + `beforeDeliverPayload` logic into a single method. Handles: pure text → `formatText`, code-block text → `formatText`, text+media → media delivery with caption, mixed payloads. Replaces the two-step normalize→deliver pipeline with direct payload dispatch.
- **Capabilities declared**: `text`, `media`, `payload`, `messageSendingHooks`, `batch`.
- **Legacy `outbound` preserved**: The existing `chatPlugin.outbound.attachedResults` and `outbound.base` configuration remains unchanged for backward compatibility. OpenClaw core will prefer the `message` adapter when available, falling back to `outbound` for older runtime versions.

### Inbound Receive Ack Policy (`message.receive`)

- **`defaultAckPolicy: "after_agent_dispatch"`**: Declares that Lansenger inbound messages should be acknowledged after the agent dispatch completes. This matches the existing behavior: the "收到，正在处理..." ack message is sent on receive and revoked after agent reply, which is semantically an `after_agent_dispatch` lifecycle.
- **`supportedAckPolicies`**: All four policies declared — `after_receive_record`, `after_agent_dispatch`, `after_durable_send`, `manual` — giving OpenClaw core flexibility to select the appropriate ack stage per scenario.
- **Test coverage**: 4 new tests via `verifyChannelMessageReceiveAckPolicyAdapterProofs` and `listDeclaredReceiveAckPolicies`, verifying all declared policies pass SDK contract proofs.
- This replaces the previously implicit ack timing embedded in the `runtime.ts` monitor-local state with a standardized, SDK-verifiable contract.

## [3.13.1] - 2026-06-03

> **Compatible with OpenClaw `^2026.5.28`** (tested against `2026.5.28`).

- migrate `message_sending` from `api.registerHook` to `api.on("message_sending", ...)` (OpenClaw 2026.5.28 rejects `registerHook` for typed hooks that lack a name)

## [3.13.0] - 2026-06-03

> **Compatible with OpenClaw `^2026.5.28`** (tested against `2026.5.28`).

- Add `dist/src/setup-i18n.*` to `files` field in package.json (fixes `Cannot find module './setup-i18n.js'` at gateway startup)

## [3.12.2] - 2026-06-03

> **Compatible with OpenClaw `^2026.5.28`** (tested against `2026.5.28`).

- **Outbound Hook Expansion**: `reply_payload_sending` hook, `message_sending` hook, `normalizePayload` code-block detection, `beforeDeliverPayload` approval-resolved crash recovery, `shouldSuppressLocalPayloadPrompt`, `pendingApprovalCards` Map, text chunking (`textChunkLimit: 4000`, `chunkerMode: "markdown"`), `resolveEffectiveTextChunkLimit`, session-scoped delivery dedup (`sessionDeliveryTracker`)
- **Approval Flow Enhancement**: `approvalCapability.transport.send` stores card `messageId` in `pendingApprovalCards`; card status updates via both `transport.update` and `beforeDeliverPayload` (crash-recovery safety)
- **Setup Wizard i18n**: `createSetupTranslator()` + plugin-owned dictionary, locales `en`/`zh-CN`/`zh-TW`, `src/setup-i18n.ts`

## [3.12.1] - 2026-06-03

> **Compatible with OpenClaw `^2026.5.28`** (tested against `2026.5.28`).

- **Security**: SecretRef support for appSecret, plaintext appSecret warning, SSRF protection for `sendImageUrl`, `dangerouslyAllowPrivateNetwork` config, `mediaLocalRoots` config, path validation (`isPathAllowed`)
- Pin npm install spec to exact version (`@lansenger-pm/openclaw-lansenger-channel@3.12.1`)
- Thread canonical `sessionKey` into outbound hooks for multi-session/multi-agent routing
- Fallback `sessionKey` includes `accountId` for multi-bot scenarios
- Bump `openclaw` devDependency from `^2026.5.20` to `^2026.5.28`

## [3.12.0] - 2026-06-03

> **Compatible with OpenClaw `^2026.5.27`** (tested against `2026.5.27`).

- **Breaking**: Migrate `api.runtime.channel.turn` → `api.runtime.channel.inbound` (OpenClaw removed the old `turn` runtime alias)
- Split changelog out of READMEs into standalone `CHANGELOG.md`
- All 5 locale READMEs now reference this file

## [3.11.0] - 2026-05-26

> **Compatible with OpenClaw `^2026.5.20`** (tested against `2026.5.20` and `2026.5.22`).

### Breaking Changes

- Remove `child_process` dependency (was blocking OpenClaw install due to security scan). OpenClaw's built-in dangerous-code scanner flagged `child_process` as a critical pattern and blocked plugin installation — users could not install without `--dangerously-force-unsafe-install`. v3.11.0 removes all `child_process` usage, so the plugin installs cleanly without override flags.
- Video messages now require **4 manual parameters**: `coverImagePath`, `videoWidth`, `videoHeight`, `videoDuration`. Previous v3.10.0 auto-extracted these via ffmpeg/ffprobe (which depended on `child_process`). Now the agent must use ffmpeg/ffprobe before calling send-file. See the skill docs for exact commands.

### Bug Fixes

- Inbound video cover downloaded as image type (previously misclassified as video type).

## [3.10.0] - 2026-05-22

> **Compatible with OpenClaw `^2026.5.20`** (tested against `2026.5.22`).

### Features

- Fix video message: Lansenger API requires `mediaIds=[video, coverImage]` (2 elements). `sendFile()` auto-extracts first frame via ffmpeg and uploads as cover image.
- `send-text` with file attachment now uses correct `mediaType` instead of hardcoded `3`.

### Bug Fixes

- Inbound video downloads cover as image type.
- Auto-probe video metadata (width/height/duration) via ffprobe for video uploads.

## [3.9.0] - 2026-05-20

> **Compatible with OpenClaw `^2026.5.20`** (tested against `2026.5.20`).

### Features

- Switch file upload to `/v1/app/medias/create` API (supports larger files up to 10M/20M, uses string type `image`/`video`/`audio`/`file` instead of numeric media type).
- Previous `/v1/medias/create` was limited to 1M and intended for avatar uploads only.

## [3.8.2] - 2026-05-20

> **Compatible with OpenClaw `^2026.5.20`** (tested against `2026.5.20`).

- Fix apiGatewayUrl lint check to skip when accounts have gateway set.

## [3.8.1] - 2026-05-20

> **Compatible with OpenClaw `^2026.5.20`** (tested against `2026.5.20`).

- Add `security.collectWarnings` and `security.collectAuditFindings` for `openclaw doctor --lint` integration.
- Add `doctor.repairConfig` to auto-fix dmPolicy to pairing.
- Bump `openclaw` devDependency from `^2026.5.7` to `^2026.5.20`.

## [3.7.9] - 2026-05-18

> **Compatible with OpenClaw `^2026.5.7`**. This is the last release compatible with OpenClaw 2026.5.7. The next version (v3.8.2) raises the minimum to `^2026.5.20`.

### Features

- **Inbound debounce**: integrate OpenClaw `messages.inbound.debounceMs` for merging rapid consecutive messages (uses `createChannelInboundDebouncer` + `shouldDebounceTextInbound` from `openclaw/plugin-sdk/channel-inbound`).
- **Ack message feature**: send a brief acknowledgment before agent processing. Config: `ackMessage` (bool, default false), `ackMessageTextZh` / `ackMessageTextEn` (auto-detected language), `revokeAckMessage` (bool, default true — auto-revokes ack after reply delivery).
- Account-level `ackMessage`/`revokeAckMessage` inherits from top-level when not explicitly set; `!== undefined` check so account-level `false` overrides top-level `true`.
- Rebind messageHandler on WS adopt to pick up updated account config (ack/debounce).
- Always disconnect+reconnect WS on `gatewayStartAccount` to ensure updated handler config is active.
- Sanitize placeholder IDs in docs and config — use generic `orgId-applicationId` format instead of real IDs.

### Bug Fixes

- Fix `ackMessage` not resolved from top-level config in multi-account mode.
- Fix `apiGatewayUrl` lint check to skip when accounts have gateway set.

## [3.6.0] - 2026-05-16

> **Compatible with OpenClaw `^2026.5.7`**.

### Bug Fixes

- Fix health-monitor infinite restart loop: register `gateway.startAccount`/`stopAccount` so channelManager runtime store gets `running=true` + `connected=true`.
- WS lifecycle callbacks (`onOpen`/`onClose`) report connection status changes to runtime store via `createAccountStatusSink`.
- Fix `account.configured` in `buildAccountSnapshot` to avoid false negative from `inspectAccount` desensitized object.

## [3.5.0] - 2026-05-14

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **Per-turn dedup**: prevent duplicate text/media delivery within a single inbound turn.
- Strip OpenClaw UUID suffix from filenames (removes `---<uuid>` pattern from upload filenames).
- MEDIA whitelist docs in SKILL.md; `alsoAllow` tip in README; README accuracy fixes across all 5 locales.
- Add runtime API diagnostic logging, try-catch guards, WS state logging, heartbeat zombie detection.

### Bug Fixes

- Exclude test files from npm package (fix OpenClaw security scan blocking install).
- Add OpenClaw device pairing troubleshooting section (all 5 locales).

## [3.4.5] - 2026-05-12

> **Compatible with OpenClaw `^2026.5.7`**.

### Bug Fixes

- Fix duplicate delivery — `deliver()` deferred to outbound adapter; text dedup + empty caption for files.
- Fix filename: pass `originalName` in else branch too; add upload filename debug logging.

## [3.3.0] - 2026-05-10

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **Merge tools into channel plugin**: all 9 agent tools (`send_file`, `send_text`, `send_format_text`, `send_image_url`, `revoke_message`, `send_link_card`, `send_app_articles`, `send_app_card`, `update_dynamic_card`, `query_groups`) are now built-in. No separate `openclaw-lansenger-tools` plugin needed.
- Add `contracts.tools` + `toolMetadata` to plugin manifest.
- Remove `companionPlugins` + `peerDependencies` on tools plugin.
- `message(action=send)` with `filePath` param sends file attachment; no MEDIA tags needed.

## [3.2.10] - 2026-05-08

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- Startup warning for missing `group:plugins` in tool allowlist (`openclaw doctor` integration).
- `configWrites` in channel config schema (allows Lansenger to auto-write config like `homeChannel`).
- Companion plugin cross-runtime state via `globalThis.__lansenger_channel` (`getRunningClient`, `getRunningAccount`, `getLastInboundChatId`).
- **Slash command authorization**: enables `/new`, `/reset` etc. for Lansenger DM sessions (uses `shouldHandleTextCommands`, `isControlCommandMessage`, `resolveCommandAuthorizedFromAuthorizers` from OpenClaw SDK).
- **DM pairing enforcement**: pairing mode blocks unauthorized DMs; command auth bypasses pairing for approved users.
- CLI multi-credential profile support (`--profile <appId>`).

## [3.1.0] - 2026-05-06

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **Multi-account setup wizard**: add multiple bots with independent App IDs; agent routing via `bindings[]` config.
- Migrate `dmSecurity` → `dmPolicy` (OpenClaw standard: `pairing`, `allowlist`, `open`, `disabled`).
- Bilingual wizard prompts (Chinese + English).
- Credential `shouldPrompt` skips already-configured steps.
- Clean multi-account config migration: top-level credentials → `accounts.<appId>` when adding second bot.

## [3.0.0] - 2026-05-04

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- Add `lansenger_send_format_text` tool (Markdown + @mention support via `formatText` API).
- Rewrite SKILL.md from agent perspective: remove internal implementation details, focus on actionable decision rules.
- Fix `headStatusInfo` description+colour semantics for dynamic appCard approval cards.
- Add `.opencode/` to `.gitignore`.

### Bug Fixes

- Fix SKILL.md nested code blocks, missing params, false group-chat fallback warnings.
- Emphasize `@姓名` in group mentions (formatText reminder guidance).

## [2.10.0] - 2026-04-28

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **px→pt auto-conversion**: `sendAppCard` converts CSS `font-size` from px to pt (Lansenger requires pt; px renders incorrectly).
- `sendImageUrl` error classification: distinguishes 404/5xx/timeout/content-type mismatches.
- Tool registration logging for debugging.

## [2.9.12] - 2026-04-26

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **Status adapter**: expose channel status via `buildChannelSummary` + `probeAccount` + `buildAccountSnapshot`.
- **Env var fallback**: `LANSENGER_APP_ID`, `LANSENGER_APP_SECRET`, `LANSENGER_API_GATEWAY_URL` used when config not set.
- GUI config cleanup: remove `defaultAccount`, add `uiHints` for all fields.
- Move `openclaw` to `devDependencies` only (compile-first, publish-compiled; runtime deps now only `ws`).

## [2.8.1] - 2026-04-24

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **OpenClaw bindings multi-agent routing**: use `resolveAgentRoute` from SDK for agent routing; remove per-account `agentId` and `BindingManager`/`execSync` dependency.
- **Group access control**: `groupPolicy` (`open`/`allowlist`/`disabled`), `groupAllowFrom`, per-group `groups` config (`requireMention`, `enabled`, `allowFrom`).
- Rename channel identifier to `Lansenger`; then revert to lowercase `lansenger` (SDK requires lowercase).
- SKILL.md frontmatter aligned with `AgentSkills` spec.

## [2.7.0] - 2026-04-22

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- Register tools as plain objects (not factory functions) — external plugin capture API only accepts non-function tool descriptors.
- Use runtime state for client/account/target instead of ctx closure.
- Add VERSION file; complete changelog in all 5 README locales.

## [2.6.0] - 2026-04-20

> **Compatible with OpenClaw `^2026.5.7`**.

### Bug Fixes

- Register tools unconditionally — resolve account at execute time instead of registration time (fixes `tools.allow 'no registered tools matched'`).
- Removed phantom `delete_message` tool.

## [2.5.0] - 2026-04-18

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- `formatText` reminder support (auto-fallback: strips reminder on API error).
- `AppArticles` uses `summary` field (not `description`).
- Revoke `chatType` limited to `bot`/`group` only.
- Remove `staff chat` concept — only group chat and DM.
- Add `deleteMessage` + `sysMsg` for revoke (rollback: both not working, removed).

## [2.4.0] - 2026-04-16

> **Compatible with OpenClaw `^2026.5.7`**.

### Bug Fixes

- Fix message body assembly: `wrap()` excludes `msgType` from `msgData`; `appArticles` uses correct `msgType`/`summary`/flat array.
- `linkCard` adds missing required params.

## [2.3.0] - 2026-04-14

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- Remove legacy `sendGroupText`/`sendGroupFormatText`; all routing via `msgTarget(chatId)` helper (determines private vs group endpoint automatically).

## [2.2.0] - 2026-04-12

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- Add 9 dedicated agent tools: `send_file`, `send_text`, `send_format_text`, `send_image_url`, `revoke_message`, `send_link_card`, `send_app_articles`, `send_app_card`, `update_dynamic_card`, `query_groups`.
- Add `queryGroups` + `updateDynamicCard` client methods.
- Add `contracts.tools` + `toolMetadata` to plugin.json.
- Fix chatId lowercase bug — `resolveSessionTarget` case-insensitive fallback.
- Fix `uploadMedia` endpoint, stop key mismatch, `sendCard` dynamic params & `headTitle`.
- Fix WS reconnect — `startAccount` checks `isWsAlive()` before skipping, cleans stale entries.

## [2.1.0] - 2026-04-10

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- **sendAttachment → send action**: merge `sendAttachment` into `send` action — `filePath` param in `send` action sends file, no MEDIA tags needed. Align with Telegram pattern.
- `send` action auto-resolves target from `sessionKey`/`requesterSenderId` — `to` param optional.

## [2.0.0] - 2026-04-08

> **Compatible with OpenClaw `^2026.5.7`**.

### Breaking Changes

- **Migrate to Channel Turn Kernel**: replace `BindingManager`/`execSync` with OpenClaw's `channel.inbound.run` for inbound processing.
- Remove bind/unbind/bindings gateway methods — use config-based `agentId` and `bindings[]`.
- Add `defaultAccount` concept.

### Features

- Add `runtimeExtensions`/`runtimeSetupEntry` per SDK entrypoint best practices.
- Add complete `openclaw.channel` metadata: `order`, `docsPath`, `markdownCapable`, `exposure`, `aliases`, `quickstartAllowFrom`.
- Rewrite SKILL.md from agent perspective.

## [1.0.3] - 2026-04-04

> **Compatible with OpenClaw `^2026.5.7`**.

### Features

- Quick Start section in all READMEs: one-command setup with `openclaw channels add`, pairing approval flow.
- Multi-bot config: warn that `channels add` overwrites, show `config set` for additional accounts.
- Replace real AppIDs with placeholder values in examples.
- Document extensions workaround for OpenClaw CLI discovery bug.
- Add `openclaw.channel` metadata.

### Bug Fixes

- Fix README install commands: use `--channel` flag, split `--base-url` as optional for enterprise.
- Fix autoStart: include top-level account when not duplicated in accounts.

## [1.0.1] - 2026-04-02

> **Compatible with OpenClaw `^2026.5.7`**.

### Bug Fixes

- Fix README `dmSecurity` example: `allowlist` → `paired`.
- Fix README install instructions format.

## [1.0.0] - 2026-04-01

> **Compatible with OpenClaw `^2026.5.7`**.

### Initial Release

- Lansenger (蓝信) channel plugin for OpenClaw.
- WebSocket inbound long connection.
- HTTP API outbound: `sendText`, `sendFormatText`, `sendImage`, `sendFile`, `sendLinkCard`, `sendAppCard`, `sendAppArticles`.
- Multi-language READMEs (en, zhHans, zhHant, zhHantHK, fr).
- DM security: pairing mode (default), allowlist, open, disabled.
- Approval workflow: appCard with `headStatusInfo` for pending/approved/denied states.
- Auto-start WebSocket gateway on plugin activation.
