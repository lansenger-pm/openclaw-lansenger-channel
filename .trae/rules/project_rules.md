# Project Rules for openclaw-lansenger-channel

## Publish Checklist (MANDATORY before every `npm publish`)

This project has a `"files"` allowlist in `package.json`. Any file NOT explicitly listed there will be EXCLUDED from the npm tarball, even if it exists in `dist/`.

### 1. Check uncommitted changes and version BEFORE publishing

```bash
git status --short
echo "Current version: $(node -p "require('./package.json').version")"
```

- **NEVER publish when there are modified or untracked source files** that `tsc` will compile.
- **Double-check the version number** is correct (semver). npm versions are permanent and CANNOT be deleted.
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

### 2026-06-04 — v3.15.0 mistakenly published

- **Root cause**: During the gateway restart-recovery feature, the version in `package.json` was incorrectly bumped to `3.15.0` instead of `3.14.3`. The incorrect version was published to npm. A corrected `3.14.3` was published ~35 seconds later, but v3.15.0 cannot be deleted from npm.
- **Impact**: Users with `^3.14.0` dependency range resolved to `3.15.0` (highest semver match), getting the wrong version.
- **Fix**: Deprecated v3.15.0 on npm with a warning message.
- **Lesson**: **Double-check version number in package.json before publishing.** npm versions are permanent.

### 2026-06-17 — v3.14.5 broken (missing persistent-store.js)

- **Root cause**: `src/persistent-store.ts` was an uncommitted file. `src/runtime.ts` was modified (uncommitted) to import from it. When `prepublishOnly` ran `tsc`, it compiled both into `dist/`, producing `dist/src/runtime.js` with `import ... "./persistent-store.js"`. But `persistent-store.*` was NOT in `package.json` `"files"` allowlist, so it was excluded from the tarball. Users got a broken package.
- **Fix**: Committed `persistent-store.ts` and `runtime.ts`, added `dist/src/persistent-store.*` to `package.json` `"files"`.
- **Lesson**: Always check `git status` and `npm pack --dry-run` before publishing.
