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
      const route = api._httpRoutes.at(-1)!
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

// Shared helpers (module scope so all describe blocks can use them)

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

function makeReqWithAccount(body: any, accountId?: string): any {
  const json = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    url: accountId ? `/lansenger/webhook?accountId=${accountId}` : "/lansenger/webhook",
    [Symbol.asyncIterator]: async function* () {
      yield json;
    },
  };
}

function makeRes(): any {
  return { statusCode: 0, end: vi.fn() };
}

describe("handleInbound policies (via webhook)", () => {

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

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody()), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("open → inbound.run called", async () => {
      api = makeNoCredApi({ dmPolicy: "open" });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: sender in allowFrom → inbound.run called", async () => {
      api = makeNoCredApi({ dmPolicy: "allowlist", allowFrom: ["user-1", "user-3"] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: sender NOT in allowFrom → inbound.run not called", async () => {
      api = makeNoCredApi({ dmPolicy: "allowlist", allowFrom: ["user-2"] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("pairing: paired (sender in allowFrom) → inbound.run called", async () => {
      api = makeNoCredApi({ dmPolicy: "pairing", allowFrom: ["user-1"] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("pairing: not paired → inbound.run not called", async () => {
      api = makeNoCredApi({ dmPolicy: "pairing", allowFrom: [] });
      startLansengerGateway(api);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // 2. Group Policy
  // =====================================================================
  describe("Group Policy", () => {
    it("disabled → inbound.run not called", async () => {
      api = makeNoCredApi({ groupPolicy: "disabled" });
      startLansengerGateway(api);
      // resolveGroupPolicy says not allowed → messages from this group dropped
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: false });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("open → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: group allowed → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("allowlist: group NOT in list → inbound.run not called", async () => {
      api = makeNoCredApi({ groupPolicy: "allowlist" });
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: false });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("groupConfig enabled=true → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi
        .fn()
        .mockReturnValue({ allowed: true, groupConfig: { enabled: true } });
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody()), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("account groupAllowFrom contains sender → inbound.run called", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      // Set groupAllowFrom at account level via config
      // makeNoCredApi uses section config which resolveAccount treats as account in single-account mode
      const cfg = {
        channels: {
          lansenger: {
            appId: "test-app",
            appSecret: "test-secret",
            groupAllowFrom: ["sender-1"],
          },
        },
      };
      const api2 = makeApi({ config: cfg });
      startLansengerGateway(api2);
      api2.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api2.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun2 = vi.fn().mockResolvedValue(undefined);
      api2.runtime.channel.inbound.run = inboundRun2;

      const route2 = api2._httpRoutes.at(-1)!
      await route2.handler(makeReq(groupWebhookBody({ senderId: "sender-1" })), makeRes());

      expect(inboundRun2).toHaveBeenCalledTimes(1);
    });

    it("account groupAllowFrom does NOT contain sender → inbound.run not called", async () => {
      const cfg = {
        channels: {
          lansenger: {
            appId: "test-app",
            appSecret: "test-secret",
            groupAllowFrom: ["other-user"],
          },
        },
      };
      const api2 = makeApi({ config: cfg });
      startLansengerGateway(api2);
      api2.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api2.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun2 = vi.fn().mockResolvedValue(undefined);
      api2.runtime.channel.inbound.run = inboundRun2;

      const route2 = api2._httpRoutes.at(-1)!
      await route2.handler(makeReq(groupWebhookBody({ senderId: "sender-1" })), makeRes());

      expect(inboundRun2).not.toHaveBeenCalled();
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

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: false })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("requireMention=true, isAtMe=false, isAtAll=true → NOT dispatched (atAll should not trigger)", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: true })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("requireMention=false → dispatched without @", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: false })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("requireMention=false, isAtMe=true → dispatched (@bot still works)", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: true, isAtAll: false })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("requireMention=false, isAtAll=true → dispatched (mention check skipped)", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: true })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });
  });

  // =====================================================================
  // 4. respondToAtAll
  // =====================================================================
  describe("respondToAtAll", () => {
    it("respondToAtAll=false (default), @all → not dispatched", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: true })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });

    it("respondToAtAll=true, @all → dispatched", async () => {
      api = makeNoCredApi({ respondToAtAll: true });
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: true })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("respondToAtAll=true, @bot → dispatched", async () => {
      api = makeNoCredApi({ respondToAtAll: true });
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: true, isAtAll: false })), makeRes());

      expect(inboundRun).toHaveBeenCalledTimes(1);
    });

    it("respondToAtAll=true, no @ → not dispatched", async () => {
      api = makeNoCredApi({ respondToAtAll: true });
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(true);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(groupWebhookBody({ isAtMe: false, isAtAll: false })), makeRes());

      expect(inboundRun).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // 5. textForCommands stripping
  // =====================================================================
  describe("textForCommands stripping", () => {
    it("@botName is stripped from textForCommands (group, isAtMe)", async () => {
      api = makeNoCredApi();
      startLansengerGateway(api);
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
      api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
      const inboundRun = vi.fn().mockResolvedValue(undefined);
      api.runtime.channel.inbound.run = inboundRun;

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
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
      const route = api._httpRoutes.at(-1)!
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

      const route = api._httpRoutes.at(-1)!
      await route.handler(makeReq(dmWebhookBody({ senderId: "user-1" })), makeRes());

      expect(deliveryResult).toBeDefined();
      // Falls back to text, gets "fallback-msg"
      expect(deliveryResult.messageIds).toContain("fallback-msg");
      expect(deliveryResult.visibleReplySent).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Group message: three-level config priority
//   autoMentionReply / autoQuoteReply:  group > account > section
//   requireMention:                     account > section (group via SDK)
//   groupAllowFrom:                     group > account > section
//   groupPolicy:                        account > section
describe("Group autoMentionReply three-level priority", () => {
  let api: any;
  let fetchCalls: Array<{ url: string; body: any }>;

  beforeEach(() => {
    fetchCalls = [];
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  let mentionSessionKeyCounter = 0;

  function setupGroupDelivery(apiOverride: any, resolveGroupPolicyOverride?: () => any) {
    api = apiOverride;
    startLansengerGateway(api);

    const uniqueSessKey = `sess-mention-${++mentionSessionKeyCounter}`;
    if (resolveGroupPolicyOverride) {
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockImplementation(resolveGroupPolicyOverride);
    } else {
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
    }
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    api.runtime.channel.routing.resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "agent-1",
      sessionKey: uniqueSessKey,
      matchedBy: "default",
    });

    const inboundRun = vi.fn().mockImplementation(async (params: any) => {
      const turn = params.adapter.resolveTurn();
      await turn.delivery.deliver(
        { text: "Reply from bot", to: "group:group-1" },
        { kind: "final" },
      );
    });
    api.runtime.channel.inbound.run = inboundRun;
  }

  function getDeliveryReminder(): any {
    const deliveryCalls = fetchCalls.filter(
      (c) => c.body.msgType === "formatText" || c.body.msgType === "text",
    );
    if (deliveryCalls.length === 0) return undefined;
    const msgData = deliveryCalls[0]!.body.msgData?.formatText ?? deliveryCalls[0]!.body.msgData?.text;
    return msgData?.reminder;
  }

  // B4: neither section nor account set → default false, no reminder
  it("B4: defaults to false (no reminder) when nothing configured", async () => {
    setupGroupDelivery(makeNoCredApi());
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());
    expect(getDeliveryReminder()).toBeUndefined();
  });

  // B2: account autoMentionReply=false, groupConfig autoMentionReply=true → should mention
  it("B2: account=false, group=true → reminder present", async () => {
    setupGroupDelivery(
      makeNoCredApi({ autoMentionReply: false }),
      () => ({ allowed: true, groupConfig: { autoMentionReply: true } }),
    );
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());
    expect(getDeliveryReminder()).toEqual({ userIds: ["user-1"] });
  });

  // B3: section autoMentionReply=true, groupConfig autoMentionReply=false → no reminder
  it("B3: section=true, group=false → no reminder", async () => {
    setupGroupDelivery(
      makeNoCredApi({ autoMentionReply: true }),
      () => ({ allowed: true, groupConfig: { autoMentionReply: false } }),
    );
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());
    expect(getDeliveryReminder()).toBeUndefined();
  });

  // Section-level autoMentionReply=true (single account mode) → reminder present
  it("section autoMentionReply=true → reminder present", async () => {
    setupGroupDelivery(makeNoCredApi({ autoMentionReply: true }));
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1" })), makeRes());
    expect(getDeliveryReminder()).toEqual({ userIds: ["user-1"] });
  });
});

describe("Group autoQuoteReply three-level priority", () => {
  let api: any;
  let fetchCalls: Array<{ url: string; body: any }>;

  beforeEach(() => {
    fetchCalls = [];
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  let sessionKeyCounter = 0;

  function setupGroupDelivery(apiOverride: any, resolveGroupPolicyOverride?: () => any) {
    api = apiOverride;
    startLansengerGateway(api);

    const uniqueSessKey = `sess-autoQuote-${++sessionKeyCounter}`;
    if (resolveGroupPolicyOverride) {
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockImplementation(resolveGroupPolicyOverride);
    } else {
      api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
    }
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    api.runtime.channel.routing.resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "agent-1",
      sessionKey: uniqueSessKey,
      matchedBy: "default",
    });

    const inboundRun = vi.fn().mockImplementation(async (params: any) => {
      const turn = params.adapter.resolveTurn();
      await turn.delivery.deliver(
        { text: "AutoQuote reply", to: "group:group-1" },
        { kind: "final" },
      );
    });
    api.runtime.channel.inbound.run = inboundRun;
  }

  function getRefMsgId(): string | undefined {
    const deliveryCalls = fetchCalls.filter(
      (c) => c.body.msgType === "formatText" || c.body.msgType === "text",
    );
    return deliveryCalls[0]?.body.refMsgId;
  }

  it("autoQuoteReply=false everywhere → no refMsgId", async () => {
    setupGroupDelivery(makeNoCredApi({ autoQuoteReply: false }));
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1", messageId: "group-msg-1" })), makeRes());
    expect(getRefMsgId()).toBeUndefined();
  });

  it("section autoQuoteReply=true → refMsgId present", async () => {
    setupGroupDelivery(makeNoCredApi({ autoQuoteReply: true }));
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1", messageId: "group-msg-1" })), makeRes());
    // Verify delivery happened
    const deliveryCalls = fetchCalls.filter(
      (c) => c.body.msgType === "formatText" || c.body.msgType === "text",
    );
    expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);
    expect(deliveryCalls[0]!.body.refMsgId).toBe("group-msg-1");
  });

  it("groupConfig autoQuoteReply=false overrides section=true → no refMsgId", async () => {
    setupGroupDelivery(
      makeNoCredApi({ autoQuoteReply: true }),
      () => ({ allowed: true, groupConfig: { autoQuoteReply: false } }),
    );
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1", messageId: "group-msg-1" })), makeRes());
    const deliveryCalls = fetchCalls.filter(
      (c) => c.body.msgType === "formatText" || c.body.msgType === "text",
    );
    expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);
    expect(deliveryCalls[0]!.body.refMsgId).toBeUndefined();
  });

  it("groupConfig autoQuoteReply=true overrides account=false → refMsgId present", async () => {
    setupGroupDelivery(
      makeNoCredApi({ autoQuoteReply: false }),
      () => ({ allowed: true, groupConfig: { autoQuoteReply: true } }),
    );
    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody({ senderId: "user-1", messageId: "group-msg-1" })), makeRes());
    const deliveryCalls = fetchCalls.filter(
      (c) => c.body.msgType === "formatText" || c.body.msgType === "text",
    );
    expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);
    expect(deliveryCalls[0]!.body.refMsgId).toBe("group-msg-1");
  });
});

