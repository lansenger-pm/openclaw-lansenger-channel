import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { LansengerClient } from "./client.js";
import { resolveAccount } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import {
  startLansengerGateway,
  gatewayStartAccount,
  healAccount,
  getRunningClient,
  getRunningAccount,
  _clearTestState,
} from "./runtime.js";

/**
 * Regression suite for the lifecycle ("zombie connection") fixes:
 *  - N1/P3: disconnect() during CONNECTING must not hang; terminate fallback; bounded wsTask wait
 *  - P1:   concurrent starts for the same key must produce exactly one client (mutex + adoption)
 *  - P2:   abort cleanup must only tear down the client the context owns (identity check)
 *  - N2:   resolveAccount must reverse-lookup accounts by appId
 * Background: see docs/zombie-lifecycle-postmortem.md (audit 2026-09-01).
 */

vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;

    private _events: Record<string, (...args: unknown[]) => void> = {};

    constructor(_url: string) {
      MockWebSocket.instances.push(this);
      setTimeout(() => {
        if (this.readyState === 0) {
          this.readyState = 1;
          this.onopen?.();
        }
      }, 0);
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      this._events[event] = cb;
    }

    emitPong() {
      this._events["pong"]?.();
    }

    ping() {}
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: "", wasClean: true });
    }
    terminate() {
      this.readyState = 3;
      this.onclose?.({ code: 1006, reason: "", wasClean: false });
    }
  }
  return { default: MockWebSocket };
});

function wsEndpointResp(): Response {
  return new Response(
    JSON.stringify({ errCode: 0, errMsg: "", data: { wsEndpoint: "wss://mock.local/open/wss/v1?ticket=t", pingInterval: 20, expiresIn: 7200 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => wsEndpointResp());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════════════════
// N1/P3 — client.disconnect() hardening
// ══════════════════════════════════════════════════════════════

describe("LansengerClient.disconnect hardening (N1/P3)", () => {
  it("assigns this.ws while CONNECTING so disconnect can reach the socket (no eternal hang)", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const ok = await client.connect();
    expect(ok).toBe(true);
    // connect() resolves before the WS handshake completes (MockWebSocket opens on a
    // macrotask). With the fix, this.ws is already assigned during CONNECTING.
    expect((client as any).ws).toBeTruthy();
    expect(client.wsState()).toBe("CONNECTING");

    // The old implementation hung forever here (this.ws was null during CONNECTING,
    // close() was skipped, and await wsTask never settled). It must now return.
    await Promise.race([
      client.disconnect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("disconnect() did not resolve — eternal hang regression")), 3_000)),
    ]);
    expect(client.wsState()).toBe("NULL");
  });

  it("terminates a socket whose graceful close never completes (half-open TCP)", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    let terminated = false;
    const fakeWs = {
      readyState: 1, // OPEN; close() below deliberately does NOT complete the handshake
      close() { /* simulate half-open TCP: close frame never acknowledged */ },
      terminate() { terminated = true; this.readyState = 3; },
      on: () => {},
    };
    (client as any).ws = fakeWs;
    (client as any).wsTask = new Promise((r) => setTimeout(r, 100));

    vi.useFakeTimers();
    const dis = client.disconnect();
    await vi.advanceTimersByTimeAsync(5_100); // CLOSE_FALLBACK_MS = 5s
    expect(terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(5_100); // wsTask settles at 100ms (already advanced)
    await dis;
  });

  it("gives up waiting on a runWs loop that never settles (bounded by 10s)", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    (client as any).ws = null;
    (client as any).wsTask = new Promise(() => {}); // never settles — worst case

    vi.useFakeTimers();
    const dis = client.disconnect();
    await vi.advanceTimersByTimeAsync(10_500); // DISCONNECT_WS_TASK_TIMEOUT_MS = 10s
    await dis; // must resolve despite the eternal wsTask
  });

  it("reports connection age and pong age for observability", () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    expect(client.wsAgeMs()).toBe(0);
    expect(client.wsOpenedAtMs()).toBe(0);
    expect(client.lastPongAgeMs()).toBe(-1);

    (client as any).wsOpenedAt = Date.now() - 5_000;
    (client as any).lastPongAt = Date.now() - 2_000;
    expect(client.wsAgeMs()).toBeGreaterThanOrEqual(5_000);
    expect(client.lastPongAgeMs()).toBeGreaterThanOrEqual(2_000);
  });
});

// ══════════════════════════════════════════════════════════════
// N2 — resolveAccount appId reverse-lookup
// ══════════════════════════════════════════════════════════════

