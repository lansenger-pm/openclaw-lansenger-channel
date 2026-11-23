import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import {
  collectRunningKeysForIdentity,
  isStaleSibling,
  isAccountSnapshotCurrent,
  normalizeHomeChannelIdentity,
  shouldOverwriteHomeChannel,
  evictStaleSiblings,
  gatewayStopAccount,
  startLansengerGateway,
  _clearTestState,
  _setRunningAccountForTest,
  _setHomeChannelIdentityForTest,
  getRunningClient,
} from "./runtime.js";

/**
 * Regression tests for the "appId switch does not take effect until a gateway
 * restart" defect.
 *
 * Root cause: connection keys are appId-first. After an appId change the host
 * resolves the account from the NEW config, so stop-by-key targeted the NEW
 * appId while the running entry still used the OLD key -> the old socket was
 * orphaned and kept serving with the stale ResolvedAccount snapshot (old
 * homeChannel).
 *
 * The helper below intentionally supports the REAL host-path entry shape:
 * `entry.accountId` may be the appId supplied by the host while the stable
 * config key lives on `entry.account.accountId`.
 */

const acc = (accountId: string | null, appId: string, extra: Record<string, any> = {}) => ({
  accountId,
  appId,
  appSecret: "s",
  apiGatewayUrl: "https://gw",
  allowFrom: [],
  groupAllowFrom: [],
  enabled: false,
  homeChannel: undefined,
  ...extra,
});

const emptyConfig = () => ({ channels: { lansenger: {} } });

const multiConfig = (accountId: string, appId: string, homeChannel?: string) => ({
  channels: {
    lansenger: {
      dmPolicy: "open",
      accounts: {
        [accountId]: { appId, appSecret: "s", apiGatewayUrl: "https://gw", homeChannel },
      },
    },
  },
});

const singleConfig = (appId: string, homeChannel?: string) => ({
  channels: {
    lansenger: {
      appId,
      appSecret: "s",
      apiGatewayUrl: "https://gw",
      dmPolicy: "open",
      homeChannel,
    },
  },
});

/** Minimal gw client stub used by injected entries. */
function makeClientStub(onDisconnect?: () => void) {
  return {
    disconnect: async () => { onDisconnect?.(); },
    isWsAlive: () => true,
    wsState: () => "open",
    wsAgeMs: () => 1,
    setWsLifecycleCallbacks: () => {},
  };
}

/** Minimal api with the surface startLansengerGateway touches. */
function makeApi(config: any = emptyConfig()): any {
  const methods: Record<string, any> = {};
  const httpRoutes: any[] = [];
  return {
    config,
    registerGatewayMethod: (name: string, handler: any) => { methods[name] = handler; },
    registerHttpRoute: (route: any) => { httpRoutes.push(route); },
    registerHook: () => {},
    on: () => {},
    runtime: {
      channel: {
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => ({ code: "PAIR123" }),
          buildPairingReply: ({ code }: any) => `Pairing code: ${code}`,
        },
        groups: { resolveGroupPolicy: () => ({ allowed: true }), resolveRequireMention: () => false },
        routing: { resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1", matchedBy: "default" }) },
        commands: { shouldHandleTextCommands: () => false, shouldComputeCommandAuthorized: () => false, isControlCommandMessage: () => false },
        turn: { run: async () => {} },
        inbound: { run: async () => {} },
        session: { resolveStorePath: () => "/tmp/store", recordInboundSession: () => {} },
        reply: { dispatchReplyWithBufferedBlockDispatcher: () => {} },
      },
    },
    _methods: methods,
    _httpRoutes: httpRoutes,
  };
}

/**
 * Register the gateway while the config is empty so startLansengerGateway's
 * autoStart() does not dial a real client; then install the test config. The
 * gateway methods and webhook handler read api.config dynamically.
 */
function startWithConfig(config: any = emptyConfig()): any {
  const api = makeApi();
  startLansengerGateway(api);
  api.config = config;
  return api;
}

function makeOpts(params: Record<string, any> = {}) {
  let responded = false;
  let response: any = null;
  return {
    params,
    respond: (success: boolean, data?: any, error?: any) => { responded = true; response = { success, data, error }; },
    _responded: () => responded,
    _response: () => response,
  };
}

