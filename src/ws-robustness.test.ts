import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { LansengerClient } from "./client.js";
import type { ResolvedAccount } from "./channel.js";
import {
  startLansengerGateway,
  gatewayStartAccount,
  getRunningClient,
  getRunningAccount,
  healthPatrol,
  healAccount,
  _clearTestState,
} from "./runtime.js";

/**
 * WebSocket long-connection robustness suite.
 * Goal: from as many angles as possible, prove the connection cannot get stuck,
 * silently die, leak timers, or double-dial — the failure modes behind the
 * 8–24h "zombie" incident (see docs/zombie-lifecycle-postmortem.md).
 *
 * Sections:
 *   1. Heartbeat & pong timeout          (ping cadence, 15s detection, terminate fallback)
 *   2. Reconnect backoff                 (escalation, reset, cap, suppression, at-most-once)
 *   3. Endpoint/connect robustness       (API errors, missing fields, fresh URL, double-dial)
 *   4. Inbound message robustness        (binary, malformed JSON, handler crash isolation)
 *   5. Patrol & self-heal                (dead WS, age rotation, identity skip, truthful status)
 */

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => ({
  registerChannelRuntimeContext: vi.fn(),
}));

import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";

// Test isolation: the plugin's first-DM auto-configuration writes to the REAL
// ~/.openclaw config via execFileSync("openclaw", ["config", "set", ...]) — a
// synchronous subprocess that both blocks the event loop for seconds and POLLUTES
// the developer's live environment. Mock it so any such attempt fails fast.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("execFileSync is disabled in tests — preset config instead of auto-writing");
  }),
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];
    /** test knobs */
    static autoOpen = true; // auto-open on next macrotask
    static stuckClose = false; // close() never completes (half-open TCP simulation)

    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;
    pingCount = 0;
    closeCount = 0;
    terminateCount = 0;

    private _events: Record<string, (...args: unknown[]) => void> = {};

    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
      if (MockWebSocket.autoOpen) {
        setTimeout(() => this.simulateOpen(), 0);
      }
    }

    simulateOpen(): void {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.onopen?.();
      }
    }
    simulateServerClose(code = 1005, wasClean = false): void {
      this.readyState = 3;
      this.onclose?.({ code, reason: "", wasClean });
    }
    simulateError(message = "mock network error"): void {
      this.onerror?.({ message });
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      this._events[event] = cb;
    }
    emitPong(): void {
      this._events["pong"]?.();
    }
    ping(): void {
      this.pingCount++;
    }
    close(): void {
      this.closeCount++;
      if (MockWebSocket.stuckClose) {
        this.readyState = 2; // half-open TCP: close handshake never completes
        return;
      }
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: "", wasClean: true });
    }
    terminate(): void {
      this.terminateCount++;
      this.readyState = 3;
      this.onclose?.({ code: 1006, reason: "", wasClean: false });
    }
  }
  return { default: MockWebSocket };
});

// ── configurable fetch stub ────────────────────────────────────────────────

type EndpointResponse = { wsEndpoint?: string; pingInterval?: number; errCode?: number };
let endpointResponses: EndpointResponse[] = [];
let endpointCallCount = 0;
let fetchImpl: ((url: string) => Promise<Response>) | null = null;

