# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.12.2] - 2026-06-03

### Outbound Hook Expansion

- **`reply_payload_sending` hook**: Register typed plugin hook via `api.on()` for lansenger channel. Intercepts reply payloads before delivery for logging, approval context injection, and payload rewrite/cancel decisions.
- **`normalizePayload` expansion**: Code block detection (`\`\`\``) now marks `_lansengerFormatText: true` even when payload has `mediaUrl` or `presentation`, ensuring Markdown rendering for code-rich replies.
- **`beforeDeliverPayload` approval-resolved**: When `hint.kind === "approval-resolved"`, proactively updates the original appCard status via `updateDynamicCard`. Provides crash-recovery safety for card status updates since the delivery pipeline replays on gateway restart.
- **`shouldSuppressLocalPayloadPrompt`**: Suppresses local text prompt when native approval route is active (`hint.kind === "approval-pending"` with `nativeRouteActive === true`). Prevents duplicate approval prompts (native appCard + local text).
- **`pendingApprovalCards` Map**: Tracks sent approval card messageIds keyed by chatId, enabling `beforeDeliverPayload` to correlate approval-resolved payloads with the original card.
- **Text chunking**: Add `textChunkLimit: 4000`, `chunkerMode: "markdown"`, and `chunker` (using SDK `chunkMarkdownTextWithMode`). Long agent replies are automatically split into multiple Lansenger messages, preserving Markdown structure across chunks.
- **`resolveEffectiveTextChunkLimit`**: Uses SDK `resolveTextChunkLimit` to allow config-level override of the chunk limit.

### Approval Flow Enhancement

- `approvalCapability.transport.send` now stores card `messageId` in `pendingApprovalCards` Map for later correlation in `beforeDeliverPayload`.
- Card status updates (pending → approved/denied) now happen both via `transport.update` (approval framework) and `beforeDeliverPayload` (delivery pipeline). The latter provides crash-recovery safety.

## [3.12.1] - 2026-06-03

### OpenClaw 2026.5.28 Compatibility

- Pin npm install spec to exact version (`@lansenger-pm/openclaw-lansenger-channel@3.12.1`) to prevent supply-chain attacks and accidental upgrades.
- Thread canonical `sessionKey` into outbound hooks (`sendText`, `sendMedia`, `sendFormattedText`) for multi-session/multi-agent routing and dedup.
- Register `message_sending` hook in gateway startup for early-stage reply interception.
- Add `normalizePayload` and `beforeDeliverPayload` callbacks on outbound base (structural preparation for `reply_payload_sending` hook).
- Add session-scoped delivery dedup (`sessionDeliveryTracker`) to prevent duplicate sends across turns in the same session.
- Fallback `sessionKey` now includes `accountId` for multi-bot scenarios (`agent:main:lansenger:<accountId>:<chatType>:<chatId>`).
- Bump `openclaw` devDependency to `^2026.5.28`.

### Security

- **SecretRef support for appSecret**: `resolveAccount()` now detects SecretRef objects via `coerceSecretRef()` and resolves from env vars. No need to store appSecret as plaintext in config.
- **Plaintext appSecret warning**: `resolveAccount()` now emits a `log.warn` when `appSecret` is stored as a plaintext string in `openclaw.json`, advising migration to SecretRef via `openclaw secrets configure`.
- **README security notes**: All 5 locale READMEs now include a prominent security advisory urging users to migrate plaintext `appSecret` to SecretRef storage.
- **SSRF protection for sendImageUrl**: `assertHttpUrlTargetsPrivateNetwork()` blocks RFC1918/link-local/metadata-IP targets by default (aligned with Feishu/Discord/BlueBubbles channels in 2026.5.28).
- **`dangerouslyAllowPrivateNetwork` config**: Opt-in at top-level or per-account to allow private network image URLs. Audit finding (`lansenger/dangerously-allow-private-network`) warns when enabled.
- **`mediaLocalRoots` config**: Restrict local file delivery to configured directories. If empty, all paths allowed. Prevents agents from accessing arbitrary files outside allowed roots. Available at top-level and per-account.
- **Path validation**: `isPathAllowed()` validates local file paths against `mediaLocalRoots` before delivery; blocked paths are logged and skipped.

