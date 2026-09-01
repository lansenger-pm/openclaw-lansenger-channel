import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FakeLansengerServer } from "./fake-lansenger-server.js";
import { makeMiniHost, waitFor, cleanupRuntime } from "./helpers.js";
import { startLansengerGateway, getRunningClient, _clearTestState } from "../../src/runtime.js";
import { registerLansengerTools } from "../../src/tools.js";

/**
 * E2E: agent tools — the REAL tool registrations (registerLansengerTools) driving
 * the REAL client against the fake server. Tool execute() → HTTP contract on the
 * wire, including deliveryContext target resolution.
 */
describe("E2E: agent tools (real tools ↔ real wire)", () => {
  let server: FakeLansengerServer;
  let api: any;
  let tools: Map<string, any>;

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

    api = makeMiniHost(server);
    tools = new Map();
    const toolApi = {
      ...api,
      registerTool: (factory: (ctx: any) => any) => {
        const tool = factory({ agentAccountId: "app-1", deliveryContext: { to: "user-1" } });
        tools.set(tool.name, tool);
      },
    };
    registerLansengerTools(toolApi);
    startLansengerGateway(api);
    await waitFor(() => server.connectionCount("app-1") === 1, 5_000, "account connected");
  });

  function tool(name: string): any {
    const t = tools.get(name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t;
  }

  async function run(name: string, params: any): Promise<any> {
    const result = await tool(name).execute("call-1", params);
    // Tool results use the LLM content format: { content: [{ type: "text", text: JSON }] }
    const text = result.content?.[0]?.text ?? result.text ?? "{}";
    return JSON.parse(typeof text === "string" ? text : JSON.stringify(text));
  }

  it("registers all 15 lansenger_* tools", () => {
    expect(tools.size).toBe(15);
    for (const name of ["lansenger_send_text", "lansenger_send_format_text", "lansenger_send_app_card",
      "lansenger_send_approve_card", "lansenger_revoke_message", "lansenger_query_groups",
      "lansenger_group_info", "lansenger_group_members", "lansenger_download_media"]) {
      expect(tools.has(name), name).toBe(true);
    }
  }, 15_000);

  it("lansenger_send_text → DM contract with deliveryContext target", async () => {
    const r = await run("lansenger_send_text", { content: "tool hello" });
    expect(r.success).toBe(true);
    const call = server.calls("/v1/bot/messages/create")[0]!;
    expect(call.body.userIdList).toEqual(["user-1"]); // from ctx.deliveryContext.to
    expect(call.body.msgData.text.content).toBe("tool hello");
  }, 15_000);

  it("lansenger_send_format_text → formatText contract (markdown)", async () => {
    const r = await run("lansenger_send_format_text", { content: "**bold** from tool" });
    expect(r.success).toBe(true);
    const call = server.calls("/v1/bot/messages/create")[0]!;
    expect(call.body.msgType).toBe("formatText");
    expect(call.body.msgData.formatText.text).toBe("**bold** from tool");
  }, 15_000);

  it("lansenger_send_text with explicit `to` overrides the delivery target (group routing via inbound seed)", async () => {
    // Seed the chatTypeCache the way production does: an inbound group event for g-1
    server.pushEvent("app-1", {
      msgType: "text", msgData: { text: { content: "seed" } }, messageId: "m-seed",
      chatType: "group", from: "user-1", groupId: "g-1", groupName: "G",
      reminder: { isAtMe: true, isAtAll: false },
    });
    await new Promise((r) => setTimeout(r, 300));
    server.apiCalls.length = 0;

    await run("lansenger_send_text", { content: "to group", to: "g-1" });
    const call = server.calls("/v1/messages/group/create")[0]!;
    expect(call.body.groupId).toBe("g-1");
    expect(server.calls("/v1/bot/messages/create")).toHaveLength(0); // NOT routed as DM
  }, 15_000);

  it("lansenger_query_groups returns the server's group list", async () => {
    const r = await run("lansenger_query_groups", {});
    expect(r.success).toBe(true);
    expect(r.groupIds).toEqual(["g-1"]);
    expect(server.calls("/v2/groups/fetch")).toHaveLength(1);
  }, 15_000);

  it("lansenger_revoke_message → revoke contract", async () => {
    const r = await run("lansenger_revoke_message", { messageIds: ["m-1", "m-2"], chatType: "bot" });
    expect(r.success).toBe(true);
    const call = server.calls("/v1/messages/revoke")[0]!;
    expect(call.body.messageIds).toEqual(["m-1", "m-2"]);
  }, 15_000);

  it("lansenger_send_approve_card → approveCard contract with buttons", async () => {
    const r = await run("lansenger_send_approve_card", {
      head: { title: "审批" },
      body: { title: "部署生产", description: "确认发布 v1.0" },
      buttons: [{ text: "批准", callbackInfo: "once:req-e2e-1", buttonTheme: 1 }],
    });
    expect(r.success).toBe(true);
    const call = server.calls("/v1/bot/messages/create")[0]!;
    expect(call.body.msgType).toBe("approveCard");
    expect(call.body.msgData.approveCard.buttons[0].callbackInfo).toBe("once:req-e2e-1");
  }, 15_000);
});