function defaultFetch(url: string): Promise<Response> {
  if (url.includes("ws/endpoint")) {
    endpointCallCount++;
    const resp = endpointResponses[Math.min(endpointCallCount - 1, endpointResponses.length - 1)] ?? { wsEndpoint: "wss://mock.local" };
    const body = { errCode: resp.errCode ?? 0, errMsg: "", data: resp };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }
  return Promise.resolve(new Response(JSON.stringify({ errCode: 0, errMsg: "", data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
}

function resetMock(): void {
  (WebSocket as any).instances.length = 0;
  (WebSocket as any).autoOpen = true;
  (WebSocket as any).stuckClose = false;
  endpointResponses = [{ wsEndpoint: "wss://mock-1.local", pingInterval: 20 }];
  endpointCallCount = 0;
  fetchImpl = null;
}

function mockFetch(impl: (url: string) => Promise<Response>): void {
  fetchImpl = impl;
}

beforeEach(() => {
  resetMock();
  vi.stubGlobal("fetch", async (url: string | Request) => {
    const u = typeof url === "string" ? url : url.url;
    return fetchImpl ? fetchImpl(u) : defaultFetch(u);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function connectClient(opts?: { appId?: string }): Promise<LansengerClient> {
  const client = new LansengerClient({ appId: opts?.appId ?? "app-1", appSecret: "secret" });
  const ok = await client.connect();
  expect(ok).toBe(true);
  return client;
}

/** Advance fake timers until the pending auto-open fires and heartbeat is armed. */
async function openCurrent(client: LansengerClient): Promise<any> {
  await vi.advanceTimersByTimeAsync(5);
  const ws = (client as any).ws;
  expect(ws).toBeTruthy();
  expect(ws.readyState).toBe(1);
  return ws;
}

// ══════════════════════════════════════════════════════════════
// 1. HEARTBEAT & PONG TIMEOUT
// ══════════════════════════════════════════════════════════════

describe("isWsAlive connection-state semantics", () => {
  it("1.0a a RECENT CONNECTING dial is alive even when lastPongAt is stale from the PREVIOUS connection", () => {
    // Regression: during a redial, lastPongAt still holds the old connection's value;
    // judging the fresh dial by that stale pong caused false "zombie" verdicts and
    // needless disconnect/redial churn (patrol + adoption both consult isWsAlive).
    const client = new LansengerClient({ appId: "app-1", appSecret: "s" });
    (client as any).ws = { readyState: 0 }; // CONNECTING
    (client as any).wsStartedAt = Date.now() - 1_000; // dial started 1s ago
    (client as any).lastPongAt = Date.now() - 120_000; // previous connection went silent 120s ago
    expect(client.isWsAlive()).toBe(true);
  });

  it("1.0b a CONNECTING dial stuck longer than 30s is dead (ws has no handshake timeout)", () => {
    const client = new LansengerClient({ appId: "app-1", appSecret: "s" });
    (client as any).ws = { readyState: 0 }; // CONNECTING
    (client as any).wsStartedAt = Date.now() - 31_000; // wedged dial
    expect(client.isWsAlive()).toBe(false);
  });
});

describe("heartbeat robustness", () => {
  it("1.1 pings on interval; pongs reset the timer — no false timeout across many cycles", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);

    // Advance in exact 20s steps (aligned to the 20s interval): exactly one ping per
    // step, immediate pong after each — the healthy steady state.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ws.pingCount).toBe(i + 1);
      ws.emitPong(); // server responds immediately
    }
    expect(ws.readyState).toBe(1);
    expect(ws.closeCount).toBe(0);
    expect((WebSocket as any).instances.length).toBe(1); // no spurious reconnect
  });

  it("1.2 pong timeout (15s+interval silence) → graceful close → reconnect with fresh URL", async () => {
    vi.useFakeTimers();
    endpointResponses = [{ wsEndpoint: "wss://mock-1.local", pingInterval: 20 }, { wsEndpoint: "wss://mock-2.local", pingInterval: 20 }];
    const client = await connectClient();
    const ws = await openCurrent(client);

    await vi.advanceTimersByTimeAsync(20_000); // tick 1: ping #1 — server goes silent
    expect(ws.pingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000); // tick 2 @40s: staleness 40s > (15s+20s) → close
    expect(ws.closeCount).toBe(1); // graceful close attempted
    expect(ws.terminateCount).toBe(0); // clean close completed — no terminate needed

    await vi.advanceTimersByTimeAsync(2_100); // backoff 2s → reconnect
    expect((WebSocket as any).instances.length).toBe(2);
    expect((WebSocket as any).instances[1].url).toBe("wss://mock-2.local"); // fresh URL
    expect(client.isWsAlive()).toBe(true);
  });

  it("1.3 pong timeout with stuck close (half-open TCP) → terminate fallback at 5s", async () => {
    vi.useFakeTimers();
    (WebSocket as any).stuckClose = true;
    const client = await connectClient();
    const ws = await openCurrent(client);

    await vi.advanceTimersByTimeAsync(40_000); // tick 2 @40s: silence > 35s → close() → stuck CLOSING
    expect(ws.readyState).toBe(2); // half-open: handshake pending
    expect(ws.closeCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000); // CLOSE_FALLBACK_MS
    expect(ws.terminateCount).toBe(1); // hard terminate fired

    await vi.advanceTimersByTimeAsync(2_100); // backoff → reconnect
    expect((WebSocket as any).instances.length).toBe(2);
  });

  it("1.4 heartbeat tick on a CLOSING socket → terminate → reconnect", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);

    ws.readyState = 2; // socket stuck in CLOSING (e.g. server half-closed)
    await vi.advanceTimersByTimeAsync(20_000); // next heartbeat tick
    expect(ws.terminateCount).toBe(1); // forced terminate to trigger reconnect

    await vi.advanceTimersByTimeAsync(2_100);
    expect((WebSocket as any).instances.length).toBe(2);
  });

  it("1.5 no pings leak after disconnect() (heartbeat timer cleared)", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);
    await vi.advanceTimersByTimeAsync(20_000); // ping #1
    expect(ws.pingCount).toBe(1);

    await client.disconnect();
    const pingsAfterStop = ws.pingCount;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ws.pingCount).toBe(pingsAfterStop); // interval cleared — no leaked pings
  });

  it("1.6 heartbeat stops on server-initiated close (no pings on a dead socket)", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);
    await vi.advanceTimersByTimeAsync(20_000); // ping #1
    expect(ws.pingCount).toBe(1);

    ws.simulateServerClose(1005); // server drops the connection
    const pingsAtDeath = ws.pingCount;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.pingCount).toBe(pingsAtDeath); // onclose stopped the heartbeat
  });
});