beforeEach(() => {
  _clearTestState();
  vi.mocked(execFileSync).mockReset();
  // Belt-and-braces: no test in this file may perform a real HTTP request.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in runtime-identity tests"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("collectRunningKeysForIdentity", () => {
  it("matches the OLD appId key via the stable accountId (core fix)", () => {
    _setRunningAccountForTest("2285568-old", { account: acc("acc-1", "2285568-old") });
    const keys = collectRunningKeysForIdentity({ accountId: "acc-1", appId: "2285568-new" });
    expect(keys).toEqual(["2285568-old"]);
  });

  it("matches a host-path entry whose entry.accountId is the old appId", () => {
    _setRunningAccountForTest("2285568-old", {
      accountId: "2285568-old",
      account: acc("acc-1", "2285568-old"),
    });
    expect(collectRunningKeysForIdentity({ accountId: "acc-1", appId: "2285568-new" })).toEqual(["2285568-old"]);
  });

  it("matches by appId when the entry carries no accountId", () => {
    _setRunningAccountForTest("app-x", { accountId: null, account: acc(null, "app-x") });
    expect(collectRunningKeysForIdentity({ accountId: null, appId: "app-x" })).toEqual(["app-x"]);
  });

  it("returns empty when nothing matches", () => {
    _setRunningAccountForTest("app-x", { account: acc("acc-1", "app-x") });
    expect(collectRunningKeysForIdentity({ accountId: "acc-2", appId: "app-y" })).toEqual([]);
  });

  it("returns empty for an empty identity", () => {
    _setRunningAccountForTest("app-x", { account: acc("acc-1", "app-x") });
    expect(collectRunningKeysForIdentity({})).toEqual([]);
  });
});

describe("isStaleSibling", () => {
  it("is true for same accountId with a different appId", () => {
    const entry = { accountId: "acc-1", account: acc("acc-1", "old-app") } as any;
    expect(isStaleSibling(entry, acc("acc-1", "new-app") as any)).toBe(true);
  });

  it("is true for a host-path entry whose entry.accountId is the old appId", () => {
    const entry = { accountId: "2285568-old", account: acc("acc-1", "2285568-old") } as any;
    expect(isStaleSibling(entry, acc("acc-1", "2285568-new") as any)).toBe(true);
  });

  it("is false for the same appId", () => {
    const entry = { accountId: "acc-1", account: acc("acc-1", "same-app") } as any;
    expect(isStaleSibling(entry, acc("acc-1", "same-app") as any)).toBe(false);
  });

  it("is false when the accountId is missing (cannot attribute safely)", () => {
    const entry = { accountId: null, account: acc(null, "old-app") } as any;
    expect(isStaleSibling(entry, acc("acc-1", "new-app") as any)).toBe(false);
  });
});

describe("isAccountSnapshotCurrent", () => {
  it("accepts the current appId and rejects the old snapshot", () => {
    const cfg = multiConfig("acc-1", "new-app") as any;
    expect(isAccountSnapshotCurrent(cfg, acc("acc-1", "new-app") as any)).toBe(true);
    expect(isAccountSnapshotCurrent(cfg, acc("acc-1", "old-app") as any)).toBe(false);
  });

  it("cannot prove stale when the config has no configured identity", () => {
    expect(isAccountSnapshotCurrent(emptyConfig() as any, acc("acc-1", "old-app") as any)).toBe(true);
  });

  it("rejects a snapshot when another account now owns the config lookup", () => {
    const cfg = multiConfig("acc-2", "other-app") as any;
    expect(isAccountSnapshotCurrent(cfg, acc("acc-1", "old-app") as any)).toBe(false);
  });
});