describe("Group requireMention three-level priority", () => {
  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
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

  function makeNoCredApi(channelOverrides?: Record<string, any>): any {
    return makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: [] as string[],
            ...(channelOverrides ?? {}),
          },
        },
      },
    });
  }

  // B5: section requireMention=true, account requireMention=false → no mention needed
  it("B5: section=true, account=false → dispatched without @", async () => {
    api = makeNoCredApi({
      requireMention: true,
      accounts: {
        "bot1": { appId: "", appSecret: "", requireMention: false },
      },
    });
    startLansengerGateway(api);

    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(
      makeReqWithAccount(groupWebhookBody({ isAtMe: false, isAtAll: false }), "bot1"),
      makeRes(),
    );

    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  // B6: account requireMention=true, group requireMention=false → dispatched without @
  it("B6: account=true, group=false → dispatched without @", async () => {
    api = makeNoCredApi({ requireMention: true });
    startLansengerGateway(api);

    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
    // group-level requireMention=false (via SDK resolveRequireMention)
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(
      makeReq(groupWebhookBody({ isAtMe: false, isAtAll: false })),
      makeRes(),
    );

    expect(inboundRun).toHaveBeenCalledTimes(1);
  });
});

describe("Group groupAllowFrom three-level priority", () => {
  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
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

  function makeNoCredApi(channelOverrides?: Record<string, any>): any {
    return makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: [] as string[],
            ...(channelOverrides ?? {}),
          },
        },
      },
    });
  }

  // B7: section groupAllowFrom has value, account groupAllowFrom has different value → account wins
  it("B7: section groupAllowFrom=[A], account groupAllowFrom=[B] → B used", async () => {
    api = makeNoCredApi({
      groupAllowFrom: ["section-user"],
      accounts: {
        "bot1": { appId: "", appSecret: "", groupAllowFrom: ["account-user"] },
      },
    });
    startLansengerGateway(api);

    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    // sender "account-user" is in accountGroupAllowFrom → allowed
    await route.handler(
      makeReqWithAccount(groupWebhookBody({ senderId: "account-user" }), "bot1"),
      makeRes(),
    );
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  // B8: account groupAllowFrom has value, per-group allowFrom has different value → group wins
  it("B8: account groupAllowFrom has value, per-group allowFrom=[C] → C used", async () => {
    api = makeNoCredApi({
      groupAllowFrom: ["section-user"],
      accounts: {
        "bot1": { appId: "", appSecret: "", groupAllowFrom: ["account-user"] },
      },
    });
    startLansengerGateway(api);

    // per-group allowFrom takes priority
    api.runtime.channel.groups.resolveGroupPolicy = vi
      .fn()
      .mockReturnValue({ allowed: true, groupConfig: { allowFrom: ["group-user"] } });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    // sender "account-user" NOT in group allowFrom → blocked
    await route.handler(
      makeReqWithAccount(groupWebhookBody({ senderId: "account-user" }), "bot1"),
      makeRes(),
    );
    expect(inboundRun).not.toHaveBeenCalled();
  });

  // B9: per-group allowFrom=[] (empty) → falls through to next level, allows everyone if all empty
  it("B9: per-group allowFrom=[] → falls through, allows when no other allowFrom", async () => {
    api = makeNoCredApi();
    startLansengerGateway(api);

    api.runtime.channel.groups.resolveGroupPolicy = vi
      .fn()
      .mockReturnValue({ allowed: true, groupConfig: { allowFrom: [] } });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    // empty per-group allowFrom + no account/channel groupAllowFrom → everyone allowed
    await route.handler(makeReq(groupWebhookBody({ senderId: "any-user" })), makeRes());
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });
});