describe("resolveAccount appId reverse-lookup (N2)", () => {
  const multiAccountCfg = {
    channels: {
      lansenger: {
        accounts: {
          "2285568-2580736": { appId: "2285568-2580736", appSecret: "s1", apiGatewayUrl: "https://gw" },
          "log-report": { appId: "2285568-9937152", appSecret: "s2", apiGatewayUrl: "https://gw" },
          "2285568-8462848": { appId: "2285568-8462848", appSecret: "s3", apiGatewayUrl: "https://gw" },
        },
      },
    },
  } as any;

  it("resolves an account by its appId when the config key differs (host uses appId as account key)", () => {
    // listAccountIds() advertises appIds; the host then calls start with the appId.
    // Previously this fell through to "first account with credentials" (the main
    // account) — the deterministic trigger of the double-start defect.
    const account = resolveAccount(multiAccountCfg, "2285568-9937152");
    expect(account.appId).toBe("2285568-9937152");
    expect(account.accountId).toBe("log-report");
    expect(account.appSecret).toBe("s2");
  });

  it("still resolves by literal config key first", () => {
    const account = resolveAccount(multiAccountCfg, "log-report");
    expect(account.appId).toBe("2285568-9937152");
    expect(account.accountId).toBe("log-report");
  });

  it("falls back to first account with credentials for a truly unknown id", () => {
    const account = resolveAccount(multiAccountCfg, "no-such-id");
    expect(account.appId).toBe("2285568-2580736");
  });

  it("preserves single-account and no-account behaviors", () => {
    expect(resolveAccount({ channels: { lansenger: { appId: "top", appSecret: "s" } } } as any, undefined).appId).toBe("top");
    expect(resolveAccount({ channels: { lansenger: {} } } as any, undefined).enabled).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// P1/P2 — gatewayStartAccount mutex, adoption, abort identity
// ══════════════════════════════════════════════════════════════

function makeRuntimeApi(): any {
  return {
    config: { channels: { lansenger: {} } }, // no accounts → autoStart skips
    registerGatewayMethod: () => {},
    registerHttpRoute: () => {},
    registerHook: () => {},
    on: () => {},
    runtime: {
      channel: {
        pairing: { readAllowFromStore: async () => [] },
        groups: { resolveGroupPolicy: () => ({ allowed: true }), resolveRequireMention: () => false },
        routing: { resolveAgentRoute: () => ({ agentId: "a", sessionKey: "s", matchedBy: "default" }) },
        commands: { shouldHandleTextCommands: () => false, shouldComputeCommandAuthorized: () => false, isControlCommandMessage: () => false },
        turn: { run: async () => {} },
        inbound: { run: async () => {} },
        session: { resolveStorePath: () => "/tmp/store", recordInboundSession: () => {} },
        reply: { dispatchReplyWithBufferedBlockDispatcher: () => {} },
      },
    },
  };
}

function makeAccount(overrides?: Partial<ResolvedAccount>): ResolvedAccount {
  return {
    accountId: "acc-1",
    appId: "app-1",
    appSecret: "secret",
    apiGatewayUrl: "https://gw.example",
    allowFrom: [],
    groupAllowFrom: [],
    dmPolicy: undefined,
    groupPolicy: undefined,
    homeChannel: undefined,
    enabled: true,
    ackMessage: false,
    ackMessageTextZh: "",
    ackMessageTextEn: "",
    revokeAckMessage: true,
    dangerouslyAllowPrivateNetwork: false,
    mediaLocalRoots: [],
    ...overrides,
  } as ResolvedAccount;
}

function makeCtx(account: ResolvedAccount, signal: AbortSignal): any {
  return {
    accountId: account.appId,
    account,
    setStatus: () => {},
    abortSignal: signal,
  };
}

describe("gatewayStartAccount lifecycle (P1/P2)", () => {
  beforeEach(() => {
    _clearTestState();
    (WebSocket as any).instances.length = 0;
  });

  it("concurrent starts for the same key create exactly ONE client (mutex + adoption)", async () => {
    const api = makeRuntimeApi();
    startLansengerGateway(api);
    const account = makeAccount();

    const cA = new AbortController();
    const cB = new AbortController();
    const pA = gatewayStartAccount(makeCtx(account, cA.signal));
    const pB = gatewayStartAccount(makeCtx(account, cB.signal));
    // Let both contexts run through the lock and the mocked WS handshake.
    await new Promise((r) => setTimeout(r, 30));

    expect((WebSocket as any).instances.length).toBe(1); // ← previously 2 (orphan connection)
    const client = getRunningClient();
    expect(client).toBeTruthy();
    expect(client!.isWsAlive()).toBe(true);

    cA.abort();
    cB.abort();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("adopts the existing healthy client from autoStart instead of dialing a second connection", async () => {
    const api = makeRuntimeApi();
    api.config = {
      channels: {
        lansenger: {
          accounts: { "acc-1": { appId: "app-1", appSecret: "secret", apiGatewayUrl: "https://gw.example" } },
        },
      },
    };
    startLansengerGateway(api); // autoStart starts app-1
    await new Promise((r) => setTimeout(r, 30));
    const first = getRunningClient();
    expect(first).toBeTruthy();

    // Host-driven start with the SAME resolved account (boot race): must adopt.
    const account = getRunningAccount()!;
    const c = new AbortController();
    const p = gatewayStartAccount(makeCtx(account, c.signal));
    await new Promise((r) => setTimeout(r, 30));

    expect(getRunningClient()).toBe(first); // same instance — no second dial
    expect((WebSocket as any).instances.length).toBe(1);

    c.abort();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([p]);
  });

  it("reconnects when config actually changed (no stale adoption)", async () => {
    const api = makeRuntimeApi();
    startLansengerGateway(api);
    const accountV1 = makeAccount();

    const cA = new AbortController();
    const pA = gatewayStartAccount(makeCtx(accountV1, cA.signal));
    await new Promise((r) => setTimeout(r, 30));
    const clientV1 = getRunningClient();

    // Config change (e.g. allowFrom updated) → must NOT adopt, must dial fresh.
    const accountV2 = makeAccount({ allowFrom: ["staff-1"] });
    const cB = new AbortController();
    const pB = gatewayStartAccount(makeCtx(accountV2, cB.signal));
    await new Promise((r) => setTimeout(r, 30));

    const clientV2 = getRunningClient();
    expect(clientV2).toBeTruthy();
    expect(clientV2).not.toBe(clientV1);
    expect(clientV2!.isWsAlive()).toBe(true);

    cA.abort();
    cB.abort();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([pA, pB]);
  });

  it("abort cleanup does not kill a newer context's client (P2 identity check)", async () => {
    const api = makeRuntimeApi();
    startLansengerGateway(api);

    // Context A starts client A.
    const cA = new AbortController();
    const pA = gatewayStartAccount(makeCtx(makeAccount(), cA.signal));
    await new Promise((r) => setTimeout(r, 30));
    const clientA = getRunningClient();

    // Context B (config change) replaces the entry with client B.
    const cB = new AbortController();
    const pB = gatewayStartAccount(makeCtx(makeAccount({ allowFrom: ["x"] }), cB.signal));
    await new Promise((r) => setTimeout(r, 30));
    const clientB = getRunningClient();
    expect(clientB).not.toBe(clientA);

    // A's abort fires. Old code disconnected whatever was in runningAccounts for the
    // key — killing B's live, server-routed connection. The identity check must skip.
    cA.abort();
    await new Promise((r) => setTimeout(r, 30));

    const stillRunning = getRunningClient();
    expect(stillRunning).toBe(clientB);
    expect(clientB!.isWsAlive()).toBe(true);

    cB.abort();
    await new Promise((r) => setTimeout(r, 30));
    await Promise.allSettled([pA, pB]);
  });

  it("abort cleanup still disconnects a PATROL-HEALED client (ownership survives rotation)", async () => {
    const api = makeRuntimeApi();
    startLansengerGateway(api);

    // Context A owns the account.
    const cA = new AbortController();
    const pA = gatewayStartAccount(makeCtx(makeAccount(), cA.signal));
    await new Promise((r) => setTimeout(r, 30));
    const clientA = getRunningClient();

    // Patrol heal replaces client A with a fresh client — WITHOUT a new gateway
    // context. Ownership must stay with context A.
    await healAccount(api, "app-1", clientA!, "test-rotation");
    await new Promise((r) => setTimeout(r, 30));
    const clientB = getRunningClient();
    expect(clientB).not.toBe(clientA); // rotated
    expect(clientB!.isWsAlive()).toBe(true);

    // A's abort fires: it still OWNS the key → the healed client must be torn down.
    // (Regression: identity-check cleanup skipped here, leaving an orphan until
    // process exit — exactly the defect this PR eliminates.)
    cA.abort();
    await new Promise((r) => setTimeout(r, 30));

    expect(getRunningClient()).toBeNull(); // entry cleaned, no orphan
    expect(clientB!.isWsAlive()).toBe(false);   // healed client disconnected

    await Promise.allSettled([pA]);
  });
});