// ══════════════════════════════════════════════════════════════
// 2. RECONNECT BACKOFF
// ══════════════════════════════════════════════════════════════

describe("reconnect backoff", () => {
  it("2.1 server closes → reconnect after 2s backoff", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);

    ws.simulateServerClose(1005);
    await vi.advanceTimersByTimeAsync(1_900); // just before backoff elapses
    expect((WebSocket as any).instances.length).toBe(1); // not yet
    await vi.advanceTimersByTimeAsync(200); // backoff (2s) elapsed
    expect((WebSocket as any).instances.length).toBe(2);
    expect(client.isWsAlive()).toBe(true);
  });

  it("2.2 consecutive failures escalate backoff 2s → 5s → 10s", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    await openCurrent(client);
    // After the first successful connection, make every subsequent dial FAIL to open
    // (autoOpen=false → socket stays CONNECTING → onopen never fires → backoffIdx
    // never resets). This is the "server unreachable" steady state.
    (WebSocket as any).autoOpen = false;

    // failure #1 (the open connection dies) → backoff 2s
    (WebSocket as any).instances[0].simulateServerClose();
    await vi.advanceTimersByTimeAsync(2_100);
    expect((WebSocket as any).instances.length).toBe(2); // dial #2 (never opens)

    // failure #2 (dial #2 dies while CONNECTING) → backoff 5s
    (WebSocket as any).instances[1].simulateServerClose();
    await vi.advanceTimersByTimeAsync(4_900);
    expect((WebSocket as any).instances.length).toBe(2); // still waiting
    await vi.advanceTimersByTimeAsync(300);
    expect((WebSocket as any).instances.length).toBe(3);

    // failure #3 → backoff 10s
    (WebSocket as any).instances[2].simulateServerClose();
    await vi.advanceTimersByTimeAsync(10_100);
    expect((WebSocket as any).instances.length).toBe(4);
  });

  it("2.3 backoff resets to 2s after a successful open", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    await openCurrent(client);

    // failure #1 (backoff was going to escalate)
    (WebSocket as any).instances[0].simulateServerClose();
    await vi.advanceTimersByTimeAsync(2_100); // reconnect #2 opens → backoffIdx reset to 0
    expect((WebSocket as any).instances.length).toBe(2);

    // failure #2 → next backoff should be 2s again (reset), not 5s
    (WebSocket as any).instances[1].simulateServerClose();
    await vi.advanceTimersByTimeAsync(2_100);
    expect((WebSocket as any).instances.length).toBe(3);
  });

  it("2.4 backoff caps at 60s under sustained failure", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    await openCurrent(client);
    (WebSocket as any).autoOpen = false; // every subsequent dial fails to open

    const delays = [2, 5, 10, 30, 60, 60];
    for (const delay of delays) {
      (WebSocket as any).instances[(WebSocket as any).instances.length - 1].simulateServerClose();
      await vi.advanceTimersByTimeAsync(delay * 1000 + 100);
    }
    // 1 initial + 6 reconnects; the 7th backoff would also be 60s (capped)
    expect((WebSocket as any).instances.length).toBe(7);
    (WebSocket as any).instances[6].simulateServerClose();
    await vi.advanceTimersByTimeAsync(59_000);
    expect((WebSocket as any).instances.length).toBe(7); // still capped-waiting
    await vi.advanceTimersByTimeAsync(1_100);
    expect((WebSocket as any).instances.length).toBe(8);
  });

  it("2.5 no reconnect after disconnect() — the zombie suppression guarantee", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);

    await client.disconnect(); // running=false → runWs exits after close
    expect(ws.closeCount).toBe(1);
    expect(ws.terminateCount).toBe(0); // clean close — no terminate needed

    await vi.advanceTimersByTimeAsync(120_000); // way beyond any backoff
    expect((WebSocket as any).instances.length).toBe(1); // NO reconnect loop
  });

  it("2.6 onerror + onclose both firing → exactly ONE reconnect (at-most-once guard)", async () => {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);

    ws.simulateError("ECONNRESET"); // error fires
    ws.simulateServerClose(1006); // close fires right after
    await vi.advanceTimersByTimeAsync(3_000);

    expect((WebSocket as any).instances.length).toBe(2); // exactly one reconnect
  });
});

