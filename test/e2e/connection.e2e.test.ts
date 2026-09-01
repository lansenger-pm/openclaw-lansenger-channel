import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FakeLansengerServer } from "./fake-lansenger-server.js";
import { makeMiniHost, waitFor, sleep, cleanupRuntime } from "./helpers.js";
import { LansengerClient } from "../../src/client.js";
import { resolveAccount } from "../../src/channel.js";
import {
  startLansengerGateway,
  gatewayStartAccount,
  getRunningClient,
  healthPatrol,
  _clearTestState,
} from "../../src/runtime.js";

/**
 * E2E Layer A — connection management against a REAL local server.
 * No ws/fetch mocks: the production client speaks the real wire protocol.
 * Fake server uses pingInterval=1s so heartbeat scenarios run fast.
 */
describe("E2E: connection management (real client ↔ fake server)", () => {
  let server: FakeLansengerServer;

  beforeAll(async () => {
    server = new FakeLansengerServer({ pingIntervalSec: 1 });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    _clearTestState();
  });
  beforeEach(() => {
    server.apiCalls.length = 0;
    server.connectLog.length = 0;
  });

  it("connects, heartbeats (real ping/pong frames), and stays alive", async () => {
    const client = new LansengerClient({ appId: "app-hb", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    const events: any[] = [];
    client.setMessageHandler(async (e) => { events.push(e); });
    expect(await client.connect()).toBe(true);

    await waitFor(() => client.isWsAlive() && client.wsState() === "OPEN", 5_000, "WS open");
    // pingInterval=1s → ≥5 pings answered within ~6s proves the real keepalive loop
    await sleep(6_000);
    expect(client.isWsAlive()).toBe(true);
    expect(server.connectionCount("app-hb")).toBe(1);
    expect(client.lastPongAgeMs()).toBeLessThan(5_000); // pongs actually flowing

    await client.disconnect();
    await waitFor(() => server.connectionCount("app-hb") === 0, 3_000, "server saw close");
  }, 20_000);

  it("reconnects after the server drops the socket (real close, backoff, fresh ticket)", async () => {
    const client = new LansengerClient({ appId: "app-drop", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    expect(await client.connect()).toBe(true);
    await waitFor(() => server.connectionCount("app-drop") === 1, 5_000, "first connection");

    server.killAllSockets();
    // backoff starts at 2s → reconnected well within 10s
    await waitFor(() => server.connectionCount("app-drop") === 1 && server.connectLog.length >= 2, 10_000, "reconnect");
    expect(client.isWsAlive()).toBe(true);

    await client.disconnect();
  }, 20_000);

  it("pong timeout (silent server) → closes zombie connection → reconnects", async () => {
    const client = new LansengerClient({ appId: "app-silent", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    expect(await client.connect()).toBe(true);
    await waitFor(() => server.connectionCount("app-silent") === 1 && client.wsState() === "OPEN", 5_000, "connected");

    server.stopRespondingPongs();
    // PONG_TIMEOUT_MS=15s + close + 2s backoff → second connection within ~20s
    await waitFor(() => server.connectLog.filter((c) => c.appId === "app-silent").length >= 2, 25_000, "pong-timeout reconnect");
    server.resumeRespondingPongs();
    await waitFor(() => client.isWsAlive(), 10_000, "healthy again after reconnect");

    await client.disconnect();
  }, 35_000);

  it("credential failure (errCode 40018) → connect returns false, no socket dialed", async () => {
    server.rejectNextEndpoint();
    const client = new LansengerClient({ appId: "app-bad", appSecret: "wrong", apiGatewayUrl: server.httpUrl });
    expect(await client.connect()).toBe(false);
    expect(server.connectionCount("app-bad")).toBe(0);
  }, 10_000);

  it("multi-account: parallel clients, isolated connections and event routing", async () => {
    const a = new LansengerClient({ appId: "app-m1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    const b = new LansengerClient({ appId: "app-m2", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    const gotA: any[] = [];
    const gotB: any[] = [];
    a.setMessageHandler(async (e) => { gotA.push(e); });
    b.setMessageHandler(async (e) => { gotB.push(e); });
    expect(await a.connect()).toBe(true);
    expect(await b.connect()).toBe(true);
    await waitFor(() => server.connectionCount("app-m1") === 1 && server.connectionCount("app-m2") === 1, 5_000, "both connected");

    server.pushEvent("app-m2", { msgType: "text", msgData: { text: { content: "for m2" } }, messageId: "m1", chatType: "p2p", from: "user-9", conversationId: "user-9" });
    await waitFor(() => gotB.length === 1, 5_000, "m2 received its event");
    expect(gotA).toHaveLength(0); // isolation: m1 got nothing

    await a.disconnect();
    await b.disconnect();
  }, 20_000);
});

/**
 * E2E Layer B — runtime lifecycle against the real server: the SERVER-side
 * connection count is the production "orphan connection" oracle.
 */
describe("E2E: runtime lifecycle (real runtime ↔ fake server)", () => {
  let server: FakeLansengerServer;

  beforeAll(async () => {
    server = new FakeLansengerServer({ pingIntervalSec: 1 });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    _clearTestState();
  });
  beforeEach(async () => {
    await cleanupRuntime(getRunningClient, server);
    server.connectLog.length = 0;
  });

  it("autoStart + host-driven start produce exactly ONE server-side connection (orphan regression)", async () => {
    const api = makeMiniHost(server);
    startLansengerGateway(api); // autoStart dials app-1
    await waitFor(() => server.connectionCount("app-1") === 1, 5_000, "autoStart connected");

    // Host-driven start racing in with the SAME resolved account → adoption, no second dial
    const c = new AbortController();
    const p = gatewayStartAccount({
      accountId: "app-1",
      account: resolveAccount(api.config, "app-1"),
      setStatus: () => {},
      abortSignal: c.signal,
    } as any);
    await sleep(1_500);

    expect(server.connectionCount("app-1")).toBe(1); // ← the production zombie symptom, asserted at protocol level
    expect(getRunningClient()!.isWsAlive()).toBe(true);

    c.abort();
    await sleep(300);
    await Promise.allSettled([p]);
  }, 15_000);

  it("patrol self-heals a dead connection within one tick (30s)", async () => {
    const api = makeMiniHost(server);
    startLansengerGateway(api);
    await waitFor(() => server.connectionCount("app-1") === 1, 5_000, "connected");

    server.killAllSockets();
    // The client's own backoff (2s) should restore the connection; patrol is the
    // safety net. Either way: message flow must recover without any restart.
    await waitFor(() => server.connectionCount("app-1") === 1 && getRunningClient()!.isWsAlive(), 15_000, "connection restored");
  }, 25_000);

  it("lansenger.status reflects real liveness after a server-side kill", async () => {
    const api = makeMiniHost(server);
    startLansengerGateway(api);
    await waitFor(() => server.connectionCount("app-1") === 1 && getRunningClient()?.isWsAlive() === true, 5_000, "connected (server-side)");

    let response: any = null;
    const call = () => api._methods["lansenger.status"]({ params: {}, respond: (_ok: boolean, data: any) => { response = data; } });
    call();
    expect(response.running).toBe(true);

    server.killAllSockets();
    // After the socket dies, the client reconnects on its own — status must track
    // reality through the whole cycle (never a stale hardcoded true).
    await waitFor(() => {
      call();
      return response.running === true && server.connectionCount("app-1") === 1;
    }, 15_000, "status tracks reconnect");
    // And the zombie-detection verdict on a stale entry is false:
    const client = getRunningClient()!;
    (client as any).lastPongAt = Date.now() - 120_000;
    call();
    expect(response.running).toBe(false);
    expect(response.accounts[0].wsAlive).toBe(false);
  }, 25_000);
});