import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getLastInboundChatId, getLastInboundTime, getRunningClient, getRunningAccount, startLansengerGateway, mergeInboundEvents } from "./runtime.js";
import { LansengerClient } from "./client.js";
import type { InboundEvent } from "./client.js";

function makeApi(overrides?: Record<string, any>): any {
  const methods: Record<string, any> = {};
  const httpRoutes: any[] = [];
  const hookHandlers: Record<string, any> = {};
  const api = {
    config: overrides?.config ?? { channels: { lansenger: { appId: "test-app", appSecret: "test-secret" } } },
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
        turn: {
          run: async () => {},
        },
        inbound: {
          run: async () => {},
        },
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
  return api;
}

function makeOpts(params?: Record<string, any>): any {
  let responded = false;
  let response: any = null;
  return {
    params: params ?? {},
    respond: (success: boolean, data?: any, error?: any) => {
      responded = true;
      response = { success, data, error };
    },
    _responded: () => responded,
    _response: () => response,
  };
}

describe("getLastInboundChatId", () => {
  it("returns empty string when no inbound recorded", () => {
    expect(getLastInboundChatId()).toBe("");
  });
});

describe("getLastInboundTime", () => {
  it("returns null when no inbound recorded", () => {
    expect(getLastInboundTime()).toBeNull();
  });
});

describe("getRunningClient", () => {
  it("returns null when no account running", () => {
    expect(getRunningClient()).toBeNull();
  });
});

describe("getRunningAccount", () => {
  it("returns null when no account running", () => {
    expect(getRunningAccount()).toBeNull();
  });
});

describe("startLansengerGateway", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      if (u.includes("ws/endpoint")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { url: "wss://fake.ws" } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("registers gateway methods and HTTP route", () => {
    const api = makeApi();
    startLansengerGateway(api);
    expect(api._methods["lansenger.start"]).toBeDefined();
    expect(api._methods["lansenger.stop"]).toBeDefined();
    expect(api._methods["lansenger.status"]).toBeDefined();
    expect(api._methods["lansenger.sendCard"]).toBeDefined();
    expect(api._methods["lansenger.updateCard"]).toBeDefined();
    expect(api._httpRoutes.length).toBe(1);
    expect(api._httpRoutes[0].path).toBe("/lansenger/webhook");
  });

  it("sets globalThis.__lansenger_channel", () => {
    const api = makeApi();
    startLansengerGateway(api);
    const g = (globalThis as any).__lansenger_channel;
    expect(g).toBeDefined();
    expect(g.getRunningClient).toBeDefined();
    expect(g.getRunningAccount).toBeDefined();
    expect(g.getLastInboundChatId).toBeDefined();
  });

  it("registers message_sending and reply_payload_sending hooks", () => {
    const api = makeApi();
    startLansengerGateway(api);
    expect(api._hookHandlers["message_sending"]).toBeDefined();
    expect(api._hookHandlers["reply_payload_sending"]).toBeDefined();
  });

  it("reply_payload_sending hook returns void for lansenger channel", () => {
    const api = makeApi();
    startLansengerGateway(api);
    const handler = api._hookHandlers["reply_payload_sending"];
    const event = { payload: { text: "test" }, kind: "final", channel: "lansenger" };
    const ctx = { channelId: "lansenger", sessionKey: "agent:main:lansenger:dm:user1" };
    const result = handler(event, ctx);
    expect(result).toBeUndefined();
  });

  describe("lansenger.sendCard", () => {
    it("responds error when chatId missing", async () => {
      const api = makeApi();
      startLansengerGateway(api);
      const opts = makeOpts({ chatId: undefined, command: "rm -rf" });
      await api._methods["lansenger.sendCard"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(false);
      expect(opts._response().error?.message).toContain("chatId required");
    });

    it("responds error when gateway not running", async () => {
      const api = makeApi({ config: { channels: { lansenger: { appId: "a", appSecret: "s" } } } });
      startLansengerGateway(api);
      const opts = makeOpts({ chatId: "user1", command: "rm" });
      await api._methods["lansenger.sendCard"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(false);
      expect(opts._response().error?.message).toContain("not running");
    });
  });

  describe("lansenger.updateCard", () => {
    it("responds error when messageId or status missing", async () => {
      const api = makeApi();
      startLansengerGateway(api);
      const opts = makeOpts({ messageId: undefined, status: undefined });
      await api._methods["lansenger.updateCard"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(false);
      expect(opts._response().error?.message).toContain("messageId and status required");
    });

    it("responds error for invalid status", async () => {
      const api = makeApi({ config: { channels: { lansenger: { appId: "test-app", appSecret: "test-secret" } } } });
      startLansengerGateway(api);
      const opts = makeOpts({ messageId: "m1", status: "unknown_status" });
      await api._methods["lansenger.updateCard"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(false);
      expect(opts._response().error?.message).toContain("not running");
    });
  });

  describe("lansenger.start", () => {
    it("responds error when account not enabled", async () => {
      const api = makeApi({ config: { channels: { lansenger: {} } } });
      startLansengerGateway(api);
      const opts = makeOpts({ accountId: undefined });
      await api._methods["lansenger.start"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(false);
    });
  });

  describe("lansenger.stop", () => {
    it("responds error when not running", async () => {
      const api = makeApi();
      startLansengerGateway(api);
      const opts = makeOpts({ accountId: undefined });
      await api._methods["lansenger.stop"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(false);
      expect(opts._response().error?.message).toContain("not running");
    });
  });

  describe("lansenger.status", () => {
    it("responds with no running accounts initially", async () => {
      const api = makeApi();
      startLansengerGateway(api);
      const opts = makeOpts();
      await api._methods["lansenger.status"](opts);
      expect(opts._responded()).toBe(true);
      expect(opts._response().success).toBe(true);
      expect(opts._response().data.running).toBe(false);
      expect(opts._response().data.accounts).toEqual([]);
    });
  });

  describe("/lansenger/webhook", () => {
    it("GET returns endpoint string", async () => {
      const api = makeApi();
      startLansengerGateway(api);
      const route = api._httpRoutes[0];
      const res = { statusCode: 0, end: vi.fn() } as any;
      const result = await route.handler({ method: "GET" } as any, res);
      expect(result).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.end).toHaveBeenCalledWith("lansenger webhook endpoint");
    });
  });
});

describe("mergeInboundEvents", () => {
  const makeEvent = (idx: number, text: string, overrides?: Partial<InboundEvent>): InboundEvent => ({
    messageId: `msg-${idx}`,
    text,
    chatId: "chat-1",
    chatName: "Test Chat",
    isGroup: false,
    senderId: "user-1",
    userName: "Test User",
    rawMessage: { idx },
    msgType: "text",
    mediaPaths: overrides?.mediaPaths,
    eventType: overrides?.eventType,
    referenceMsg: overrides?.referenceMsg,
    isAtMe: overrides?.isAtMe,
    isAtAll: overrides?.isAtAll,
    fromType: overrides?.fromType,
    groupName: overrides?.groupName,
    botCreator: overrides?.botCreator,
    botId: overrides?.botId,
  });

  it("throws on empty array", () => {
    expect(() => mergeInboundEvents([])).toThrow("mergeInboundEvents: events array is empty");
  });

  it("returns single event unchanged", () => {
    const event = makeEvent(1, "hello");
    const result = mergeInboundEvents([event]);
    expect(result).toEqual(event);
  });

  it("merges text with newlines", () => {
    const e1 = makeEvent(1, "第一条");
    const e2 = makeEvent(2, "第二条");
    const e3 = makeEvent(3, "第三条");
    const result = mergeInboundEvents([e1, e2, e3]);
    expect(result.text).toBe("第一条\n第二条\n第三条");
    expect(result.messageId).toBe("msg-3");
    expect(result.chatId).toBe("chat-1");
    expect(result.senderId).toBe("user-1");
  });

  it("merges mediaPaths", () => {
    const e1 = makeEvent(1, "看这个", { mediaPaths: ["/tmp/img1.jpg"] });
    const e2 = makeEvent(2, "还有这个", { mediaPaths: ["/tmp/img2.png", "/tmp/doc.pdf"] });
    const result = mergeInboundEvents([e1, e2]);
    expect(result.mediaPaths).toEqual(["/tmp/img1.jpg", "/tmp/img2.png", "/tmp/doc.pdf"]);
  });

  it("uses last event metadata", () => {
    const e1 = makeEvent(1, "hi");
    const e2 = makeEvent(2, "there");
    const result = mergeInboundEvents([e1, e2]);
    expect(result.messageId).toBe("msg-2");
    expect(result.msgType).toBe("text");
    expect(result.userName).toBe("Test User");
  });

  it("preserves rawMessage structure with mergedFrom", () => {
    const e1 = makeEvent(1, "a");
    const e2 = makeEvent(2, "b");
    const result = mergeInboundEvents([e1, e2]);
    expect(result.rawMessage.mergedFrom).toEqual(["msg-1", "msg-2"]);
    expect(result.rawMessage.events).toEqual([{ idx: 1 }, { idx: 2 }]);
    expect(result.rawMessage.lastRawMessage).toEqual({ idx: 2 });
  });

  it("mediaPaths is undefined when no events have media", () => {
    const e1 = makeEvent(1, "hello");
    const e2 = makeEvent(2, "world");
    const result = mergeInboundEvents([e1, e2]);
    expect(result.mediaPaths).toBeUndefined();
  });

  it("preserves referenceMsg from last event", () => {
    const ref = { from: "user-2", senderName: "Bob", msgType: "text", msgData: { text: { content: "Original" } } };
    const e1 = makeEvent(1, "replying");
    const e2 = makeEvent(2, "to this", { referenceMsg: ref });
    const result = mergeInboundEvents([e1, e2]);
    expect(result.referenceMsg).toEqual(ref);
  });

  it("preserves metadata fields from last event", () => {
    const e1 = makeEvent(1, "hi");
    const e2 = makeEvent(2, "there", { isAtMe: true, isAtAll: false, fromType: 1, groupName: "Team", eventType: "bot_group_message" });
    const result = mergeInboundEvents([e1, e2]);
    expect(result.isAtMe).toBe(true);
    expect(result.isAtAll).toBe(false);
    expect(result.fromType).toBe(1);
    expect(result.groupName).toBe("Team");
    expect(result.eventType).toBe("bot_group_message");
  });
});

// ---------------------------------------------------------------------------
// handleInbound policy tests (exercised via the webhook route registered by
// startLansengerGateway)
// ---------------------------------------------------------------------------

describe("handleInbound policies (via webhook)", () => {
  // Helpers

  function dmWebhookBody(overrides?: {
    senderId?: string;
    text?: string;
    messageId?: string;
    isAtMe?: boolean;
    isAtAll?: boolean;
    botId?: string;
    mentionedBots?: Array<{ botId: string; botName: string }>;
  }) {
    return {
      events: [{
        type: "bot_p2p_message",
        data: {
          msgType: "text",
          msgData: { text: { content: overrides?.text ?? "hello" } },
          messageId: overrides?.messageId ?? "msg-dm-1",
          chatType: "p2p",
          from: overrides?.senderId ?? "user-1",
          senderName: "Alice",
          conversationId: overrides?.senderId ?? "user-1",
          reminder: {
            isAtMe: overrides?.isAtMe ?? false,
            isAtAll: overrides?.isAtAll ?? false,
            ...(overrides?.mentionedBots ? { bots: overrides.mentionedBots } : {}),
          },
          ...(overrides?.botId ? { botId: overrides.botId } : {}),
        },
      }],
    };
  }

  function groupWebhookBody(overrides?: {
    senderId?: string;
    text?: string;
    groupId?: string;
    groupName?: string;
    messageId?: string;
    isAtMe?: boolean;
    isAtAll?: boolean;
    botId?: string;
    mentionedBots?: Array<{ botId: string; botName: string }>;
  }) {
    return {
      events: [{
        type: "bot_group_message",
        data: {
          msgType: "text",
          msgData: { text: { content: overrides?.text ?? "hello" } },
          messageId: overrides?.messageId ?? "msg-group-1",
          chatType: "group",
          from: overrides?.senderId ?? "user-1",
          senderName: "Alice",
          groupId: overrides?.groupId ?? "group:group-1",
          groupName: overrides?.groupName ?? "Test Group",
          reminder: {
            isAtMe: overrides?.isAtMe ?? false,
            isAtAll: overrides?.isAtAll ?? false,
            ...(overrides?.mentionedBots ? { bots: overrides.mentionedBots } : {}),
          },
          ...(overrides?.botId ? { botId: overrides.botId } : {}),
        },
      }],
    };
  }

  function makeReq(body: any): any {
    const json = Buffer.from(JSON.stringify(body));
    return {
      method: "POST",
      [Symbol.asyncIterator]: async function* () {
        yield json;
      },
    };
  }

  function makeRes(): any {
    return { statusCode: 0, end: vi.fn() };
  }

  /**
   * Create an api with NO credentials (appId="", appSecret="") so that
   * autoStart does NOT actually connect.  Policy fields can be overridden
   * via channelOverrides.
   */
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

  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
          { headers: { "content-type": "application/json" } },
        );
      if (u.includes("ws/endpoint"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { url: "wss://fake.ws" } }),
          { headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
        { headers: { "content-type": "application/json" } },
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================================
  // 1. DM Policy
  // =====================================================================
  describe("DM Policy", () => {
    it("disabled → inbound.run not called", async () => {
      api = makeNoCredApi({ dmPolicy: "disabled" });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody()), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("open → inbound.run called", async () => {
      api = makeNoCredApi({ dmPolicy: "open" });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: sender in allowFrom → inbound.run called", async () => {
      api = makeNoCredApi({ dmPolicy: "allowlist", allowFrom: ["user-1", "user-3"] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: sender NOT in allowFrom → inbound.run not called", async () => {
      api = makeNoCredApi({ dmPolicy: "allowlist", allowFrom: ["user-2"] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("pairing: paired (sender in allowFrom) → inbound.run called", async () => {
      api = makeNoCredApi({ dmPolicy: "pairing", allowFrom: ["user-1"] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("pairing: not paired → inbound.run not called", async () => {
      api = makeNoCredApi({ dmPolicy: "pairing", allowFrom: [] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // 2. Group Policy
  // =====================================================================
  describe("Group Policy", () => {
    it("disabled → inbound.run not called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      // resolveGroupPolicy says not allowed → messages from this group dropped
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: false });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("open → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: group allowed → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: group NOT in list → inbound.run not called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: false });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("groupConfig enabled=false → inbound.run not called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi
        .fn()
        .mockReturnValue({ allowed: true, groupConfig: { enabled: false } });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("per-group allowFrom matching → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi
        .fn()
        .mockReturnValue({ allowed: true, groupConfig: { allowFrom: ["user-1"] } });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("per-group allowFrom not matching → inbound.run not called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi
        .fn()
        .mockReturnValue({ allowed: true, groupConfig: { allowFrom: ["user-2"] } });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // 3. requireMention
  // =====================================================================
  describe("requireMention", () => {
    it("requireMention=true, isAtMe=true, isAtAll=false → dispatched", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody({ isAtMe: true })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("requireMention=true, isAtMe=false, isAtAll=false → not dispatched", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: false })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("requireMention=true, isAtMe=false, isAtAll=true → dispatched", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: true })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("requireMention=false → dispatched without @", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: false })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });
  });

  // =====================================================================
  // 4. textForCommands stripping
  // =====================================================================
  describe("textForCommands stripping", () => {
    it("@botName is stripped from textForCommands (group, isAtMe)", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(
        makeReq(
          groupWebhookBody({
            text: "/help@MyBot hello",
            isAtMe: true,
            botId: "bot-123",
            mentionedBots: [{ botId: "bot-123", botName: "MyBot" }],
          }),
        ),
        makeRes(),
      );

      expect(inboundRun).toHaveBeenCalledTimes(1);
      const params = inboundRun.mock.calls[0]![0] as any;
      const ingest = params.adapter.ingest();
      expect(ingest.textForCommands).toBe("/help hello");
      // rawText and textForAgent preserve the original text (with @botName)
      expect(ingest.rawText).toBe("/help@MyBot hello");
      expect(ingest.textForAgent).toContain("/help@MyBot hello");
    });

    it("textForCommands unchanged for private messages", async () => {
      api = makeNoCredApi({ dmPolicy: "open" });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes[0];
      await route.handler(
        makeReq(dmWebhookBody({ text: "/help@MyBot" })),
        makeRes(),
      );

      expect(inboundRun).toHaveBeenCalledTimes(1);
      const params = inboundRun.mock.calls[0]![0] as any;
      const ingest = params.adapter.ingest();
      expect(ingest.textForCommands).toBe("/help@MyBot");
    });
  });

  // =====================================================================
  // 5. autoMentionReply / autoQuoteReply
  // =====================================================================
  describe("autoMentionReply / autoQuoteReply", () => {
    /**
     * For these tests we need handleInbound to actually reach the delivery
     * callback.  We override inbound.run to invoke the delivery callback,
     * and we spy on fetch to check what sendFormatText passes as opts.
     */
    it("autoMentionReply passes reminder to delivery", async () => {
      api = makeNoCredApi({
        dmPolicy: "open",
        autoMentionReply: true,
      });
      startLansengerGateway(api);

      // Override inbound.run to invoke the delivery callback
      const fetchCalls: Array<{ url: string; body: any }> = [];
      const inboundRun = vi.fn().mockImplementation(async (params: any) => {
        const turn = params.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Hello from bot", to: "user-1" },
          { kind: "final" },
        );
      });
      api.runtime.channel.inbound.run = inboundRun;

      vi.stubGlobal("fetch", async (url: string | Request, init?: any) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
            { headers: { "content-type": "application/json" } },
          );
        if (u.includes("bot/messages/create") || u.includes("messages/group/create")) {
          const body = init?.body ? JSON.parse(init.body.toString()) : {};
          fetchCalls.push({ url: u, body });
        }
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
          { headers: { "content-type": "application/json" } },
        );
      });

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);

      // The delivery should have sent a formatText (or text) message
      const deliveryCalls = fetchCalls.filter(
        (c) =>
          c.body.msgType === "formatText" || c.body.msgType === "text",
      );
      expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);

      // Check that reminder is present in the first delivery call
      const firstDelivery = deliveryCalls[0]!;
      const msgData =
        firstDelivery.body.msgData?.formatText ??
        firstDelivery.body.msgData?.text;
      expect(msgData?.reminder).toBeDefined();
      expect(msgData.reminder).toEqual({ userIds: ["user-1"] });
    });

    it("autoQuoteReply passes refMsgId to delivery", async () => {
      api = makeNoCredApi({
        dmPolicy: "open",
        autoQuoteReply: true,
      });
      startLansengerGateway(api);

      const fetchCalls: Array<{ url: string; body: any }> = [];
      const inboundRun = vi.fn().mockImplementation(async (params: any) => {
        const turn = params.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Reply text", to: "user-1" },
          { kind: "final" },
        );
      });
      api.runtime.channel.inbound.run = inboundRun;

      vi.stubGlobal("fetch", async (url: string | Request, init?: any) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
            { headers: { "content-type": "application/json" } },
          );
        if (u.includes("bot/messages/create") || u.includes("messages/group/create")) {
          const body = init?.body ? JSON.parse(init.body.toString()) : {};
          fetchCalls.push({ url: u, body });
        }
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
          { headers: { "content-type": "application/json" } },
        );
      });

      const route = api._httpRoutes[0];
      await route.handler(
        makeReq(dmWebhookBody({ senderId: "user-1", messageId: "dm-msg-abc" })),
        makeRes(),
      );

      const deliveryCalls = fetchCalls.filter(
        (c) =>
          c.body.msgType === "formatText" || c.body.msgType === "text",
      );
      expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);

      // The payload should carry refMsgId
      expect(deliveryCalls[0]!.body.refMsgId).toBe("dm-msg-abc");
    });

    it("autoMentionReply and autoQuoteReply both disabled → no reminder or refMsgId", async () => {
      api = makeNoCredApi({
        dmPolicy: "open",
        autoMentionReply: false,
        autoQuoteReply: false,
      });
      startLansengerGateway(api);

      const fetchCalls: Array<{ url: string; body: any }> = [];
      const inboundRun = vi.fn().mockImplementation(async (params: any) => {
        const turn = params.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Reply", to: "user-1" },
          { kind: "final" },
        );
      });
      api.runtime.channel.inbound.run = inboundRun;

      vi.stubGlobal("fetch", async (url: string | Request, init?: any) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
            { headers: { "content-type": "application/json" } },
          );
        if (u.includes("bot/messages/create") || u.includes("messages/group/create")) {
          const body = init?.body ? JSON.parse(init.body.toString()) : {};
          fetchCalls.push({ url: u, body });
        }
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
          { headers: { "content-type": "application/json" } },
        );
      });

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      const deliveryCalls = fetchCalls.filter(
        (c) =>
          c.body.msgType === "formatText" || c.body.msgType === "text",
      );
      expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);

      const msgData =
        deliveryCalls[0]!.body.msgData?.formatText ??
        deliveryCalls[0]!.body.msgData?.text;
      expect(msgData?.reminder).toBeUndefined();
      expect(deliveryCalls[0]!.body.refMsgId).toBeUndefined();
    });
  });

  // =====================================================================
  // 6. deliverReply formatText → text fallback
  // =====================================================================
  describe("deliverReply", () => {
    it("formatText succeeds → returns success", async () => {
      api = makeNoCredApi({ dmPolicy: "open" });
      startLansengerGateway(api);

      let deliveryResult: any = null;
      const inboundRun = vi.fn().mockImplementation(async (params: any) => {
        const turn = params.adapter.resolveTurn();
        deliveryResult = await turn.delivery.deliver(
          { text: "deliverReply formatText success", to: "user-1" },
          { kind: "final" },
        );
      });
      api.runtime.channel.inbound.run = inboundRun;

      // Default mock: all messages succeed
      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(deliveryResult).toBeDefined();
      expect(deliveryResult.messageIds).toContain("m1");
      expect(deliveryResult.visibleReplySent).toBe(true);
    });

    it("formatText fails → falls back to text", async () => {
      api = makeNoCredApi({ dmPolicy: "open" });
      startLansengerGateway(api);

      let deliveryResult: any = null;
      const inboundRun = vi.fn().mockImplementation(async (params: any) => {
        const turn = params.adapter.resolveTurn();
        deliveryResult = await turn.delivery.deliver(
          { text: "Hello fallback", to: "user-1" },
          { kind: "final" },
        );
      });
      api.runtime.channel.inbound.run = inboundRun;

      // Make formatText fail, text succeed
      vi.stubGlobal("fetch", async (url: string | Request, init?: any) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.includes("apptoken"))
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
            { headers: { "content-type": "application/json" } },
          );
        if (u.includes("bot/messages/create") || u.includes("messages/group/create")) {
          const body = init?.body ? JSON.parse(init.body.toString()) : {};
          if (body.msgType === "formatText") {
            return new Response(
              JSON.stringify({ errCode: 1, errMsg: "format not supported" }),
              { headers: { "content-type": "application/json" } },
            );
          }
          // text succeeds
          return new Response(
            JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "fallback-msg" } }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
          { headers: { "content-type": "application/json" } },
        );
      });

      const route = api._httpRoutes[0];
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(deliveryResult).toBeDefined();
      // Falls back to text, gets "fallback-msg"
      expect(deliveryResult.messageIds).toContain("fallback-msg");
      expect(deliveryResult.visibleReplySent).toBe(true);
    });
  });
});