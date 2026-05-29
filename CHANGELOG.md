# Changelog

## 3.12.0

- Fix compatibility with OpenClaw 2026.5.27: migrate from `api.runtime.channel.turn` to `api.runtime.channel.inbound`. OpenClaw 2026.5.27 removed the old `turn` runtime alias from `PluginRuntimeChannel`; the new `inbound` namespace provides the same `run` function with identical parameters. (#compat)
- Bump `openclaw` devDependency from `^2026.5.20` to `^2026.5.27`.

## 3.11.0

- Remove `child_process` usage that could block OpenClaw installs on restricted environments.
- Video messages now require manual `coverImagePath`, `width`, `height`, and `duration` parameters (auto-extraction removed).

## 3.10.0

- Fix video message: auto-extract cover image, correct `mediaType`, inbound cover as image type.

## 3.9.0

- Switch file upload to `/v1/app/medias/create` API (supports larger files, string type params).

## 3.8.2

- Fix `apiGatewayUrl` lint check to skip when accounts have gateway set.
- Unify changelog format.
- Bump `openclaw` devDependency to `2026.5.20`.