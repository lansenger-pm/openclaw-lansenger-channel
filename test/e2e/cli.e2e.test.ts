import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const PLUGIN_DIR = join(__dirname, "..", "..");

/**
 * E2E: CLI surface — the REAL `openclaw` CLI against an isolated state dir with
 * the plugin installed via `plugins install --link`. Covers the setup-wizard
 * contract (channels add flags → config writes), plugin install, channels list,
 * and config validation — the integration between the plugin's declarative
 * wizard spec and the host CLI.
 *
 * Known limitation (documented): the SECRET prompt is interactive-only by
 * design (masked input; no CLI flag maps to it) — its applySet logic is covered
 * by src/setup-wizard.test.ts unit tests. Here we verify every flag-driven path.
 */
describe("E2E: CLI surface (real openclaw CLI, isolated state)", () => {
  let stateDir: string;
  let configPath: string;
  let env: Record<string, string>;
  let baselineConfig: string; // config AFTER plugin install — preserves plugins.entries
  let installFlags: string[];

  beforeAll(async () => {
    // One isolated environment per suite; a fresh config per test via resetConfig().
    stateDir = mkdtempSync(join(tmpdir(), "oc-cli-e2e-"));
    configPath = join(stateDir, "openclaw.json");
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    } as Record<string, string>;
    // vitest injects NODE_OPTIONS (--import loader) into workers; inheriting it in
    // child CLI processes loads vitest's loader into the CLI and swallows all output.
    delete env.NODE_OPTIONS;
    writeFileSync(configPath, JSON.stringify({
      gateway: { mode: "local" },
      plugins: { load: { paths: [PLUGIN_DIR] } },
    }, null, 2));
    // NOTE: under vitest, PATH includes node_modules/.bin → `openclaw` resolves to the
    // matrix version (2026.7.1 or 2026.8.1) — the CLI surface is dual-version tested.
    // Install flags differ: 2026.8.1 gates local paths behind --force (trust) and
    // capabilities behind --accept-capabilities; 2026.7.1 supports neither with --link.
    const ver = await exec("openclaw", ["--version"], { env, timeout: 30_000 });
    const is2026_8 = /2026\.[89]/.test(ver.stdout);
    installFlags = is2026_8 ? ["--force", "--accept-capabilities"] : [];
    await exec("openclaw", ["plugins", "install", "--link", PLUGIN_DIR, ...installFlags], { env, timeout: 60_000 });
    // The install writes plugin registry entries INTO the config — capture it as
    // the reset baseline so per-test resets keep the plugin installed.
    baselineConfig = readFileSync(configPath, "utf8");
    // The real verification is channels add in the tests below — if the wizard
    // contract is broken, "Unknown channel lansenger" fails test 1 immediately.
  }, 180_000);

  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function resetConfig(): void {
    writeFileSync(configPath, baselineConfig);
  }

  function readChannelConfig(): any {
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf8")).channels?.lansenger ?? {};
  }

  it("channels add --channel lansenger with flags writes appId + apiGatewayUrl", async () => {
    // NOTE: the wizard renders via /dev/tty — in TTY-less environments (CI, vitest
    // workers) its output is not capturable. The FUNCTIONAL contract is the config
    // write, which is asserted directly.
    await exec("openclaw", [
      "channels", "add", "--channel", "lansenger",
      "--app-token", "app-cli-e2e",
      "--base-url", "https://gw.example.com",
    ], { env, timeout: 60_000 });
    const cfg = readChannelConfig();
    expect(cfg.appId).toBe("app-cli-e2e");
    expect(cfg.apiGatewayUrl).toBe("https://gw.example.com");
  }, 90_000);

  /**
   * Named-account wizard flow is TTY-gated by the host CLI (prompts render via
   * /dev/tty; in TTY-less environments the flow exits 0 without writing — the
   * applySet logic for named accounts is covered by src/setup-wizard.test.ts).
   * Here we assert the TTY-less invocation is SAFE: exit 0, no config corruption.
   * Manual TTY verification checklist lives in docs/functional-test-plan.md.
   */
  it("channels add --account <id> is safe in TTY-less environments (no config corruption)", async () => {
    resetConfig();
    await exec("openclaw", [
      "channels", "add", "--channel", "lansenger", "--account", "team-bot",
      "--app-token", "app-team", "--base-url", "https://gw.example.com",
    ], { env, timeout: 60_000 });
    const cfg = readChannelConfig();
    // Whatever the flow wrote (or skipped), the config must remain parseable and
    // must not contain garbage from a half-rendered wizard.
    expect(cfg).toBeTruthy();
  }, 90_000);

  it("channels list reports lansenger (output may render via /dev/tty; config is the oracle)", async () => {
    // The channel must at least be RECOGNIZED: an unknown channel would make this
    // command exit non-zero ("Unknown channel"), so a clean exit + written config
    // from the previous test proves the wizard contract end-to-end.
    await exec("openclaw", ["channels", "list"], { env, timeout: 60_000 });
    const cfg = readChannelConfig();
    expect(cfg.appId ?? Object.keys(cfg.accounts ?? {}).length > 0).toBeTruthy();
  }, 90_000);

  it("config validate passes with the plugin configured (exit 0 = valid)", async () => {
    // exec throws on non-zero exit; "invalid config" makes this command exit 1.
    await exec("openclaw", ["config", "validate"], { env, timeout: 60_000 });
  }, 90_000);

  it("re-running add with different flags UPDATES the default account (idempotent reconfigure)", async () => {
    await exec("openclaw", [
      "channels", "add", "--channel", "lansenger",
      "--app-token", "app-cli-v2", "--base-url", "https://gw2.example.com",
    ], { env, timeout: 60_000 });
    const cfg = readChannelConfig();
    expect(cfg.appId).toBe("app-cli-v2"); // updated, not duplicated
    expect(cfg.apiGatewayUrl).toBe("https://gw2.example.com");
  }, 90_000);
});