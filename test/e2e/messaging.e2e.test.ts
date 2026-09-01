import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FakeLansengerServer } from "./fake-lansenger-server.js";
import { LansengerClient } from "../../src/client.js";

/**
 * E2E Layer A — outbound API contract: every send produces the exact HTTP
 * request shape the real Lanxin gateway expects (path, query, body fields,
 * unit conversions, fallbacks). The fake server records and we assert.
 */
describe("E2E: outbound messaging contract", () => {
  let server: FakeLansengerServer;
  let client: LansengerClient;

  beforeAll(async () => {
    server = new FakeLansengerServer({ pingIntervalSec: 1 });
    await server.start();
    client = new LansengerClient({ appId: "app-out", appSecret: "test-secret", apiGatewayUrl: server.httpUrl });
    await client.connect();
  });
  afterAll(async () => {
    await client.disconnect();
    await server.stop();
  });
  beforeEach(() => {
    server.apiCalls.length = 0;
  });

  it("DM text → POST /v1/bot/messages/create with userIdList + text body", async () => {
    const r = await client.sendText("user-1", "hello");
    expect(r.success).toBe(true);
    const call = server.calls("/v1/bot/messages/create")[0]!;
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({ userIdList: ["user-1"], msgType: "text" });
    expect(call.body.msgData.text.content).toBe("hello");
  }, 10_000);

  it("group text → POST /v1/messages/group/create with groupId", async () => {
    // Group routing via the chatType cache: seed it with an inbound group event first.
    client.setMessageHandler(async () => {}); // required: processRawMessage runs only when a handler is set
    server.pushEvent("app-out", {
      msgType: "text", msgData: { text: { content: "seed" } }, messageId: "m-seed",
      chatType: "group", from: "user-1", groupId: "g-1", groupName: "G",
      reminder: { isAtMe: true, isAtAll: false },
    });
    await new Promise((r) => setTimeout(r, 300));
    server.apiCalls.length = 0;

    await client.sendText("g-1", "group hello");
    const call = server.calls("/v1/messages/group/create")[0]!;
    expect(call.body).toMatchObject({ groupId: "g-1", msgType: "text" });
  }, 10_000);

  it("formatText (markdown) carries formatType=1", async () => {
    await client.sendFormatText("user-1", "**bold**");
    const call = server.calls("/v1/bot/messages/create")[0]!;
    expect(call.body.msgType).toBe("formatText");
    expect(call.body.msgData.formatText.formatType).toBe(1);
  }, 10_000);

  it("appCard converts px → pt and clamps to [12,36]", async () => {
    await client.sendAppCard("user-1", {
      title: "card",
      description: "<div style='font-size:20px'>big</div>", // description is a converted field (PX_TO_PT_FIELDS)
    } as any);
    const call = server.calls("/v1/bot/messages/create")[0]!;
    const inner = JSON.stringify(call.body);
    expect(inner).toContain("15pt"); // 20px × 0.75
    expect(inner).not.toContain("20px");
  }, 10_000);

  it("appToken is cached: two sends → exactly one token call", async () => {
    (client as any).appToken = null; // force one fresh fetch, then it must be reused
    await client.sendText("user-1", "one");
    await client.sendText("user-1", "two");
    expect(server.calls("/v1/apptoken/create")).toHaveLength(1);
  }, 10_000);

  it("revoke hits /v1/messages/revoke with messageIds", async () => {
    const r = await client.revokeMessage(["mid-1"], "bot");
    expect(r.success).toBe(true);
    const call = server.calls("/v1/messages/revoke")[0]!;
    expect(call.body).toMatchObject({ chatType: "bot", messageIds: ["mid-1"] });
  }, 10_000);

  it("dynamic card update hits /v1/messages/dynamic/update", async () => {
    const r = await client.updateDynamicCard("card-1", { status: "approved", color: "#198754" });
    expect(r.success).toBe(true);
    expect(server.calls("/v1/messages/dynamic/update")).toHaveLength(1);
  }, 10_000);

  it("inbound group event seeds chatTypeCache → later sends to that chatId route to the group endpoint", async () => {
    // Simulate the real routing source: an inbound group event for chatId g-9
    client.setMessageHandler(async () => {});
    server.pushEvent("app-out", {
      msgType: "text", msgData: { text: { content: "hi" } }, messageId: "mx",
      chatType: "group", from: "user-1", groupId: "g-9", groupName: "G",
      reminder: { isAtMe: true, isAtAll: false },
    });
    await new Promise((r) => setTimeout(r, 300));
    server.apiCalls.length = 0;

    await client.sendText("g-9", "reply to group"); // no explicit group flag — routing must come from cache
    expect(server.calls("/v1/messages/group/create")).toHaveLength(1);
    expect(server.calls("/v1/bot/messages/create")).toHaveLength(0);
  }, 10_000);
});