// ══════════════════════════════════════════════════════════════
// 3. ENDPOINT / CONNECT ROBUSTNESS
// ══════════════════════════════════════════════════════════════

describe("connect robustness", () => {
  it("3.1 endpoint API error (e.g. 40018 bad secret) → connect fails, no WS constructed", async () => {
    endpointResponses = [{ errCode: 40018 }];
    const client = new LansengerClient({ appId: "app-1", appSecret: "bad" });
    const ok = await client.connect();
    expect(ok).toBe(false);
    expect((WebSocket as any).instances.length).toBe(0);
  });

  it("3.2 fetch throws (network down) → connect fails without crashing", async () => {
    mockFetch(async () => { throw new Error("ECONNREFUSED"); });
    const client = new LansengerClient({ appId: "app-1", appSecret: "s" });
    const ok = await client.connect();
    expect(ok).toBe(false);
    expect((WebSocket as any).instances.length).toBe(0);
  });

  it("3.3 missing credentials → connect fails fast", async () => {
    const client = new LansengerClient({ appId: "", appSecret: "" });
    expect(await client.connect()).toBe(false);
  });

  it("3.4 pingInterval: seconds→ms conversion, fallback to 20s when absent", async () => {
    endpointResponses = [{ wsEndpoint: "wss://x", pingInterval: 5 }];
    const a = new LansengerClient({ appId: "app-1", appSecret: "s" });
    await a.connect();
    expect((a as any).heartbeatIntervalMs).toBe(5_000);

    endpointResponses = [{ wsEndpoint: "wss://x" }]; // no pingInterval field
    const b = new LansengerClient({ appId: "app-1", appSecret: "s" });
    await b.connect();
    expect((b as any).heartbeatIntervalMs).toBe(20_000); // DEFAULT_HEARTBEAT_INTERVAL_MS
  });

  it("3.5 reconnect adopts a NEW pingInterval from the fresh endpoint response", async () => {
    vi.useFakeTimers();
    endpointResponses = [{ wsEndpoint: "wss://a", pingInterval: 20 }, { wsEndpoint: "wss://b", pingInterval: 30 }];
    const client = await connectClient();
    const ws = await openCurrent(client);
    expect((client as any).heartbeatIntervalMs).toBe(20_000);

    ws.simulateServerClose();
    await vi.advanceTimersByTimeAsync(2_100); // reconnect with second response
    expect((WebSocket as any).instances.length).toBe(2);
    expect((client as any).heartbeatIntervalMs).toBe(30_000);
  });

  it("3.6 double connect() does not double-dial (guard)", async () => {
    const client = new LansengerClient({ appId: "app-1", appSecret: "s" });
    const ok1 = await client.connect();
    const ok2 = await client.connect(); // duplicate — must be ignored
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect((WebSocket as any).instances.length).toBe(1); // one socket, one runWs loop
  });
});

