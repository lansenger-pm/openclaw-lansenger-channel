import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getLastInboundChatId, getLastInboundTime, getRunningClient, getRunningAccount, startLansengerGateway, mergeInboundEvents } from "./runtime.js";
import { LansengerClient } from "./client.js";
import type { InboundEvent } from "./client.js";

function makeApi(overrides?: Record<string, any>): any {
  const methods: Record<string, any> = {};
  const httpRoutes: any[] = [];
  const api = {
    config: overrides?.config ?? { channels: { lansenger: { appId: "test-app", appSecret: "test-secret" } } },
    registerGatewayMethod: (name: string, handler: any) => { methods[name] = handler; },
    registerHttpRoute: (route: any) => { httpRoutes.push(route); },
    registerHook: () => {},
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
});