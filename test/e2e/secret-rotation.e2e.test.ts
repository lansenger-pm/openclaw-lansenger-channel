/**
 * E2E Layer A — secret-rotation self-heal against a REAL local server
 * (spec §5 T4; the customer-reported scenario).
 *
 * T4-1  Token revocation with an unchanged secret: the plugin refreshes and
 *       retries on its own — the message is delivered exactly once.
 * T4-2  Secret actually rotated on the admin console WITHOUT updating
 *       openclaw.json: outbound fails with an actionable hint, status shows
 *       the rejection; after "update config + restart" (new client with the
 *       new secret) delivery recovers.
 * T4-3  Throughout the incident the WS long connection stays up and inbound
 *       events keep flowing (the masking effect the customer observed).
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { FakeLansengerServer } from "./fake-lansenger-server.js";
import { waitFor, sleep } from "./helpers.js";
import { LansengerClient } from "../../src/client.js";
import { _clearTestState } from "../../src/runtime.js";

function apptokenCalls(server: FakeLansengerServer): number {
  return server.apiCalls.filter((c) => c.path === "/v1/apptoken/create").length;
}
function messageCalls(server: FakeLansengerServer): number {
  return server.apiCalls.filter((c) => c.path === "/v1/bot/messages/create").length;
}

describe("E2E: secret rotation self-heal (real client ↔ fake server)", () => {
  let server: FakeLansengerServer;

  afterAll(async () => {
    await server.stop();
    _clearTestState();
  });
  beforeEach(async () => {
    // Stop the previous server first — secrets/revocations must not leak
    // across cases (audit P2: lifecycle aligned with repo e2e conventions).
    if (server) await server.stop().catch(() => {});
    server = new FakeLansengerServer({ pingIntervalSec: 1 });
    await server.start();
    server.apiCalls.length = 0;
  });

  it("T4-1: revokes tokens (secret unchanged) — client self-heals and delivers exactly once, WS stays up", async () => {
    const client = new LansengerClient({ appId: "app-rot", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    const inbound: any[] = [];
    client.setMessageHandler(async (e) => { inbound.push(e); });
    expect(await client.connect()).toBe(true);
    await waitFor(() => client.isWsAlive() && client.wsState() === "OPEN", 5_000, "WS open");

    // Baseline outbound works and caches a token.
    expect((await client.sendText("user-1", "before")).success).toBe(true);
    const apptokenBefore = apptokenCalls(server);
    const messageBefore = messageCalls(server);

    // Server-side token cache flush (secret unchanged).
    server.revokeAllTokens();
    const result = await client.sendText("user-1", "after-revoke");
    expect(result.success).toBe(true);

    // Self-heal evidence: exactly one extra refresh, one rejected + one delivered POST.
    expect(apptokenCalls(server)).toBe(apptokenBefore + 1);
    expect(messageCalls(server)).toBe(messageBefore + 2);
    // The WS connection was never disturbed.
    expect(client.isWsAlive()).toBe(true);
    expect(client.wsState()).toBe("OPEN");

    await client.disconnect();
  }, 20_000);

  it("T4-2: secret rotated without updating config — actionable failure, status rejected; recovers after re-provision", async () => {
    // "old-secret" == the secret currently valid on the server (the default).
    const client = new LansengerClient({ appId: "app-rot2", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    expect(await client.connect()).toBe(true);
    await waitFor(() => client.isWsAlive() && client.wsState() === "OPEN", 5_000, "WS open");
    expect((await client.sendText("user-1", "before")).success).toBe(true);

    // The admin console resets the appSecret.
    server.rotateSecret("new-secret");

    // Old secret can no longer refresh — the failure must be actionable.
    const failed = await client.sendText("user-1", "during-incident");
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("openclaw gateway restart");
    const status = client.getTokenStatus();
    expect(status.lastRefreshResult).toBe("rejected");
    expect(status.lastRefreshErrCode).toBe(40018);

    // "Update openclaw.json + gateway restart" == re-provision the client with
    // the new secret (what the host does after a config change).
    const refreshed = new LansengerClient({ appId: "app-rot2", appSecret: "new-secret", apiGatewayUrl: server.httpUrl });
    expect(await refreshed.connect()).toBe(true);
    await waitFor(() => refreshed.isWsAlive() && refreshed.wsState() === "OPEN", 5_000, "re-provisioned WS open");
    const recovered = await refreshed.sendText("user-1", "after-re-provision");
    expect(recovered.success).toBe(true);

    await client.disconnect();
    await refreshed.disconnect();
  }, 25_000);

  it("T4-3: inbound events keep flowing through the revocation incident (masking effect)", async () => {
    const client = new LansengerClient({ appId: "app-rot3", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    const inbound: any[] = [];
    client.setMessageHandler(async (e) => { inbound.push(e); });
    expect(await client.connect()).toBe(true);
    await waitFor(() => client.isWsAlive() && client.wsState() === "OPEN", 5_000, "WS open");

    expect((await client.sendText("user-1", "before")).success).toBe(true);

    // Incident: tokens revoked. Inbound push still works while outbound self-heals.
    server.revokeAllTokens();
    server.pushEvent("app-rot3", {
      from: "user-1",
      msgId: "inbound-1",
      msgType: "text",
      msgData: { text: { content: "ping during incident" } },
      chatType: "p2p",
    });
    await waitFor(() => inbound.length >= 1, 5_000, "inbound during incident");
    expect(inbound[0]?.text).toContain("ping during incident");

    // Outbound self-heals on the next call.
    expect((await client.sendText("user-1", "after-revoke")).success).toBe(true);
    // And the WS survived the whole incident.
    expect(client.isWsAlive()).toBe(true);

    await client.disconnect();
    await sleep(100);
  }, 25_000);

});