describe("Group groupPolicy account-level override", () => {
  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
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

  function makeNoCredApi(channelOverrides?: Record<string, any>): any {
    return makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: [] as string[],
            ...(channelOverrides ?? {}),
          },
        },
      },
    });
  }

  // B10: section groupPolicy=open, account groupPolicy=disabled → blocked
  it("B10: section=open, account=disabled → blocked", async () => {
    api = makeNoCredApi({
      groupPolicy: "open",
      accounts: {
        "bot1": { appId: "", appSecret: "", groupPolicy: "disabled" },
      },
    });
    startLansengerGateway(api);

    // SDK resolveGroupPolicy returns not allowed
    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({
      allowed: false,
    });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(
      makeReqWithAccount(groupWebhookBody(), "bot1"),
      makeRes(),
    );

    // effectiveGroupPolicyMode = "disabled" (account wins), not "open"
    // SDK workaround: mode !== "open" → NOT pass through → blocked
    expect(inboundRun).not.toHaveBeenCalled();
  });

  // B11: section groupPolicy=disabled, account groupPolicy=open → allowed
  it("B11: section=disabled, account=open → allowed (SDK workaround)", async () => {
    api = makeNoCredApi({
      groupPolicy: "disabled",
      accounts: {
        "bot1": { appId: "", appSecret: "", groupPolicy: "open" },
      },
    });
    startLansengerGateway(api);

    // SDK resolveGroupPolicy returns not allowed (SDK bug scenario)
    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({
      allowed: false,
    });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(
      makeReqWithAccount(groupWebhookBody(), "bot1"),
      makeRes(),
    );

    // effectiveGroupPolicyMode = "open" (account wins over section disabled)
    // SDK workaround: mode === "open" && !groupConfig → pass through
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SDK Bug Workaround tests (runtime.ts#L924-L934)
// ---------------------------------------------------------------------------

describe("SDK Bug Workaround", () => {
  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
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

  function makeNoCredApi(channelOverrides?: Record<string, any>): any {
    return makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: [] as string[],
            ...(channelOverrides ?? {}),
          },
        },
      },
    });
  }

  // C1: groupPolicy=open, groups config exists (other groups), current group has NO config → pass through
  it("C1: groupPolicy=open, groups exist but current group unlisted → passes through via workaround", async () => {
    api = makeNoCredApi({ groupPolicy: "open" });
    startLansengerGateway(api);

    // Simulate SDK bug: resolveGroupPolicy returns allowed=false but no groupConfig
    // (SDK sees groups entries for other groups and incorrectly sets allowlistEnabled=true)
    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({
      allowed: false,
      allowlistEnabled: true,  // SDK bug: thinks allowlist is enabled even though mode is open
    });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody()), makeRes());

    // Workaround: effectiveGroupPolicyMode === "open" && !groupPolicy.groupConfig → pass through
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  // C2: groupPolicy=allowlist, current group has NO config → blocked
  it("C2: groupPolicy=allowlist, no group config → blocked (no workaround)", async () => {
    api = makeNoCredApi({ groupPolicy: "allowlist" });
    startLansengerGateway(api);

    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({
      allowed: false,
      allowlistEnabled: true,
    });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(groupWebhookBody()), makeRes());

    // Workaround NOT applied: mode is "allowlist", not "open"
    expect(inboundRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multi-account: sessionAccountTracker
// ---------------------------------------------------------------------------

describe("Multi-account session tracking", () => {
  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
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

  it("D2: setSessionAccountId records accountId from handleInbound", async () => {
    const { getSessionAccountId } = await import("./runtime.js");

    api = makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: [] as string[],
            accounts: {
              "bot1": { appId: "", appSecret: "", allowFrom: ["user-1"] },
            },
          },
        },
      },
    });
    startLansengerGateway(api);

    api.runtime.channel.groups.resolveGroupPolicy = vi.fn().mockReturnValue({ allowed: true });
    api.runtime.channel.groups.resolveRequireMention = vi.fn().mockReturnValue(false);
    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(
      makeReqWithAccount(groupWebhookBody({ senderId: "user-1" }), "bot1"),
      makeRes(),
    );

    expect(inboundRun).toHaveBeenCalledTimes(1);
    // Verify sessionAccountTracker was set via inbound.run params
    const params = inboundRun.mock.calls[0]![0] as any;
    const sessionKey = params.adapter.resolveTurn().routeSessionKey;
    const trackedAccountId = getSessionAccountId(sessionKey);
    expect(trackedAccountId).toBe("bot1");
  });
});