## [3.12.0] - 2026-05-29

### OpenClaw 2026.5.27 Compatibility

- Migrate `api.runtime.channel.turn` → `api.runtime.channel.inbound` (OpenClaw removed the old `turn` runtime alias from `PluginRuntimeChannel`; the new `inbound` namespace provides the same `run` function with identical parameters).
- Bump `openclaw` devDependency from `^2026.5.20` to `^2026.5.27`.
- Split changelog out of READMEs into standalone `CHANGELOG.md` (all 5 locale READMEs now reference this file).

## [3.11.0] - 2026-05-26

### Breaking Changes

- Remove `child_process` dependency (was blocking OpenClaw install due to security scan).
- Video messages now require manual `coverImagePath` + `videoWidth`/`videoHeight`/`videoDuration` params (use ffmpeg/ffprobe before calling send-file; auto-probing removed because it depended on child_process).

### Bug Fixes

- Inbound video cover downloaded as image type (previously misclassified).

## [3.10.0] - 2026-05-22

### Features

- Fix video message: Lansenger API requires `mediaIds=[video, coverImage]` (2 elements). `sendFile()` auto-extracts first frame via ffmpeg and uploads as cover image.
- `send-text` with file attachment now uses correct mediaType instead of hardcoded `3`.

### Bug Fixes

- Inbound video downloads cover as image type.
- Auto-probe video metadata (width/height/duration) via ffprobe for video uploads.

## [3.9.0] - 2026-05-20

### Features

- Switch file upload to `/v1/app/medias/create` API (supports larger files up to 10M/20M, uses string type `image`/`video`/`audio`/`file` instead of numeric media type).
- Previous `/v1/medias/create` was limited to 1M and intended for avatar uploads only.

## [3.8.2] - 2026-05-20

### Features

- Add `security.collectWarnings` and `security.collectAuditFindings` for `openclaw doctor --lint` integration. Checks: credentials missing/incomplete, dmPolicy not pairing, apiGatewayUrl not set, group config unused.
- Add `doctor.repairConfig` to auto-fix dmPolicy to pairing.
- Require OpenClaw >= 2026.5.20.
- Fix apiGatewayUrl lint check to skip when accounts have gateway set.

## [3.7.9] - 2026-05-18

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

### Bug Fixes

- Fix health-monitor infinite restart loop: register `gateway.startAccount`/`stopAccount` so channelManager runtime store gets `running=true` + `connected=true`.
- WS lifecycle callbacks (`onOpen`/`onClose`) report connection status changes to runtime store via `createAccountStatusSink`.
- Fix `account.configured` in `buildAccountSnapshot` to avoid false negative from `inspectAccount` desensitized object.

## [3.5.0] - 2026-05-14

### Features

- **Per-turn dedup**: prevent duplicate text/media delivery within a single inbound turn.
- Strip OpenClaw UUID suffix from filenames (removes `---<uuid>` pattern from upload filenames).
- MEDIA whitelist docs in SKILL.md; `alsoAllow` tip in README; README accuracy fixes across all 5 locales.
- Add runtime API diagnostic logging, try-catch guards, WS state logging, heartbeat zombie detection.

### Bug Fixes

- Exclude test files from npm package (fix OpenClaw security scan blocking install).
- Add OpenClaw device pairing troubleshooting section (all 5 locales).

## [3.4.5] - 2026-05-12

### Bug Fixes

- Fix duplicate delivery — `deliver()` deferred to outbound adapter; text dedup + empty caption for files.
- Fix filename: pass `originalName` in else branch too; add upload filename debug logging.

## [3.3.0] - 2026-05-10

