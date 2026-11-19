import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import {
  collectRunningKeysForIdentity,
  isStaleSibling,
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
function makeApi(config: any): any {
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

describe("collectRunningKeysForIdentity", () => {
  beforeEach(() => _clearTestState());

  it("matches the OLD appId key via the stable accountId (core fix)", () => {
    _setRunningAccountForTest("2285568-old", { account: acc("acc-1", "2285568-old") });
    const keys = collectRunningKeysForIdentity({ accountId: "acc-1", appId: "2285568-new" });
    expect(keys).toEqual(["2285568-old"]);
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

  it("is false for the same appId", () => {
    const entry = { accountId: "acc-1", account: acc("acc-1", "same-app") } as any;
    expect(isStaleSibling(entry, acc("acc-1", "same-app") as any)).toBe(false);
  });

  it("is false when the accountId is missing (cannot attribute safely)", () => {
    const entry = { accountId: null, account: acc(null, "old-app") } as any;
    expect(isStaleSibling(entry, acc("acc-1", "new-app") as any)).toBe(false);
  });
});

describe("evictStaleSiblings", () => {
  beforeEach(() => _clearTestState());

  it("evicts only the same-accountId/different-appId sibling", async () => {
    let oldDisconnected = false;
    let otherDisconnected = false;
    _setRunningAccountForTest("2285568-old", {
      account: acc("acc-1", "2285568-old"),
      client: makeClientStub(() => { oldDisconnected = true; }),
    });
    _setRunningAccountForTest("other-acct-key", {
      account: acc("acc-2", "other-app"),
      client: makeClientStub(() => { otherDisconnected = true; }),
    });

    const evicted = await evictStaleSiblings(acc("acc-1", "2285568-new") as any, "2285568-new");

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
    const evicted = await evictStaleSiblings(acc("acc-1", "same-app") as any, "same-app");
    expect(evicted).toEqual([]);
    expect(disconnected).toBe(false);
  });
});

describe("gatewayStopAccount stops orphans by identity", () => {
  beforeEach(() => _clearTestState());

  it("stops the OLD key when the context carries the NEW appId", async () => {
    let disconnected = false;
    _setRunningAccountForTest("2285568-old", {
      account: acc("acc-1", "2285568-old"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    await gatewayStopAccount({
      accountId: "acc-1",
      account: acc("acc-1", "2285568-new"),
    } as any);
    expect(disconnected).toBe(true);
    expect(getRunningClient()).toBeNull();
  });

  it("falls back to the historical key when nothing matches by identity", async () => {
    let disconnected = false;
    _setRunningAccountForTest("legacy-key", {
      account: acc("other", "legacy-key"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    await gatewayStopAccount({ accountId: "legacy-key", account: acc("other", "legacy-key") } as any);
    expect(disconnected).toBe(true);
  });
});

describe("lansenger.stop gateway method stops by identity", () => {
  beforeEach(() => _clearTestState());

  it("stops the OLD key when called with the stable accountId after an appId change", async () => {
    let disconnected = false;
    _setRunningAccountForTest("2285568-old", {
      account: acc("acc-1", "2285568-old"),
      client: makeClientStub(() => { disconnected = true; }),
    });
    const api = makeApi({
      channels: {
        lansenger: {
          accounts: {
            "acc-1": { appId: "2285568-new", appSecret: "s", enabled: false, apiGatewayUrl: "https://gw" },
          },
        },
      },
    });
    startLansengerGateway(api);
    const opts = makeOpts({ accountId: "acc-1" });
    await api._methods["lansenger.stop"](opts);
    expect(opts._responded()).toBe(true);
    expect(opts._response().success).toBe(true);
    expect(disconnected).toBe(true);
  });

  it("responds NOT_LINKED when nothing is running", async () => {
    const api = makeApi({ channels: { lansenger: { appId: "", appSecret: "" } } });
    startLansengerGateway(api);
    const opts = makeOpts({ accountId: undefined });
    await api._methods["lansenger.stop"](opts);
    expect(opts._response().success).toBe(false);
    expect(opts._response().error?.message).toContain("not running");
  });
});

describe("homeChannel auto-configure overwrite matrix", () => {
  const sender = "2285568-owner";

  beforeEach(() => {
    _clearTestState();
    vi.mocked(execFileSync).mockReset();
    vi.stubEnv("LANSENGER_TEST_NO_PERSIST", "1");
  });

  function makeApiWithHome(homeChannel?: string, appId = "2285568-new"): any {
    return makeApi({
      channels: {
        lansenger: {
          appId: "2285568-new",
          appSecret: "s",
          dmPolicy: "open",
          accounts: {
            "acc-1": { appId, appSecret: "s", enabled: false, apiGatewayUrl: "https://gw", homeChannel },
          },
        },
      },
    });
  }

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

  it("writes when homeChannel is empty", async () => {
    const api = makeApiWithHome(undefined);
    startLansengerGateway(api);
    const handler = api._httpRoutes.at(-1).handler;
    expect(handler).toBeTruthy();
    await handler(makeReq(dmBody()), makeRes());
    // NOTE: the same DM also auto-writes commands.ownerAllowFrom, so assert on
    // the presence of a homeChannel call rather than the last call.
    const wroteHome = vi.mocked(execFileSync).mock.calls.some((c) => String(c[1]).includes("homeChannel"));
    expect(wroteHome).toBe(true);
  });

  it("does NOT write when identity is unchanged", async () => {
    _setHomeChannelIdentityForTest({ "acc-1": "2285568-new" });
    const api = makeApiWithHome("staff-old");
    startLansengerGateway(api);
    const handler = api._httpRoutes.at(-1).handler;
    await handler(makeReq(dmBody()), makeRes());
    const wroteHome = vi.mocked(execFileSync).mock.calls.some((c) => String(c[1]).includes("homeChannel"));
    expect(wroteHome).toBe(false);
  });

  it("overwrites when the recorded appId differs (appId switch)", async () => {
    _setHomeChannelIdentityForTest({ "acc-1": "2285568-old" });
    const api = makeApiWithHome("staff-old");
    startLansengerGateway(api);
    const handler = api._httpRoutes.at(-1).handler;
    await handler(makeReq(dmBody()), makeRes());
    const wroteHome = vi.mocked(execFileSync).mock.calls.some((c) => String(c[1]).includes("homeChannel"));
    expect(wroteHome).toBe(true);
  });
});

describe("shouldOverwriteHomeChannel", () => {
  it("writes when homeChannel is empty (first DM)", () => {
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: undefined, recordedAppId: undefined, currentAppId: "a1" })).toBe(true);
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: "", recordedAppId: "a0", currentAppId: "a1" })).toBe(true);
  });

  it("keeps the existing value when the bot identity is unchanged", () => {
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: "staff-1", recordedAppId: "a1", currentAppId: "a1" })).toBe(false);
  });

  it("overwrites when the operator switched the appId (core fix)", () => {
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: "staff-old", recordedAppId: "a0", currentAppId: "a1" })).toBe(true);
  });

  it("keeps the existing value when no identity has been recorded yet (conservative)", () => {
    expect(shouldOverwriteHomeChannel({ rawHomeChannel: "staff-1", recordedAppId: undefined, currentAppId: "a1" })).toBe(false);
  });
});