// ══════════════════════════════════════════════════════════════
// 4. INBOUND MESSAGE ROBUSTNESS
// ══════════════════════════════════════════════════════════════

const CALLBACK_MSG = JSON.stringify({ type: "approve_card_callback", data: { eventData: "once:req-1", staffId: "s1" } });

describe("inbound message robustness", () => {
  async function openedClientWithHandler(): Promise<{ client: LansengerClient; ws: any; handler: ReturnType<typeof vi.fn> }> {
    vi.useFakeTimers();
    const client = await connectClient();
    const ws = await openCurrent(client);
    const handler = vi.fn(async () => {});
    client.setMessageHandler(handler);
    return { client, ws, handler };
  }

  it("4.1 non-text frame (object data) is skipped without crashing; Buffer frames are decoded", async () => {
    const { ws, handler } = await openedClientWithHandler();

    ws.onmessage?.({ data: { binary: true } }); // not string/Buffer → skipped
    expect(handler).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(1); // connection unaffected

    ws.onmessage?.({ data: Buffer.from(CALLBACK_MSG) }); // Buffer → decoded as utf-8
    await vi.advanceTimersByTimeAsync(5);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("4.2 malformed JSON is ignored; connection stays open", async () => {
    const { ws, handler } = await openedClientWithHandler();

    ws.onmessage?.({ data: "not-json{{{garbage" });
    await vi.advanceTimersByTimeAsync(5);
    expect(handler).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(1);
  });

  it("4.3 valid event is dispatched to the handler exactly once", async () => {
    const { ws, handler } = await openedClientWithHandler();

    ws.onmessage?.({ data: CALLBACK_MSG });
    await vi.advanceTimersByTimeAsync(5);
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as any;
    expect(event.approveCardCallback).toEqual({ eventData: "once:req-1", staffId: "s1" });
    expect(event.msgType).toBe("approve_card_callback");
  });

  it("4.4 handler exception is contained — connection stays open and later messages still processed", async () => {
    const { ws, client } = await openedClientWithHandler();
    let calls = 0;
    client.setMessageHandler(async () => {
      calls++;
      if (calls === 1) throw new Error("handler blew up");
    });

    ws.onmessage?.({ data: CALLBACK_MSG }); // throws
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toBe(1);
    expect(ws.readyState).toBe(1); // crash did NOT kill the connection

    ws.onmessage?.({ data: CALLBACK_MSG }); // next message still processed
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toBe(2);
  });

  it("4.5 message with empty events array → no handler calls, no crash", async () => {
    const { ws, handler } = await openedClientWithHandler();

    ws.onmessage?.({ data: JSON.stringify({ orgIdV1: "o", appIdV1: "a", random: "r", length: 0, events: [] }) });
    await vi.advanceTimersByTimeAsync(5);
    expect(handler).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. PATROL & SELF-HEAL
// ══════════════════════════════════════════════════════════════

function makeRuntimeApi(): any {
  const methods: Record<string, any> = {};
  return {
    _methods: methods,
    config: {
      channels: {
        lansenger: {
          accounts: { "acc-1": { appId: "app-1", appSecret: "secret", apiGatewayUrl: "https://gw.example" } },
        },
      },
    },
    registerGatewayMethod: (name: string, handler: any) => { methods[name] = handler; },
    registerHttpRoute: () => {},
    registerHook: () => {},
    on: () => {},
    runtime: {
      channel: {
        debounce: {}, // present → plugin enables the inbound debouncer (exercises the onFlush contract)
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

async function startedAccount(): Promise<{ api: any; client: LansengerClient }> {
  const api = makeRuntimeApi();
  startLansengerGateway(api); // autoStart starts acc-1
  await new Promise((r) => setTimeout(r, 20));
  const client = getRunningClient();
  expect(client).toBeTruthy();
  expect(client!.isWsAlive()).toBe(true);
  return { api, client: client! };
}

/** Make a live client look dead via stale pong (zombie) — keeps the real wsTask resolvable. */
function zombify(client: LansengerClient): void {
  (client as any).lastPongAt = Date.now() - 120_000; // beyond the 55s threshold
}

describe("patrol & self-heal", () => {
  beforeEach(() => {
    _clearTestState();
    (WebSocket as any).instances.length = 0;
  });

  it("5.1 patrol detects a dead (zombie) WS and self-heals within one tick", async () => {
    const { api, client } = await startedAccount();
    zombify(client);
    expect(client.isWsAlive()).toBe(false);

    await healthPatrol(api);

    const healed = getRunningClient();
    expect(healed).toBeTruthy();
    expect(healed).not.toBe(client); // entry replaced by a fresh client
    expect(healed!.isWsAlive()).toBe(true);
  });

  it("5.2 patrol rotates a connection older than 12h (server session refresh)", async () => {
    const { api, client } = await startedAccount();
    (client as any).wsOpenedAt = Date.now() - 13 * 60 * 60 * 1000; // 13h old
    expect(client.isWsAlive()).toBe(true); // still alive — rotation is age-based, not health-based

    await healthPatrol(api);

    const rotated = getRunningClient();
    expect(rotated).not.toBe(client);
    expect(rotated!.isWsAlive()).toBe(true);
    expect(rotated!.wsAgeMs()).toBeLessThan(60_000); // fresh connection
  });

  it("5.3 patrol leaves healthy young connections untouched", async () => {
    const { api, client } = await startedAccount();
    const before = (WebSocket as any).instances.length;

    await healthPatrol(api);

    expect(getRunningClient()).toBe(client); // same client — no churn
    expect((WebSocket as any).instances.length).toBe(before);
  });

  it("5.4 healAccount skips when the entry changed under us (identity check)", async () => {
    const { api, client } = await startedAccount();
    const before = (WebSocket as any).instances.length;
    const stranger = new LansengerClient({ appId: "app-1", appSecret: "s" }); // not the running entry

    await healAccount(api, "app-1", stranger, "test-identity-skip");

    expect(getRunningClient()).toBe(client); // untouched
    expect((WebSocket as any).instances.length).toBe(before); // no new dial
  });

  it("5.5 lansenger.status reports REAL liveness (dead entry → running:false)", async () => {
    const { api, client } = await startedAccount();

    let response: any = null;
    api._methods["lansenger.status"]({ params: {}, respond: (ok: boolean, data: any) => { response = { ok, data }; } });
    expect(response.data.running).toBe(true);
    expect(response.data.accounts[0].wsAlive).toBe(true);
    expect(response.data.accounts[0].connectionAgeSec).toBeGreaterThanOrEqual(0);

    zombify(client);
    api._methods["lansenger.status"]({ params: {}, respond: (ok: boolean, data: any) => { response = { ok, data }; } });
    expect(response.data.running).toBe(false); // NOT the old hardcoded true
    expect(response.data.accounts[0].wsAlive).toBe(false);
  });

  it("5.6 lansenger.start heals a dead entry (zombie self-heal on manual start)", async () => {
    const { api, client } = await startedAccount();
    zombify(client);

    let response: any = null;
    await api._methods["lansenger.start"]({ params: {}, respond: (ok: boolean, data: any) => { response = { ok, data }; } });

    expect(response.ok).toBe(true);
    const healed = getRunningClient();
    expect(healed).not.toBe(client);
    expect(healed!.isWsAlive()).toBe(true);
  });

  it("5.9 debounce-enabled inbound works under BOTH SDK contracts (dual-compat shim)", async () => {
    // Exercises the real debounced path (messageHandler → debouncer.enqueue → onFlush
    // shim → handleInbound → inbound.run) — the ONLY code path whose SDK contract
    // differs between OpenClaw 2026.7.1 (onFlush(items) → Promise) and 2026.8.1
    // (onFlush(items, createFlush) → flush object). This test must pass on BOTH.
    const api = makeRuntimeApi();
    api.config = {
      channels: {
        lansenger: {
          dmPolicy: "open",
          accounts: { "acc-1": { appId: "app-1", appSecret: "secret", apiGatewayUrl: "https://gw.example", homeChannel: "user-1" } },
        },
      },
      messages: { inbound: { debounceMs: 30 } },
      commands: { ownerAllowFrom: ["lansenger:user-1"] }, // preset → skips the auto-write execFileSync
    };
    const inboundRun = vi.fn(async () => {});
    api.runtime.channel.inbound.run = inboundRun;
    startLansengerGateway(api); // autoStart → _startAccountImpl debouncer (shim site #1)
    await new Promise((r) => setTimeout(r, 20));
    const client = getRunningClient();
    expect(client).toBeTruthy();

    const body = JSON.stringify({
      events: [{
        type: "bot_p2p_message",
        data: {
          msgType: "text",
          msgData: { text: { content: "hello" } },
          messageId: "m-1",
          chatType: "p2p",
          from: "user-1",
          senderName: "Alice",
          conversationId: "user-1",
          reminder: { isAtMe: false, isAtAll: false },
        },
      }],
    });

    // (a) autoStart-path debouncer
    const t0 = Date.now();
    if (!process.env.SKIP_MSG) (client as any).ws.onmessage?.({ data: body });
    await new Promise((r) => setTimeout(r, 5));
    expect(inboundRun).not.toHaveBeenCalled(); // still inside the debounce window
    await new Promise((r) => setTimeout(r, 300)); // flush (either contract)
    expect(inboundRun).toHaveBeenCalledTimes(1);
    const t1 = Date.now();
    // (b) gatewayStartAccount new-client debouncer (shim site #2): config change forces a fresh dial
    const c = new AbortController();
    const account = getRunningAccount()!;
    const changed = { ...account, allowFrom: ["x"] } as any;
    const p = gatewayStartAccount({ accountId: "app-1", account: changed, setStatus: () => {}, abortSignal: c.signal } as any);
    await new Promise((r) => setTimeout(r, 30));
    const client2 = getRunningClient();
    expect(client2).not.toBe(client);

    inboundRun.mockClear();
    (client2 as any).ws.onmessage?.({ data: body });
    await new Promise((r) => setTimeout(r, 5));
    expect(inboundRun).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 300));
    expect(inboundRun).toHaveBeenCalledTimes(1);

    c.abort();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([p]);
  });

  it("5.8 adoption registers the native approval runtime context (regression: was skipped when adopting)", async () => {
    const api = makeRuntimeApi();
    startLansengerGateway(api); // autoStart starts acc-1 (never registers the approval context)
    await new Promise((r) => setTimeout(r, 20));
    const first = getRunningClient();

    vi.mocked(registerChannelRuntimeContext).mockClear();
    const account = getRunningAccount()!; // SAME resolved account → adoption path
    const c = new AbortController();
    const fakeRuntime = { marker: "channel-runtime" } as any;
    const p = gatewayStartAccount({
      accountId: "app-1", account, setStatus: () => {}, abortSignal: c.signal, channelRuntime: fakeRuntime,
    } as any);
    await new Promise((r) => setTimeout(r, 30));

    expect(getRunningClient()).toBe(first); // adopted
    expect(registerChannelRuntimeContext).toHaveBeenCalledTimes(1);
    const call = vi.mocked(registerChannelRuntimeContext).mock.calls[0]![0] as any;
    expect(call.channelRuntime).toBe(fakeRuntime);
    expect(call.accountId).toBe("app-1");
    expect(call.capability).toContain("approval");

    c.abort();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([p]);
  });

  it("5.7 gatewayStartAccount reconnects when the existing entry is a zombie (no stale adoption)", async () => {
    const { api, client } = await startedAccount();
    zombify(client);

    const c = new AbortController();
    const ctx: any = {
      accountId: "app-1",
      account: {
        accountId: "acc-1", appId: "app-1", appSecret: "secret", apiGatewayUrl: "https://gw.example",
        allowFrom: [], groupAllowFrom: [], dmPolicy: undefined, groupPolicy: undefined, homeChannel: undefined,
        enabled: true, ackMessage: false, ackMessageTextZh: "", ackMessageTextEn: "", revokeAckMessage: true,
        dangerouslyAllowPrivateNetwork: false, mediaLocalRoots: [],
      },
      setStatus: () => {},
      abortSignal: c.signal,
    };
    const p = gatewayStartAccount(ctx);
    await new Promise((r) => setTimeout(r, 30));

    const fresh = getRunningClient();
    expect(fresh).not.toBe(client); // zombie was replaced, not adopted
    expect(fresh!.isWsAlive()).toBe(true);

    c.abort();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([p]);
  });
});