### Features

- **Merge tools into channel plugin**: all 9 agent tools (`send_file`, `send_text`, `send_format_text`, `send_image_url`, `revoke_message`, `send_link_card`, `send_app_articles`, `send_app_card`, `update_dynamic_card`, `query_groups`) are now built-in. No separate `openclaw-lansenger-tools` plugin needed.
- Add `contracts.tools` + `toolMetadata` to plugin manifest.
- Remove `companionPlugins` + `peerDependencies` on tools plugin.
- `message(action=send)` with `filePath` param sends file attachment; no MEDIA tags needed.

## [3.2.10] - 2026-05-08

### Features

- Startup warning for missing `group:plugins` in tool allowlist (`openclaw doctor` integration).
- `configWrites` in channel config schema (allows Lansenger to auto-write config like `homeChannel`).
- Companion plugin cross-runtime state via `globalThis.__lansenger_channel` (`getRunningClient`, `getRunningAccount`, `getLastInboundChatId`).
- **Slash command authorization**: enables `/new`, `/reset` etc. for Lansenger DM sessions (uses `shouldHandleTextCommands`, `isControlCommandMessage`, `resolveCommandAuthorizedFromAuthorizers` from OpenClaw SDK).
- **DM pairing enforcement**: pairing mode blocks unauthorized DMs; command auth bypasses pairing for approved users.
- CLI multi-credential profile support (`--profile <appId>`).

## [3.1.0] - 2026-05-06

### Features

- **Multi-account setup wizard**: add multiple bots with independent App IDs; agent routing via `bindings[]` config.
- Migrate `dmSecurity` → `dmPolicy` (OpenClaw standard: `pairing`, `allowlist`, `open`, `disabled`).
- Bilingual wizard prompts (Chinese + English).
- Credential `shouldPrompt` skips already-configured steps.
- Clean multi-account config migration: top-level credentials → `accounts.<appId>` when adding second bot.

## [3.0.0] - 2026-05-04

### Features

- Add `lansenger_send_format_text` tool (Markdown + @mention support via `formatText` API).
- Rewrite SKILL.md from agent perspective: remove internal implementation details, focus on actionable decision rules.
- Fix `headStatusInfo` description+colour semantics for dynamic appCard approval cards.
- Add `.opencode/` to `.gitignore`.

### Bug Fixes

- Fix SKILL.md nested code blocks, missing params, false group-chat fallback warnings.
- Emphasize `@姓名` in group mentions (formatText reminder guidance).

## [2.10.0] - 2026-04-28

### Features

- **px→pt auto-conversion**: `sendAppCard` converts CSS `font-size` from px to pt (Lansenger requires pt; px renders incorrectly).
- `sendImageUrl` error classification: distinguishes 404/5xx/timeout/content-type mismatches.
- Tool registration logging for debugging.

## [2.9.12] - 2026-04-26

### Features

- **Status adapter**: expose channel status via `buildChannelSummary` + `probeAccount` + `buildAccountSnapshot`.
- **Env var fallback**: `LANSENGER_APP_ID`, `LANSENGER_APP_SECRET`, `LANSENGER_API_GATEWAY_URL` used when config not set.
- GUI config cleanup: remove `defaultAccount`, add `uiHints` for all fields.
- Move `openclaw` to `devDependencies` only (compile-first, publish-compiled; runtime deps now only `ws`).

## [2.8.1] - 2026-04-24

### Features

- **OpenClaw bindings multi-agent routing**: use `resolveAgentRoute` from SDK for agent routing; remove per-account `agentId` and `BindingManager`/`execSync` dependency.
- **Group access control**: `groupPolicy` (`open`/`allowlist`/`disabled`), `groupAllowFrom`, per-group `groups` config (`requireMention`, `enabled`, `allowFrom`).
- Rename channel identifier to `Lansenger`; then revert to lowercase `lansenger` (SDK requires lowercase).
- SKILL.md frontmatter aligned with `AgentSkills` spec.

