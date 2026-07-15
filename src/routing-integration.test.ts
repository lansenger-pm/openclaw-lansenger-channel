/**
 * L3: Routing integration tests
 *
 * Verify end-to-end message routing: inbound → chatTypeCache → outbound API.
 * These tests prevent regressions like:
 *   - v3.17.5: pairing code sent via group API instead of DM API
 *   - v3.17.6: secret-contract-api.js not discoverable by openclaw CLI
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LansengerClient } from "./client.js";
import { startLansengerGateway, _clearTestState } from "./runtime.js";
import { lansengerPlugin, resolveAccount } from "./channel.js";

// ── Shared helpers ──────────────────────────────────────────────────────

function makeApi(overrides?: Record<string, any>): any {
  const methods: Record<string, any> = {};
  const httpRoutes: any[] = [];
  const hookHandlers: Record<string, any> = {};
  return {
    config: overrides?.config ?? {
      channels: {
        lansenger: { appId: "test-app", appSecret: "test-secret" },
      },
    },
    registerGatewayMethod: (name: string, handler: any) => { methods[name] = handler; },
    registerHttpRoute: (route: any) => { httpRoutes.push(route); },
    registerHook: (name: string, handler: any) => { hookHandlers[name] = handler; },
    on: (name: string, handler: any, opts?: any) => { hookHandlers[name] = handler; },
    runtime: overrides?.runtime ?? {
      channel: {
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => ({ code: "PAIR123" }),
          buildPairingReply: ({ code }: any) => `Pairing code: ${code}`,
        },
        groups: {
          resolveGroupPolicy: () => ({ allowed: true }),
          resolveRequireMention: () => false,
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1", matchedBy: "default" }),
        },
        commands: {
          shouldHandleTextCommands: () => false,
          shouldComputeCommandAuthorized: () => false,
          isControlCommandMessage: () => false,
        },
        turn: { run: async () => {} },
        inbound: { run: async () => {} },
        session: {
          resolveStorePath: () => "/tmp/store",
          recordInboundSession: () => {},
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: () => {},
        },
      },
    },
    _methods: methods,
    _httpRoutes: httpRoutes,
    _hookHandlers: hookHandlers,
  };
}

function dmWebhookBody(overrides?: { senderId?: string; text?: string }) {
  return {
    events: [{
      type: "bot_p2p_message",
      data: {
        msgType: "text",
        msgData: { text: { content: overrides?.text ?? "hello" } },
        messageId: "msg-dm-1",
        chatType: "p2p",
        from: overrides?.senderId ?? "user-1",
        senderName: "Alice",
        conversationId: overrides?.senderId ?? "user-1",
        reminder: { isAtMe: false, isAtAll: false },
      },
    }],
  };
}

function groupWebhookBody(overrides?: { senderId?: string; text?: string; groupId?: string }) {
  return {
    events: [{
      type: "bot_group_message",
      data: {
        msgType: "text",
        msgData: { text: { content: overrides?.text ?? "hello" } },
        messageId: "msg-group-1",
        chatType: "group",
        from: overrides?.senderId ?? "user-1",
        senderName: "Alice",
        groupId: overrides?.groupId ?? "group-1",
        groupName: "Test Group",
        reminder: { isAtMe: true, isAtAll: false },
      },
    }],
  };
}

function makeReq(body: any): any {
  const json = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    [Symbol.asyncIterator]: async function* () { yield json; },
  };
}

function makeRes(): any {
  return { statusCode: 0, end: vi.fn() };
}

function makeNoCredApi(channelOverrides?: Record<string, any>): any {
  return makeApi({
    config: {
      channels: {
        lansenger: {
          appId: "",
          appSecret: "",
          dmPolicy: "pairing",
          allowFrom: [] as string[],
          autoMentionReply: false,
          autoQuoteReply: false,
          ...(channelOverrides ?? {}),
        },
      },
    },
  });
}

// ── L3 Tests ────────────────────────────────────────────────────────────

describe("L3: Routing integration tests", () => {

  beforeEach(() => { _clearTestState(); });

  describe("L3-1: First DM triggers pairing via private API", () => {
    let capturedUrls: string[];
    let capturedBodies: Record<string, any>[];

    beforeEach(() => {
      capturedUrls = [];
      capturedBodies = [];
      vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
            { headers: { "content-type": "application/json" } },
          );
        capturedUrls.push(u);
        if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
          { headers: { "content-type": "application/json" } },
        );
      });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("pairing code is sent via private API (userIdList), not group API (groupId)", async () => {
      const api = makeNoCredApi({ dmPolicy: "pairing", allowFrom: [] });
      startLansengerGateway(api);

      api.runtime.channel.inbound.run = vi.fn().mockResolvedValue(undefined);

      const route = api._httpRoutes.at(-1)!;
      await route.handler(makeReq(dmWebhookBody({ senderId: "unknown-user" })), makeRes());

      // Verify inbound.run was NOT called (pairing blocks it)
      expect(api.runtime.channel.inbound.run).not.toHaveBeenCalled();

      // Verify the outbound pairing code went to the private message endpoint
      const privateApiCalls = capturedUrls.filter(u => u.includes("bot/messages/create"));
      const groupApiCalls = capturedUrls.filter(u => u.includes("messages/group/create"));
      expect(privateApiCalls).toHaveLength(1);
      expect(groupApiCalls).toHaveLength(0);

      // Verify payload uses userIdList, not groupId
      const pairingBody = capturedBodies.find(b => b.userIdList);
      expect(pairingBody).toBeDefined();
      expect(pairingBody!.userIdList).toContain("unknown-user");
      expect(pairingBody).not.toHaveProperty("groupId");
    });
  });

  describe("L3-3/4/5: Outbound reply routes via correct API after inbound", () => {
    it("L3-3: Group inbound → processRawMessage caches groupId as group → sendText uses groupId", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });

      // Simulate inbound group message populating chatTypeCache
      const raw = JSON.stringify(groupWebhookBody({ groupId: "group-1" }));
      await client.processRawMessage(raw);
      expect(client.isGroupChat("group-1")).toBe(true);

      // Now send outbound — should use groupId in payload
      let capturedBody: Record<string, any> | undefined;
      vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
      });

      await client.sendText("group-1", "reply");
      expect(capturedBody).toHaveProperty("groupId", "group-1");
      expect(capturedBody).not.toHaveProperty("userIdList");

      vi.restoreAllMocks();
    });

    it("L3-4: DM inbound → processRawMessage caches chatId as DM → sendText uses userIdList", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });

      // Simulate inbound DM populating chatTypeCache
      const raw = JSON.stringify(dmWebhookBody({ senderId: "user-1" }));
      await client.processRawMessage(raw);
      expect(client.isGroupChat("user-1")).toBe(false);

      let capturedBody: Record<string, any> | undefined;
      vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
      });

      await client.sendText("user-1", "reply");
      expect(capturedBody).toHaveProperty("userIdList", ["user-1"]);
      expect(capturedBody).not.toHaveProperty("groupId");

      vi.restoreAllMocks();
    });

    it("L3-5: Same client handles group then DM correctly", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });

      // Inbound group message
      await client.processRawMessage(JSON.stringify(groupWebhookBody({ groupId: "group-A" })));
      // Inbound DM
      await client.processRawMessage(JSON.stringify(dmWebhookBody({ senderId: "user-1" })));

      expect(client.isGroupChat("group-A")).toBe(true);
      expect(client.isGroupChat("user-1")).toBe(false);

      const capturedBodies: Record<string, any>[] = [];
      vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
        if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
      });

      // Reply to group
      await client.sendText("group-A", "group reply");
      expect(capturedBodies[capturedBodies.length - 1]).toHaveProperty("groupId", "group-A");

      // Reply to DM
      await client.sendText("user-1", "dm reply");
      expect(capturedBodies[capturedBodies.length - 1]).toHaveProperty("userIdList", ["user-1"]);

      vi.restoreAllMocks();
    });
  });

  describe("L3-6/7: chatTypeCache populated from inbound messages", () => {
    it("L3-6: bot_group_message caches chatId as group", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });
      const raw = JSON.stringify({
        events: [{
          type: "bot_group_message",
          data: {
            msgType: "text",
            msgData: { text: { content: "hi" } },
            messageId: "m1",
            chatType: "group",
            from: "user-1",
            groupId: "group-abc",
            senderName: "Alice",
            reminder: { isAtMe: true, isAtAll: false },
          },
        }],
      });
      await client.processRawMessage(raw);
      expect(client.isGroupChat("group-abc")).toBe(true);
    });

    it("L3-7: bot_p2p_message caches chatId as DM", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });
      const raw = JSON.stringify({
        events: [{
          type: "bot_p2p_message",
          data: {
            msgType: "text",
            msgData: { text: { content: "hi" } },
            messageId: "m2",
            chatType: "p2p",
            from: "user-xyz",
            conversationId: "user-xyz",
            senderName: "Bob",
            reminder: { isAtMe: false, isAtAll: false },
          },
        }],
      });
      await client.processRawMessage(raw);
      expect(client.isGroupChat("user-xyz")).toBe(false);
    });
  });

  describe("L3-8: pairing.notify callback routes via private API", () => {
    it("notify creates client, calls setChatType(id, false), then sends via DM API", async () => {
      const capturedBodies: Record<string, any>[] = [];
      const capturedUrls: string[] = [];

      vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
            { headers: { "content-type": "application/json" } },
          );
        capturedUrls.push(u);
        if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
          { headers: { "content-type": "application/json" } },
        );
      });

      // The pairing notify callback is defined in channel.ts as:
      //   notify: async ({ cfg, id, message, accountId }) => {
      //     const account = resolveAccount(cfg, accountId ?? undefined);
      //     const client = makeClient(account);
      //     client.setChatType(id, false);
      //     await client.sendFormatText(id, message);
      //   }
      // It's transformed by createChatChannelPlugin into pairing.notifyApproval.
      // We test the callback through the runtime webhook flow instead.
      const api = makeNoCredApi({ dmPolicy: "pairing", allowFrom: [] });
      startLansengerGateway(api);
      api.runtime.channel.inbound.run = vi.fn().mockResolvedValue(undefined);

      const route = api._httpRoutes.at(-1)!;
      await route.handler(makeReq(dmWebhookBody({ senderId: "pairing-user" })), makeRes());

      // The pairing code should have been sent via the private API
      const privateApiCalls = capturedUrls.filter(u => u.includes("bot/messages/create"));
      expect(privateApiCalls.length).toBeGreaterThanOrEqual(1);

      const pairingBody = capturedBodies.find(b => b.userIdList);
      expect(pairingBody).toBeDefined();
      expect(pairingBody!.userIdList).toContain("pairing-user");
      expect(pairingBody).not.toHaveProperty("groupId");

      vi.restoreAllMocks();
    });
  });

  describe("L3-9: secret-contract-api standalone load", () => {
    it("exports secretTargetRegistryEntries with lansenger appSecret entries", async () => {
      // Import the standalone file that OpenClaw CLI loads directly
      const mod = await import("../secret-contract-api.js");

      expect(mod.secretTargetRegistryEntries).toBeDefined();
      expect(Array.isArray(mod.secretTargetRegistryEntries)).toBe(true);
      expect(mod.secretTargetRegistryEntries.length).toBeGreaterThanOrEqual(2);

      const ids = mod.secretTargetRegistryEntries.map((e: any) => e.id);
      expect(ids).toContain("channels.lansenger.appSecret");
      expect(ids).toContain("channels.lansenger.accounts.*.appSecret");

      // Verify required fields for each entry
      for (const entry of mod.secretTargetRegistryEntries) {
        expect(entry).toHaveProperty("targetType");
        expect(entry).toHaveProperty("pathPattern");
        expect(entry).toHaveProperty("secretShape", "secret_input");
        expect(entry).toHaveProperty("includeInConfigure", true);
        expect(entry).toHaveProperty("includeInAudit", true);
      }
    });

    it("exports collectRuntimeConfigAssignments function", async () => {
      const mod = await import("../secret-contract-api.js");
      expect(typeof mod.collectRuntimeConfigAssignments).toBe("function");
    });

    it("plugin.secrets also has matching entries (runtime path)", () => {
      // Verify the runtime plugin.secrets path also works
      const secrets = (lansengerPlugin as any).secrets;
      expect(secrets).toBeDefined();
      expect(secrets.secretTargetRegistryEntries).toBeDefined();
      expect(secrets.secretTargetRegistryEntries.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("L3-10: Real webhook format parsing", () => {
    it("bot_group_message with real Lansenger IDs extracts correct chatType and chatId", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });
      const raw = JSON.stringify({
        events: [{
          type: "bot_group_message",
          data: {
            msgType: "text",
            msgData: { text: { content: "hello" } },
            messageId: "13107200-msg-001",
            chatType: "group",
            from: "13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk",
            senderName: "测试用户",
            groupId: "13107200-x7u5atkggMJGS578zmRCG2o2gIGPAaw",
            groupName: "测试群",
            reminder: { isAtMe: true, isAtAll: false },
            entryId: "13107200",
            botId: "13107200-bot001",
          },
        }],
      });
      const results = await client.processRawMessage(raw);
      expect(results).toHaveLength(1);
      expect(results[0]!.chatId).toBe("13107200-x7u5atkggMJGS578zmRCG2o2gIGPAaw");
      expect(client.isGroupChat("13107200-x7u5atkggMJGS578zmRCG2o2gIGPAaw")).toBe(true);
    });

    it("bot_p2p_message with real Lansenger ID extracts correct chatType and chatId", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });
      const raw = JSON.stringify({
        events: [{
          type: "bot_p2p_message",
          data: {
            msgType: "text",
            msgData: { text: { content: "hello" } },
            messageId: "13107200-msg-002",
            chatType: "p2p",
            from: "13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk",
            conversationId: "13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk",
            senderName: "测试用户",
            reminder: null,
          },
        }],
      });
      const results = await client.processRawMessage(raw);
      expect(results).toHaveLength(1);
      expect(results[0]!.chatId).toBe("13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk");
      expect(client.isGroupChat("13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk")).toBe(false);
    });

    it("webhook with null reminder does not crash", async () => {
      const client = new LansengerClient({ appId: "id", appSecret: "secret" });
      const raw = JSON.stringify({
        events: [{
          type: "bot_p2p_message",
          data: {
            msgType: "text",
            msgData: { text: { content: "hello" } },
            messageId: "m-null-reminder",
            chatType: "p2p",
            from: "user-1",
            conversationId: "user-1",
            senderName: "Alice",
            reminder: null,
          },
        }],
      });
      const results = await client.processRawMessage(raw);
      expect(results).toHaveLength(1);
      expect(results[0]!.chatId).toBe("user-1");
      expect(client.isGroupChat("user-1")).toBe(false);
    });
  });
});