describe("evictStaleSiblings", () => {
  it("evicts only the same-accountId/different-appId sibling", async () => {
    let oldDisconnected = false;
    let otherDisconnected = false;
    _setRunningAccountForTest("2285568-old", {
      accountId: "2285568-old",
      account: acc("acc-1", "2285568-old"),
      client: makeClientStub(() => { oldDisconnected = true; }),
    });
    _setRunningAccountForTest("other-acct-key", {
      account: acc("acc-2", "other-app"),
      client: makeClientStub(() => { otherDisconnected = true; }),
    });

    const evicted = await evictStaleSiblings(
      multiConfig("acc-1", "2285568-new") as any,
      acc("acc-1", "2285568-new") as any,
      "2285568-new",
    );

    expect(evicted).toEqual(["2285568-old"]);
    expect(oldDisconnected).toBe(true);
    expect(otherDisconnected).toBe(false);
    expect(collectRunningKeysForIdentity({ accountId: "acc-2", appId: "other-app" })).toEqual(["other-acct-key"]);
  });

  it("is a no-op when the appId did not change", async () => {
    let disconnected = false;
    _setRunningAccountForTest("same-app", {
      account: acc("acc-1", "same-app"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    const evicted = await evictStaleSiblings(
      multiConfig("acc-1", "same-app") as any,
      acc("acc-1", "same-app") as any,
      "same-app",
    );
    expect(evicted).toEqual([]);
    expect(disconnected).toBe(false);
  });

  it("refuses to evict from a stale account snapshot", async () => {
    let newDisconnected = false;
    _setRunningAccountForTest("2285568-new", {
      account: acc("acc-1", "2285568-new"),
      client: makeClientStub(() => { newDisconnected = true; }),
    });

    const evicted = await evictStaleSiblings(
      multiConfig("acc-1", "2285568-new") as any,
      acc("acc-1", "2285568-old") as any,
      "2285568-old",
    );

    expect(evicted).toEqual([]);
    expect(newDisconnected).toBe(false);
    expect(collectRunningKeysForIdentity({ accountId: "acc-1", appId: "2285568-new" })).toEqual(["2285568-new"]);
  });
});

describe("gatewayStopAccount stops orphans by identity", () => {
  it("stops the OLD key when the context carries the NEW appId", async () => {
    let disconnected = false;
    _setRunningAccountForTest("2285568-old", {
      accountId: "2285568-old",
      account: acc("acc-1", "2285568-old"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    await gatewayStopAccount({
      accountId: "2285568-old",
      account: acc("acc-1", "2285568-new"),
    } as any);
    expect(disconnected).toBe(true);
    expect(getRunningClient()).toBeNull();
  });

  it("falls back to the historical key when nothing matches by identity", async () => {
    let disconnected = false;
    _setRunningAccountForTest("legacy-key", {
      account: acc("unknown", "legacy-app"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    await gatewayStopAccount({ accountId: "legacy-key", account: acc("other", "new-app") } as any);
    expect(disconnected).toBe(true);
  });
});

describe("lansenger.stop gateway method stops by identity", () => {
  it("stops the OLD key when called with the stable accountId after an appId change", async () => {
    let disconnected = false;
    _setRunningAccountForTest("2285568-old", {
      accountId: "2285568-old",
      account: acc("acc-1", "2285568-old"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    const api = startWithConfig(multiConfig("acc-1", "2285568-new"));
    const opts = makeOpts({ accountId: "acc-1" });
    await api._methods["lansenger.stop"](opts);
    expect(opts._responded()).toBe(true);
    expect(opts._response().success).toBe(true);
    expect(disconnected).toBe(true);
  });

  it("stops every running account when accountId is omitted", async () => {
    let aDisconnected = false;
    let bDisconnected = false;
    _setRunningAccountForTest("app-a", {
      account: acc("acc-a", "app-a"),
      client: makeClientStub(() => { aDisconnected = true; }),
    });
    _setRunningAccountForTest("app-b", {
      account: acc("acc-b", "app-b"),
      client: makeClientStub(() => { bDisconnected = true; }),
    });

    const api = startWithConfig(emptyConfig());
    const opts = makeOpts();
    await api._methods["lansenger.stop"](opts);
    expect(opts._response().success).toBe(true);
    expect(aDisconnected).toBe(true);
    expect(bDisconnected).toBe(true);
    expect(getRunningClient()).toBeNull();
  });

  it("responds NOT_LINKED when nothing is running", async () => {
    const api = startWithConfig(emptyConfig());
    const opts = makeOpts({ accountId: undefined });
    await api._methods["lansenger.stop"](opts);
    expect(opts._response().success).toBe(false);
    expect(opts._response().error?.message).toContain("not running");
  });
});

describe("homeChannel auto-configure overwrite matrix", () => {
  const sender = "2285568-owner";

  beforeEach(() => {
    vi.stubEnv("LANSENGER_TEST_NO_PERSIST", "1");
  });

  function makeReq(body: any) {
    const json = Buffer.from(JSON.stringify(body));
    return {
      method: "POST",
      [Symbol.asyncIterator]: async function* () {
        yield json;
      },
    } as any;
  }
  function makeRes() {
    return { statusCode: 0, end: vi.fn() } as any;
  }
  function dmBody(senderId = sender) {
    return {
      events: [{
        type: "bot_private_message",
        data: { id: `m-${Math.random()}`, from: senderId, msgType: "text", msgData: { text: { content: "hi" } }, msgId: `m-${Math.random()}` },
      }],
    };
  }

  function wroteHomeChannel() {
    return vi.mocked(execFileSync).mock.calls.some((c) => String(c[1]).includes("homeChannel"));
  }

  it("writes when homeChannel is empty", async () => {
    const api = startWithConfig(multiConfig("acc-1", "2285568-new"));
    const handler = api._httpRoutes.at(-1).handler;
    expect(handler).toBeTruthy();
    await handler(makeReq(dmBody()), makeRes());
    expect(wroteHomeChannel()).toBe(true);
  });

  it("does NOT write when identity is unchanged", async () => {
    _setHomeChannelIdentityForTest({ "acc-1": { appId: "2285568-new", homeChannel: "staff-old" } });
    const api = startWithConfig(multiConfig("acc-1", "2285568-new", "staff-old"));
    const handler = api._httpRoutes.at(-1).handler;
    await handler(makeReq(dmBody()), makeRes());
    expect(wroteHomeChannel()).toBe(false);
  });

  it("overwrites an auto-written value when the recorded appId differs", async () => {
    _setHomeChannelIdentityForTest({ "acc-1": { appId: "2285568-old", homeChannel: "staff-old" } });
    const api = startWithConfig(multiConfig("acc-1", "2285568-new", "staff-old"));
    const handler = api._httpRoutes.at(-1).handler;
    await handler(makeReq(dmBody()), makeRes());
    expect(wroteHomeChannel()).toBe(true);
  });

  it("preserves a manually changed homeChannel after an appId switch", async () => {
    _setHomeChannelIdentityForTest({ "acc-1": { appId: "2285568-old", homeChannel: "staff-auto" } });
    const api = startWithConfig(multiConfig("acc-1", "2285568-new", "group-manual"));
    const handler = api._httpRoutes.at(-1).handler;
    await handler(makeReq(dmBody()), makeRes());
    expect(wroteHomeChannel()).toBe(false);
  });

  it("supports a single-account appId switch via the stable __default__ key", async () => {
    _setHomeChannelIdentityForTest({ __default__: { appId: "2285568-old", homeChannel: "staff-old" } });
    const api = startWithConfig(singleConfig("2285568-new", "staff-old"));
    const handler = api._httpRoutes.at(-1).handler;
    await handler(makeReq(dmBody()), makeRes());
    const homeCall = vi.mocked(execFileSync).mock.calls.find((c) => String(c[1]).includes("homeChannel"));
    expect(homeCall).toBeTruthy();
    expect(homeCall?.[1]).toEqual(["config", "set", "channels.lansenger.homeChannel", sender]);
  });
});

describe("homeChannel identity helpers", () => {
  it("normalizes the legacy bare-appId format", () => {
    expect(normalizeHomeChannelIdentity({ "acc-1": "old-app" })).toEqual({ "acc-1": { appId: "old-app" } });
  });

  it("keeps the auto-written value in the new format", () => {
    expect(normalizeHomeChannelIdentity({ "acc-1": { appId: "old-app", homeChannel: "staff-1" } }))
      .toEqual({ "acc-1": { appId: "old-app", homeChannel: "staff-1" } });
  });

  it("ignores arrays and malformed entries", () => {
    expect(normalizeHomeChannelIdentity([])).toEqual({});
    expect(normalizeHomeChannelIdentity({ a: { homeChannel: "x" }, b: 42 })).toEqual({});
  });

  it("writes when homeChannel is empty (first DM)", () => {
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: undefined, currentAppId: "a1" })).toBe(true);
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: "", recorded: { appId: "a0" }, currentAppId: "a1" })).toBe(true);
  });

  it("keeps the existing value when the bot identity is unchanged", () => {
    expect(shouldOverwriteHomeChannel({
      rawHomeChannel: "staff-1",
      recorded: { appId: "a1", homeChannel: "staff-1" },
      currentAppId: "a1",
    })).toBe(false);
  });

  it("overwrites only a value this plugin wrote for the previous appId", () => {
    expect(shouldOverwriteHomeChannel({
      rawHomeChannel: "staff-old",
      recorded: { appId: "a0", homeChannel: "staff-old" },
      currentAppId: "a1",
    })).toBe(true);
    expect(shouldOverwriteHomeChannel({
      rawHomeChannel: "group-manual",
      recorded: { appId: "a0", homeChannel: "staff-old" },
      currentAppId: "a1",
    })).toBe(false);
  });

  it("keeps the existing value when only a legacy appId is recorded", () => {
    expect(shouldOverwriteHomeChannel({
      rawHomeChannel: "staff-1",
      recorded: { appId: "a0" },
      currentAppId: "a1",
    })).toBe(false);
  });

  it("keeps the existing value when no identity has been recorded yet (conservative)", () => {
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: "staff-1", currentAppId: "a1" })).toBe(false);
  });
});