## [2.7.0] - 2026-04-22

### Features

- Register tools as plain objects (not factory functions) — external plugin capture API only accepts non-function tool descriptors.
- Use runtime state for client/account/target instead of ctx closure.
- Add VERSION file; complete changelog in all 5 README locales.

## [2.6.0] - 2026-04-20

### Bug Fixes

- Register tools unconditionally — resolve account at execute time instead of registration time (fixes `tools.allow 'no registered tools matched'`).
- Removed phantom `delete_message` tool.

## [2.5.0] - 2026-04-18

### Features

- `formatText` reminder support (auto-fallback: strips reminder on API error).
- `AppArticles` uses `summary` field (not `description`).
- Revoke `chatType` limited to `bot`/`group` only.
- Remove `staff chat` concept — only group chat and DM.
- Add `deleteMessage` + `sysMsg` for revoke (rollback: both not working, removed).

## [2.4.0] - 2026-04-16

### Bug Fixes

- Fix message body assembly: `wrap()` excludes `msgType` from `msgData`; `appArticles` uses correct `msgType`/`summary`/flat array.
- `linkCard` adds missing required params.

## [2.3.0] - 2026-04-14

### Features

- Remove legacy `sendGroupText`/`sendGroupFormatText`; all routing via `msgTarget(chatId)` helper (determines private vs group endpoint automatically).

## [2.2.0] - 2026-04-12

### Features

- Add 9 dedicated agent tools: `send_file`, `send_text`, `send_format_text`, `send_image_url`, `revoke_message`, `send_link_card`, `send_app_articles`, `send_app_card`, `update_dynamic_card`, `query_groups`.
- Add `queryGroups` + `updateDynamicCard` client methods.
- Add `contracts.tools` + `toolMetadata` to plugin.json.
- Fix chatId lowercase bug — `resolveSessionTarget` case-insensitive fallback.
- Fix `uploadMedia` endpoint, stop key mismatch, `sendCard` dynamic params & `headTitle`.
- Fix WS reconnect — `startAccount` checks `isWsAlive()` before skipping, cleans stale entries.

## [2.1.0] - 2026-04-10

### Features

- **sendAttachment → send action**: merge `sendAttachment` into `send` action — `filePath` param in `send` action sends file, no MEDIA tags needed. Align with Telegram pattern.
- `send` action auto-resolves target from `sessionKey`/`requesterSenderId` — `to` param optional.

## [2.0.0] - 2026-04-08

### Breaking Changes

- **Migrate to Channel Turn Kernel**: replace `BindingManager`/`execSync` with OpenClaw's `channel.inbound.run` for inbound processing.
- Remove bind/unbind/bindings gateway methods — use config-based `agentId` and `bindings[]`.
- Add `defaultAccount` concept.

### Features

- Add `runtimeExtensions`/`runtimeSetupEntry` per SDK entrypoint best practices.
- Add complete `openclaw.channel` metadata: `order`, `docsPath`, `markdownCapable`, `exposure`, `aliases`, `quickstartAllowFrom`.
- Rewrite SKILL.md from agent perspective.

## [1.0.3] - 2026-04-04

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

### Bug Fixes

- Fix README `dmSecurity` example: `allowlist` → `paired`.
- Fix README install instructions format.

## [1.0.0] - 2026-04-01

### Initial Release

- Lansenger (蓝信) channel plugin for OpenClaw.
- WebSocket inbound long connection.
- HTTP API outbound: `sendText`, `sendFormatText`, `sendImage`, `sendFile`, `sendLinkCard`, `sendAppCard`, `sendAppArticles`.
- Multi-language READMEs (en, zhHans, zhHant, zhHantHK, fr).
- DM security: pairing mode (default), allowlist, open, disabled.
- Approval workflow: appCard with `headStatusInfo` for pending/approved/denied states.
- Auto-start WebSocket gateway on plugin activation.