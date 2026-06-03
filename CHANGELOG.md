# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.12.1] - 2026-06-03

### OpenClaw 2026.5.28 Compatibility

- Pin npm install spec to exact version (`@lansenger-pm/openclaw-lansenger-channel@3.13.0`) to prevent supply-chain attacks and accidental upgrades.
- Thread canonical `sessionKey` into outbound hooks (`sendText`, `sendMedia`, `sendFormattedText`) for multi-session/multi-agent routing and dedup.
- Register `message_sending` hook in gateway startup for early-stage reply interception.
- Add `normalizePayload` and `beforeDeliverPayload` callbacks on outbound base (structural preparation for `reply_payload_sending` hook).
- Add session-scoped delivery dedup (`sessionDeliveryTracker`) to prevent duplicate sends across turns in the same session.
- Fallback `sessionKey` now includes `accountId` for multi-bot scenarios.
- Bump `openclaw` devDependency to `^2026.5.28`.

### Security

- **SecretRef support for appSecret**: `resolveAccount()` now detects SecretRef objects via `coerceSecretRef()` and resolves from env vars. No need to store appSecret as plaintext in config.
- **SSRF protection for sendImageUrl**: `assertHttpUrlTargetsPrivateNetwork()` blocks RFC1918/link-local/metadata-IP targets by default (aligned with Feishu/Discord/BlueBubbles channels).
- **`dangerouslyAllowPrivateNetwork` config**: Opt-in at top-level or per-account to allow private network image URLs. Audit finding warns when enabled.
- **`mediaLocalRoots` config**: Restrict local file delivery to configured directories. If empty, all paths allowed. Prevents agents from accessing arbitrary files.

## [3.12.0] - 2026-05-29

- Fix compatibility with OpenClaw 2026.5.27: migrate `api.runtime.channel.turn` → `api.runtime.channel.inbound` (OpenClaw removed the old `turn` runtime alias from `PluginRuntimeChannel`; the new `inbound` namespace provides the same `run` function with identical parameters).
- Bump `openclaw` devDependency from `^2026.5.20` to `^2026.5.27`.

## [3.11.0]

- Remove `child_process` dependency (was blocking OpenClaw install).
- Video now requires manual `coverImagePath` + `videoWidth/Height/Duration` params (use ffmpeg/ffprobe before calling send-file).
- Inbound video cover downloaded as image type.

## [3.10.0]

- Fix video message: API requires `mediaIds=[video, coverImage]` (2 elements). `sendFile()` auto-extracts first frame via ffmpeg and uploads as cover.
- `send-text` with file attachment now uses correct mediaType instead of hardcoded `3`.
- Inbound video downloads cover as image type.

## [3.9.0]

- Switch file upload to `/v1/app/medias/create` API (supports larger files up to 10M/20M, uses string type `image`/`video`/`audio`/`file` instead of numeric media type).
- Previous `/v1/medias/create` was limited to 1M and intended for avatar uploads only.

## [3.8.0]

- Add `security.collectWarnings` and `security.collectAuditFindings` for `openclaw doctor --lint` integration (checks: credentials missing/incomplete, dmPolicy not pairing, apiGatewayUrl not set, group config unused).
- Add `doctor.repairConfig` to auto-fix dmPolicy to pairing.
- Require OpenClaw >= 2026.5.20.

## [3.7.0]

- Inbound debounce: integrate OpenClaw `messages.inbound.debounceMs` for merging rapid consecutive messages.
- Ack message feature (`ackMessage` / `revokeAckMessage` config): send a brief acknowledgment before agent processing, optionally auto-revoked after reply (`revokeAckMessage` default `true`), language auto-detected.

## [3.6.0]

- Fix health-monitor infinite restart loop: register `gateway.startAccount`/`stopAccount` so channelManager runtime store gets `running=true` + `connected=true`.
- WS lifecycle callbacks report connection status changes to runtime store via `createAccountStatusSink`.

## [3.5.0]

- Fix duplicate message delivery (per-turn dedup).
- Strip OpenClaw UUID suffix from filenames.
- MEDIA whitelist docs; alsoAllow tip; README accuracy fixes.

## [3.3.0]

- Merge tools plugin into channel plugin; agent tools now built-in (no separate install).
- Remove peerDependencies on `@lansenger-pm/openclaw-lansenger-tools`.

## [3.2.10]

- Startup warning for missing `group:plugins` in tool allowlist.
- `configWrites` in channel config schema.
- Companion plugin cross-runtime state via `globalThis.__lansenger_channel`.

## [3.1.0]

- Multi-account setup wizard; dmPolicy/dmSecurity→dmPolicy+pairing (OpenClaw standard).
- Bilingual prompts; credential shouldPrompt skips configured steps; clean multi-account config migration.

## [3.0.0]

- Add `lansenger_send_format_text` tool (Markdown + @mention).
- Rewrite SKILL.md; fix headStatusInfo description+colour semantics.

## [2.10.0]

- font-size px→pt auto-conversion; sendImageUrl error classification; tool registration logging.

## [2.9.0]

- Status adapter; env var fallback; uiHints; README cleanup (5 locales).

## [2.8.0]

- OpenClaw `bindings[]` multi-agent routing; groupPolicy/groupAllowFrom/groups access control; SKILL.md AgentSkills spec.

## [2.7.0]

- Plain-object tool registration; runtime state for client/target.

## [2.6.0]

- Register tools unconditionally; removed phantom delete_message.

## [2.5.0]

- formatText reminder; AppArticles `summary`; revoke chatType bot/group only.

## [2.4.0]

- Fix message body assembly; appArticles/linkCard field fixes.

## [2.3.0]

- Remove legacy group/private send; all routing via msgTarget.

## [2.2.0]

- Add 9 agent tools.

## [2.0.0]

- Initial release.