// ---------------------------------------------------------------------------
// DM: pairing store allowFrom merge
// ---------------------------------------------------------------------------

describe("DM pairing store allowFrom merge", () => {
  let api: any;

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
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

  // E3: pairing mode, store allowFrom merged with config allowFrom
  it("E3: pairing mode merges store allowFrom with config allowFrom", async () => {
    api = makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: ["config-user-1"],
          },
        },
      },
      runtime: {
        channel: {
          pairing: {
            // Store returns a user NOT in config allowFrom
            readAllowFromStore: async () => ["store-user-1"],
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
    });
    startLansengerGateway(api);

    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    // Sender is in STORE allowFrom but NOT in config allowFrom → should be allowed via merge
    await route.handler(makeReq(dmWebhookBody({ senderId: "store-user-1" })), makeRes());

    // effectiveAllowFrom = config + store = ["config-user-1", "store-user-1"]
    // store-user-1 is in the merged list → allowed
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("pairing: sender NOT in config nor store → pairing code sent, inbound.run not called", async () => {
    api = makeApi({
      config: {
        channels: {
          lansenger: {
            appId: "",
            appSecret: "",
            dmPolicy: "pairing",
            allowFrom: ["config-user-1"],
          },
        },
      },
      runtime: {
        channel: {
          pairing: {
            readAllowFromStore: async () => ["store-user-1"],
            upsertPairingRequest: async () => ({ code: "PAIR999" }),
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
    });
    startLansengerGateway(api);

    let pairingCodeSent = false;
    // Override fetch to capture formatText sent for pairing
    vi.stubGlobal("fetch", async (url: string | Request, init?: any) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(
          JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }),
          { headers: { "content-type": "application/json" } },
        );
      if (u.includes("bot/messages/create")) {
        pairingCodeSent = true;
      }
      return new Response(
        JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const inboundRun = vi.fn().mockResolvedValue(undefined);
    api.runtime.channel.inbound.run = inboundRun;

    const route = api._httpRoutes.at(-1)!
    await route.handler(makeReq(dmWebhookBody({ senderId: "unknown-user" })), makeRes());

    expect(inboundRun).not.toHaveBeenCalled();
    expect(pairingCodeSent).toBe(true);
  });
});