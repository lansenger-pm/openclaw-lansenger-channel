import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Spy on the framework approval resolution to assert it runs EXACTLY ONCE per
// click (regression: a paste error in the cleanup-reorder fix left a duplicate
// resolveApprovalOverGateway block — every click resolved twice).
vi.mock("openclaw/plugin-sdk/approval-handler-runtime", async (importOriginal) => {
  const original = await importOriginal<any>();
  return { ...original, resolveApprovalOverGateway: vi.fn(async () => {}) };
});
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-handler-runtime";

import { FakeLansengerServer } from "./fake-lansenger-server.js";
import { makeMiniHost, waitFor, cleanupRuntime } from "./helpers.js";
import { startLansengerGateway, getRunningClient, _clearTestState } from "../../src/runtime.js";
import { pendingApprovalCallbacks } from "../../src/channel.js";

/**
 * E2E: approval card closed loop — a pending approval (as created by the
 * exec-approval delivery path) + a REAL approve_card_callback pushed over the
 * wire → approver authorization → card status update over real HTTP.
 * The unauthorized path must be rejected with a notice and NO card update.
 */
describe("E2E: approval card closed loop (real wire)", () => {
  let server: FakeLansengerServer;
  let api: any;

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
    server.apiCalls.length = 0;
    pendingApprovalCallbacks.clear();
    vi.mocked(resolveApprovalOverGateway).mockClear();

    api = makeMiniHost(server); // commands.ownerAllowFrom: ["lansenger:user-1"] → approver = user-1
    startLansengerGateway(api);
    await waitFor(() => server.connectionCount("app-1") === 1, 5_000, "account connected");
  });

  function seedPending(requestId: string): void {
    pendingApprovalCallbacks.set(requestId, {
      messageId: `card-${requestId}`,
      lang: "zh",
      chatId: "user-1",
      sessionKey: "sess-1",
      createdAtMs: Date.now(),
    });
  }

  it("authorized approver clicking 批准 → card updated to approved over real HTTP", async () => {
    seedPending("req-ok-1");
    server.pushRaw("app-1", {
      type: "approve_card_callback",
      data: { eventData: "once:req-ok-1", staffId: "user-1" },
    });

    await waitFor(() => server.calls("/v1/messages/dynamic/update").length === 1, 5_000, "card status update");
    const update = server.calls("/v1/messages/dynamic/update")[0]!;
    const body = JSON.stringify(update.body);
    expect(body).toContain("已批准"); // zh lang → Chinese status text
    expect(body).toContain("#198754"); // approved green
    expect(body).toContain("card-req-ok-1"); // the original card message id
    // callback consumed — a second click must be a no-op
    await waitFor(() => pendingApprovalCallbacks.get("req-ok-1") === undefined, 3_000, "callback mapping consumed");
    // framework resolution ran EXACTLY ONCE (regression: duplicate block resolved twice)
    await waitFor(() => vi.mocked(resolveApprovalOverGateway).mock.calls.length === 1, 3_000, "approval resolved once");
    expect(vi.mocked(resolveApprovalOverGateway).mock.calls[0]![0]).toMatchObject({
      approvalId: "req-ok-1",
      decision: "allow-once",
      senderId: "user-1",
    });
  }, 15_000);

  it("UNAUTHORIZED staff clicking → rejected with notice, NO card update", async () => {
    seedPending("req-deny-1");
    server.pushRaw("app-1", {
      type: "approve_card_callback",
      data: { eventData: "once:req-deny-1", staffId: "user-9" }, // user-9 is NOT an approver
    });

    await waitFor(() => server.calls("/v1/bot/messages/create").length === 1, 5_000, "rejection notice sent");
    const notice = server.calls("/v1/bot/messages/create")[0]!;
    expect(JSON.stringify(notice.body)).toContain("没有权限");
    expect(server.calls("/v1/messages/dynamic/update")).toHaveLength(0); // card NOT updated
    expect(pendingApprovalCallbacks.get("req-deny-1")).toBeDefined(); // still pending for the real approver
  }, 15_000);

  it("deny choice → card updated to denied", async () => {
    seedPending("req-deny-2");
    server.pushRaw("app-1", {
      type: "approve_card_callback",
      data: { eventData: "deny:req-deny-2", staffId: "user-1" },
    });

    await waitFor(() => server.calls("/v1/messages/dynamic/update").length === 1, 5_000, "card denied update");
    const body = JSON.stringify(server.calls("/v1/messages/dynamic/update")[0]!.body);
    expect(body).toContain("已拒绝");
    expect(body).toContain("#dc3545"); // denied red
  }, 15_000);

  it("unknown requestId → ignored (no outbound at all)", async () => {
    server.pushRaw("app-1", {
      type: "approve_card_callback",
      data: { eventData: "once:req-unknown", staffId: "user-1" },
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(server.apiCalls.filter((c) => c.path.includes("messages"))).toHaveLength(0);
  }, 15_000);
});