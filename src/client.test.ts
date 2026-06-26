import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LansengerClient, mediaTypeFromPath, uploadMediaTypeFromPath, buildI18n, DEFAULT_API_GATEWAY_URL, MAX_MESSAGE_LENGTH } from "./client.js";
import type { ReferenceMsg } from "./client.js";
import * as fs from "node:fs/promises";

vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;

    private _events: Record<string, (...args: unknown[]) => void> = {};

    constructor(_url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      this._events[event] = cb;
    }

    emitPong() {
      this._events["pong"]?.();
    }

    ping() {}
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: "", wasClean: true });
    }
    terminate() {
      this.readyState = 3;
      this.onclose?.({ code: 1006, reason: "", wasClean: false });
    }
  }
  return { default: MockWebSocket };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

function makeClient(): LansengerClient {
  return new LansengerClient({ appId: "test-id", appSecret: "test-secret" });
}

function jsonResp(data: Record<string, unknown>): Response {
  const body = JSON.stringify(data);
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function successApi(data: Record<string, unknown> | null = {}): Response {
  return jsonResp({ errCode: 0, errMsg: "", data });
}

function errorApi(errCode: number, errMsg: string): Response {
  return jsonResp({ errCode, errMsg, data: null });
}

describe("convertPxToPt", () => {
  it("converts 16px to 12pt (clamped min)", () => {
    const result = "font-size:16px text".replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_m, n) => `font-size:${Math.max(12, Math.min(36, Math.round(parseFloat(n) * 0.75)))}pt`);
    expect(result).toBe("font-size:12pt text");
  });

  it("0px clamps to 12pt minimum", () => {
    const result = "font-size:0px".replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_m, n) => `font-size:${Math.max(12, Math.min(36, Math.round(parseFloat(n) * 0.75)))}pt`);
    expect(result).toBe("font-size:12pt");
  });

  it("100px clamps to 36pt maximum", () => {
    const result = "font-size:100px".replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_m, n) => `font-size:${Math.max(12, Math.min(36, Math.round(parseFloat(n) * 0.75)))}pt`);
    expect(result).toBe("font-size:36pt");
  });

  it("20px converts to 15pt", () => {
    const result = "font-size:20px".replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_m, n) => `font-size:${Math.max(12, Math.min(36, Math.round(parseFloat(n) * 0.75)))}pt`);
    expect(result).toBe("font-size:15pt");
  });

  it("no px values returns unchanged", () => {
    const input = "font-size:12pt text";
    const result = input.replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_m, n) => `font-size:${Math.max(12, Math.min(36, Math.round(parseFloat(n) * 0.75)))}pt`);
    expect(result).toBe(input);
  });
});

describe("mediaTypeFromPath", () => {
  it("detects image extensions", () => {
    expect(mediaTypeFromPath("photo.jpg")).toBe(2);
    expect(mediaTypeFromPath("photo.jpeg")).toBe(2);
    expect(mediaTypeFromPath("photo.png")).toBe(2);
    expect(mediaTypeFromPath("photo.gif")).toBe(2);
    expect(mediaTypeFromPath("photo.webp")).toBe(2);
  });

  it("detects video extensions", () => {
    expect(mediaTypeFromPath("clip.mp4")).toBe(1);
    expect(mediaTypeFromPath("clip.mov")).toBe(1);
    expect(mediaTypeFromPath("clip.avi")).toBe(1);
  });

  it("detects file extensions", () => {
    expect(mediaTypeFromPath("doc.pdf")).toBe(3);
    expect(mediaTypeFromPath("data.xlsx")).toBe(3);
  });

  it("unknown extension returns file type", () => {
    expect(mediaTypeFromPath("file.xyz")).toBe(3);
    expect(mediaTypeFromPath("noext")).toBe(3);
  });

  it("uppercase extension normalized", () => {
    expect(mediaTypeFromPath("photo.JPG")).toBe(2);
    expect(mediaTypeFromPath("clip.MP4")).toBe(1);
  });
});

describe("uploadMediaTypeFromPath", () => {
  it("detects image extensions", () => {
    expect(uploadMediaTypeFromPath("photo.jpg")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.jpeg")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.png")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.gif")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.webp")).toBe("image");
  });

  it("detects video extensions", () => {
    expect(uploadMediaTypeFromPath("clip.mp4")).toBe("video");
    expect(uploadMediaTypeFromPath("clip.mov")).toBe("video");
    expect(uploadMediaTypeFromPath("clip.avi")).toBe("video");
  });

  it("detects audio extensions", () => {
    expect(uploadMediaTypeFromPath("song.mp3")).toBe("audio");
    expect(uploadMediaTypeFromPath("song.wav")).toBe("audio");
    expect(uploadMediaTypeFromPath("song.amr")).toBe("audio");
    expect(uploadMediaTypeFromPath("song.m4a")).toBe("audio");
  });

  it("defaults to file for unknown extensions", () => {
    expect(uploadMediaTypeFromPath("doc.pdf")).toBe("file");
    expect(uploadMediaTypeFromPath("data.xlsx")).toBe("file");
    expect(uploadMediaTypeFromPath("file.xyz")).toBe("file");
    expect(uploadMediaTypeFromPath("noext")).toBe("file");
  });

  it("uppercase extension normalized", () => {
    expect(uploadMediaTypeFromPath("photo.JPG")).toBe("image");
    expect(uploadMediaTypeFromPath("clip.MP4")).toBe("video");
  });
});

describe("buildI18n", () => {
  it("creates i18n object with all languages", () => {
    const obj = buildI18n("简体", "繁体", "港繁", "English", "Français");
    expect(obj.zhHans).toBe("简体");
    expect(obj.zhHant).toBe("繁体");
    expect(obj.zhHantHK).toBe("港繁");
    expect(obj.en).toBe("English");
    expect(obj.fr).toBe("Français");
  });
});

describe("LansengerClient.detectLang", () => {
  it("pure CJK text returns zh", () => {
    const client = makeClient();
    expect(client.detectLang("你好世界")).toBe("zh");
  });

  it("pure English text returns en", () => {
    const client = makeClient();
    expect(client.detectLang("Hello world")).toBe("en");
  });

  it("mixed text above threshold returns zh", () => {
    const client = makeClient();
    expect(client.detectLang("你好你好你好你好你好你")).toBe("zh");
  });

  it("mixed text below threshold returns en", () => {
    const client = makeClient();
    expect(client.detectLang("你a")).toBe("en");
  });

  it("empty string returns en", () => {
    const client = makeClient();
    expect(client.detectLang("")).toBe("en");
  });
});

describe("LansengerClient.isGroupChat", () => {
  it("returns true for non-owner chatId when ownerId is set", () => {
    const client = makeClient();
    client.ownerId = "owner-1";
    expect(client.isGroupChat("group-99")).toBe(true);
    expect(client.isGroupChat("user-99")).toBe(true);
  });

  it("returns false for owner chatId when ownerId is set", () => {
    const client = makeClient();
    client.ownerId = "owner-1";
    expect(client.isGroupChat("owner-1")).toBe(false);
  });

  it("falls back to group: prefix when ownerId is empty", () => {
    const client = makeClient();
    expect(client.isGroupChat("group:some-id")).toBe(true);
    expect(client.isGroupChat("some-user")).toBe(false);
  });
});

describe("LansengerClient.userLang caching", () => {
  it("cache and retrieve user lang", () => {
    const client = makeClient();
    client.cacheUserLang("user-1", "你好");
    expect(client.getUserLang("user-1")).toBe("zh");
    client.cacheUserLang("user-2", "Hello");
    expect(client.getUserLang("user-2")).toBe("en");
  });

  it("unknown userId defaults to zh", () => {
    const client = makeClient();
    expect(client.getUserLang("unknown")).toBe("zh");
  });
});

describe("LansengerClient.revokeMessage validation", () => {
  it("rejects invalid chatType", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.revokeMessage(["m1"], "staff" as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain("chatType must be");
    vi.restoreAllMocks();
  });

  it("allows group chatType without senderId (API defaults to caller)", async () => {
    const fetchCalls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | Request, init?: any) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("messages/revoke")) {
        fetchCalls.push({ url: u, body: JSON.parse((init as any)?.body ?? "{}") });
      }
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.revokeMessage(["m1"], "group");
    expect(result.success).toBe(true);
    // senderId should not be in payload
    expect(fetchCalls[0]!.body.senderId).toBeUndefined();
    expect(fetchCalls[0]!.body.chatType).toBe("group");
    vi.restoreAllMocks();
  });
});

describe("LansengerClient with mocked fetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) {
        return successApi({ appToken: "mock-token", expiresIn: 7200 });
      }
      if (u.includes("messages/create") || u.includes("messages/revoke") || u.includes("messages/dynamic/update")) {
        return successApi({ msgId: "mock-msg-id" });
      }
      if (u.includes("groups/fetch")) {
        return successApi({ totalGroupIds: 5, groupIds: ["g1", "g2"] });
      }
      return successApi({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendFormatText succeeds without reminder", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFormatText("chat1", "hello");
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("mock-msg-id");
  });

  it("sendFormatText retries without reminder on failure with reminder", async () => {
    let msgCallCount = 0;
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      msgCallCount++;
      if (msgCallCount === 1) return errorApi(40001, "reminder error");
      return successApi({ msgId: "m2" });
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFormatText("chat1", "hello", { reminder: { all: true } });
    expect(result.success).toBe(true);
    expect(msgCallCount).toBe(2);
  });

  it("sendFormatText returns error when both attempts fail", async () => {
    let msgCallCount = 0;
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      msgCallCount++;
      return errorApi(40001, "error");
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFormatText("chat1", "hello", { reminder: { all: true } });
    expect(result.success).toBe(false);
    expect(msgCallCount).toBe(2);
  });

  it("sendFormatText no retry without reminder", async () => {
    let msgCallCount = 0;
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      msgCallCount++;
      return errorApi(40001, "error");
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFormatText("chat1", "hello");
    expect(result.success).toBe(false);
    expect(msgCallCount).toBe(1);
  });

  it("sendAppCard dynamic without headStatusInfo auto-adds default", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const card: any = { bodyTitle: "Approval", isDynamic: true };
    const result = await client.sendAppCard("chat1", card);
    expect(result.success).toBe(true);
  });

  it("sendAppCard dynamic with headStatusInfo keeps provided", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const card: any = { bodyTitle: "Approval", isDynamic: true, headStatusInfo: { description: "Custom", colour: "#FF0000" } };
    const result = await client.sendAppCard("chat1", card);
    expect(result.success).toBe(true);
  });

  it("sendAppCard non-dynamic no headStatusInfo addition", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const card: any = { bodyTitle: "Info card" };
    const result = await client.sendAppCard("chat1", card);
    expect(result.success).toBe(true);
  });

  it("sendLinkCard succeeds with defaults", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendLinkCard("chat1", "Title", "https://link", { description: "desc" });
    expect(result.success).toBe(true);
  });

  it("sendAppArticles succeeds with defaults", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const articles = [{ imgUrl: "https://img", title: "T", url: "https://u" }];
    const result = await client.sendAppArticles("chat1", articles);
    expect(result.success).toBe(true);
  });

  it("updateCardStatus pending zh succeeds", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.updateCardStatus("m1", "pending", "zh");
    expect(result.success).toBe(true);
  });

  it("updateCardStatus approved en succeeds", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.updateCardStatus("m1", "approved", "en");
    expect(result.success).toBe(true);
  });

  it("updateCardStatus denied defaults zh", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.updateCardStatus("m1", "denied");
    expect(result.success).toBe(true);
  });

  it("queryGroups succeeds", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.queryGroups();
    expect(result).toEqual({ totalGroupIds: 5, groupIds: ["g1", "g2"] });
  });

  it("queryGroups defaults 0/[] on null data", async () => {
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      return successApi(null);
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.queryGroups();
    expect(result).toEqual({ totalGroupIds: 0, groupIds: [] });
  });
});

describe("LansengerClient.getAppToken", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const token = await client.getAppToken();
    expect(token).toBeNull();
  });

  it("returns null on API error code", async () => {
    vi.stubGlobal("fetch", async () => jsonResp({ errCode: 40001, errMsg: "bad", data: null }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const token = await client.getAppToken();
    expect(token).toBeNull();
  });

  it("returns token on success", async () => {
    vi.stubGlobal("fetch", async () => successApi({ appToken: "tok123", expiresIn: 7200 }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const token = await client.getAppToken();
    expect(token).toBe("tok123");
  });

  it("caches token and skips refresh", async () => {
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => { fetchCalls++; return successApi({ appToken: "cached-tok", expiresIn: 7200 }); });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const t1 = await client.getAppToken();
    const t2 = await client.getAppToken();
    expect(t1).toBe("cached-tok");
    expect(t2).toBe("cached-tok");
    expect(fetchCalls).toBe(1);
  });
});

describe("LansengerClient.sendImageUrl error classification", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("HTTP 404 returns specific error", async () => {
    vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendImageUrl("chat1", "https://example.com/missing.jpg");
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 404");
  });

  it("HTTP 5xx returns server error", async () => {
    vi.stubGlobal("fetch", async () => new Response("Error", { status: 500, headers: { "content-type": "text/plain" } }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendImageUrl("chat1", "https://example.com/img.jpg");
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  it("non-image content-type returns specific error", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendImageUrl("chat1", "https://example.com/page");
    expect(result.success).toBe(false);
    expect(result.error).toContain("non-image");
  });
});

describe("LansengerClient processRawMessage", () => {
  it("parses text message from raw JSON", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "text", messageId: "msg-123", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { text: { content: "Hello!" } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("Hello!");
    expect(events[0]!.senderId).toBe("user-1");
    expect(events[0]!.isGroup).toBe(false);
  });

  it("handles group messages", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "text", messageId: "msg-456", chatType: "group", from: "user-2", conversationId: "group-1", conversationTitle: "Team Chat", senderName: "Bob", msgData: { text: { content: "Hi team!" } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.isGroup).toBe(true);
    expect(events[0]!.chatName).toBe("Team Chat");
  });

  it("skips empty text messages", async () => {
    const client = makeClient();
    const raw = JSON.stringify({ events: [{ data: { msgType: "text", messageId: "msg-empty", msgData: { text: { content: "" } } } }] });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(0);
  });

  it("handles invalid JSON", async () => {
    const client = makeClient();
    const events = await client.processRawMessage("not json");
    expect(events.length).toBe(0);
  });

  it("handles formatText message", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "formatText", messageId: "fmt-1", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { formatText: { formatType: 1, text: "**Bold**" } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("**Bold**");
  });

  it("handles multiple events", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [
        { data: { msgType: "text", messageId: "m1", chatType: "p2p", from: "u1", conversationId: "c1", senderName: "A", msgData: { text: { content: "First" } } } },
        { data: { msgType: "text", messageId: "m2", chatType: "p2p", from: "u2", conversationId: "c2", senderName: "B", msgData: { text: { content: "Second" } } } },
      ],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(2);
  });
});

describe("constants", () => {
  it("DEFAULT_API_GATEWAY_URL is correct", () => {
    expect(DEFAULT_API_GATEWAY_URL).toBe("https://open.e.lanxin.cn/open/apigw");
  });

  it("MAX_MESSAGE_LENGTH is 4000", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4000);
  });
});

describe("LansengerClient.sendText", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      if (u.includes("messages/create")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: {} }), { headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends plain text successfully", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendText("user-1", "Hello");
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("m1");
  });

  it("sends plain text with reminder", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendText("user-1", "Hello", { reminder: { all: true } });
    expect(result.success).toBe(true);
  });

  it("returns error when no token", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errCode: 40001, errMsg: "bad" }), { headers: { "content-type": "application/json" } }));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendText("user-1", "Hello");
    expect(result.success).toBe(false);
  });
});

describe("LansengerClient.msgTarget (via sendText group vs dm)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (u.includes("messages/group")) {
        return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "group-msg" } }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "dm-msg" } }), { headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("uses group endpoint for non-owner chatId", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    client.ownerId = "owner-1";
    const result = await client.sendText("some-group", "Hi group");
    expect(result.success).toBe(true);
  });

  it("uses private endpoint for DM chatId", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendText("user-1", "Hi user");
    expect(result.success).toBe(true);
  });

  it("uses group endpoint for group: prefix chatId", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendText("group:some-id", "Hi");
    expect(result.success).toBe(true);
  });
});

describe("processRawMessage additional msgTypes", () => {
  it("handles position message", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "position", messageId: "pos-1", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { position: { name: "Office", address: "Building 5", latitude: "39.9", longitude: "116.4" } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.text).toContain("[Location]");
    expect(events[0]!.text).toContain("Office");
  });

  it("handles card (contact card) message", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "card", messageId: "card-1", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { card: { staffId: "staff-123" } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.text).toContain("[Contact Card]");
    expect(events[0]!.text).toContain("staff-123");
  });

  it("handles sticker message", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "sticker", messageId: "stk-1", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { sticker: { stickerId: "stk-001" } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.text).toContain("[Sticker]");
  });

  it("handles unknown msgType gracefully", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "unknown_type", messageId: "unk-1", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: {} } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(0);
  });
});

describe("convertPxToPtDeep", () => {
  it("converts px in nested object", () => {
    const client = makeClient();
    const input = { bodyTitle: "Title", bodyContent: "font-size:16px text" };
    const card: any = { bodyTitle: input.bodyTitle, bodyContent: "font-size:16px text" };
    expect(card.bodyContent).toContain("16px");
  });

  it("convertPxToPt in string", () => {
    const result = "font-size:20px and font-size:48px".replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_m, n) => `font-size:${Math.max(12, Math.min(36, Math.round(parseFloat(n) * 0.75)))}pt`);
    expect(result).toBe("font-size:15pt and font-size:36pt");
  });
});

describe("LansengerClient.isWsAlive", () => {
  it("returns false when no ws connection", () => {
    const client = makeClient();
    expect(client.isWsAlive()).toBe(false);
  });
});

describe("LansengerClient.setMessageHandler", () => {
  it("sets handler", () => {
    const client = makeClient();
    const handler = async () => {};
    client.setMessageHandler(handler);
    expect((client as any).messageHandler).toBe(handler);
  });
});

describe("postJson error handling", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      if (u.includes("messages/create")) return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("handles HTTP 500 from API", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendText("user-1", "Hello");
    expect(result.success).toBe(false);
  });
});

describe("LansengerClient.parseReferenceMsg", () => {
  it("parses simple reference message", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "text", messageId: "msg-ref1", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { text: { content: "Replying to this" } }, referenceMsg: { from: "user-2", senderName: "Bob", msgType: "text", msgData: { text: { content: "Original message" } } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.referenceMsg).toBeDefined();
    expect(events[0]!.referenceMsg!.from).toBe("user-2");
    expect(events[0]!.referenceMsg!.senderName).toBe("Bob");
    expect(events[0]!.referenceMsg!.msgType).toBe("text");
  });

  it("parses nested reference message (recursive)", async () => {
    const client = makeClient();
    const raw = JSON.stringify({
      events: [{ data: { msgType: "text", messageId: "msg-ref2", chatType: "p2p", from: "user-1", conversationId: "conv-1", senderName: "Alice", msgData: { text: { content: "Third reply" } }, referenceMsg: { from: "user-2", senderName: "Bob", msgType: "text", msgData: { text: { content: "Second reply" } }, referenceMsg: { from: "user-3", senderName: "Carol", msgType: "text", msgData: { text: { content: "Original message" } } } } } }],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.referenceMsg!.referenceMsg).toBeDefined();
    expect(events[0]!.referenceMsg!.referenceMsg!.from).toBe("user-3");
    expect(events[0]!.referenceMsg!.referenceMsg!.senderName).toBe("Carol");
  });
});

describe("LansengerClient.extractReferenceText", () => {
  it("extracts text from simple reference", async () => {
    const client = makeClient();
    const ref: ReferenceMsg = { from: "user-2", senderName: "Bob", msgType: "text", msgData: { text: { content: "Original message" } } };
    const text = await client.extractReferenceText(ref);
    expect(text).toContain("[Quoted text] from Bob");
    expect(text).toContain("Original message");
  });

  it("extracts non-text reference types", async () => {
    const client = makeClient();
    const ref: ReferenceMsg = { from: "user-2", senderName: "Bob", msgType: "image", msgData: { image: { mediaIds: [] } } };
    const text = await client.extractReferenceText(ref);
    expect(text).toContain("[Quoted image] from Bob");
  });

  it("extracts nested reference recursively", async () => {
    const client = makeClient();
    const ref: ReferenceMsg = {
      from: "user-2", senderName: "Bob", msgType: "text", msgData: { text: { content: "Second reply" } },
      referenceMsg: { from: "user-3", senderName: "Carol", msgType: "text", msgData: { text: { content: "Original" } } },
    };
    const text = await client.extractReferenceText(ref);
    expect(text).toContain("[Quoted text] from Bob: Second reply");
    expect(text).toContain("[Quoted text] from Carol: Original");
  });

  it("handles reference without msgData", async () => {
    const client = makeClient();
    const ref: ReferenceMsg = { from: "user-2", senderName: "Bob" };
    const text = await client.extractReferenceText(ref);
    expect(text).toBe("");
  });

  it("uses from as fallback when senderName missing", async () => {
    const client = makeClient();
    const ref: ReferenceMsg = { from: "user-2", msgType: "text", msgData: { text: { content: "Hello" } } };
    const text = await client.extractReferenceText(ref);
    expect(text).toContain("from user-2");
  });
});

// ---- wsState ----

describe("LansengerClient.wsState", () => {
  it("returns NULL when no WebSocket", () => {
    const client = makeClient();
    expect(client.wsState()).toBe("NULL");
  });

  it("returns CONNECTING when ws readyState=0", () => {
    const client = makeClient();
    (client as any).ws = { readyState: 0 };
    expect(client.wsState()).toBe("CONNECTING");
  });

  it("returns OPEN when ws readyState=1", () => {
    const client = makeClient();
    (client as any).ws = { readyState: 1 };
    expect(client.wsState()).toBe("OPEN");
  });

  it("returns CLOSING when ws readyState=2", () => {
    const client = makeClient();
    (client as any).ws = { readyState: 2 };
    expect(client.wsState()).toBe("CLOSING");
  });

  it("returns CLOSED when ws readyState=3", () => {
    const client = makeClient();
    (client as any).ws = { readyState: 3 };
    expect(client.wsState()).toBe("CLOSED");
  });
});

// ---- setWsLifecycleCallbacks ----

describe("LansengerClient.setWsLifecycleCallbacks", () => {
  it("stores onOpen and onClose callbacks", () => {
    const client = makeClient();
    const onOpen = () => {};
    const onClose = () => {};
    client.setWsLifecycleCallbacks({ onOpen, onClose });
    expect((client as any).onWsOpen).toBe(onOpen);
    expect((client as any).onWsClose).toBe(onClose);
  });

  it("stores null for missing callbacks", () => {
    const client = makeClient();
    client.setWsLifecycleCallbacks({});
    expect((client as any).onWsOpen).toBeNull();
    expect((client as any).onWsClose).toBeNull();
  });

  it("stores partial callbacks (onOpen only)", () => {
    const client = makeClient();
    const onOpen = () => {};
    client.setWsLifecycleCallbacks({ onOpen });
    expect((client as any).onWsOpen).toBe(onOpen);
    expect((client as any).onWsClose).toBeNull();
  });
});

// ---- Commands API ----

describe("LansengerClient commands API", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("createCommands succeeds", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("commands/create")) return successApi({});
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.createCommands(4, [{ command: "/test", description: "A test command" }]);
    expect(result.success).toBe(true);
  });

  it("deleteCommands succeeds", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("commands/delete")) return successApi({});
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.deleteCommands(4);
    expect(result.success).toBe(true);
  });

  it("fetchCommands returns commands array", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("commands/fetch")) return successApi({ commands: [{ command: "/test", description: "Test command" }] });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.fetchCommands(4);
    expect(result).toEqual([{ command: "/test", description: "Test command" }]);
  });

  it("fetchCommands returns null on API error", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("commands/fetch")) return errorApi(40001, "fetch error");
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.fetchCommands(4);
    expect(result).toBeNull();
  });

  it("createCommands returns error when no token", async () => {
    vi.stubGlobal("fetch", async () => errorApi(40001, "bad"));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.createCommands(4, [{ command: "/test", description: "Test" }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No access token");
  });
});

// ---- uploadMedia ----

describe("LansengerClient.uploadMedia", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("uploads image successfully", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-image-data"));
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("medias/create")) return successApi({ mediaId: "media-123" });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.uploadMedia("/tmp/photo.jpg");
    expect(result).toEqual({ mediaId: "media-123" });
  });

  it("returns error when fs.readFile fails", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT: no such file"));
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.uploadMedia("/tmp/nonexistent.jpg");
    expect(result).toEqual({ error: "ENOENT: no such file" });
  });

  it("returns error when no token", async () => {
    vi.stubGlobal("fetch", async () => errorApi(40001, "bad"));
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.uploadMedia("/tmp/photo.jpg");
    expect(result).toEqual({ error: "No access token" });
  });

  it("returns error on upload HTTP error", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("data"));
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      return new Response("Error", { status: 500 });
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.uploadMedia("/tmp/photo.jpg");
    expect(result).toEqual({ error: "Upload HTTP error: 500" });
  });
});

// ---- sendFile ----

describe("LansengerClient.sendFile", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends image file successfully", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-image-data"));
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      if (u.includes("medias/create")) return successApi({ mediaId: "media-456" });
      if (u.includes("messages/create")) return successApi({ msgId: "msg-sendfile" });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFile("chat1", "/tmp/photo.png");
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-sendfile");
  });

  it("returns error when file not found", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT: no such file or directory"));
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFile("chat1", "/tmp/missing.png");
    expect(result.success).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("returns error for video without cover image", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return successApi({ appToken: "tok", expiresIn: 7200 });
      return successApi({});
    });
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const result = await client.sendFile("chat1", "/tmp/video.mp4");
    expect(result.success).toBe(false);
    expect(result.error).toContain("cover image");
  });
});

// ---- connect / disconnect ----

describe("LansengerClient connect/disconnect", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("connect returns true and disconnect cleans up", async () => {
    vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("ws/endpoint")) {
        return successApi({ wsEndpoint: "wss://test.example.com/ws" });
      }
      return successApi({});
    });

    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const ok = await client.connect();
    expect(ok).toBe(true);

    // Wait a tick for the mock WS to open
    await new Promise((r) => setTimeout(r, 10));

    // Verify ws is alive
    expect(client.isWsAlive()).toBe(true);

    // Disconnect and wait for cleanup
    await client.disconnect();

    expect((client as any).ws).toBeNull();
    expect((client as any).running).toBe(false);
    expect(client.isWsAlive()).toBe(false);
    expect(client.wsState()).toBe("NULL");
  });

  it("connect returns false when WS endpoint fetch fails", async () => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("ws/endpoint")) {
        return errorApi(40001, "invalid credentials");
      }
      return successApi({});
    });

    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const ok = await client.connect();
    expect(ok).toBe(false);
  });

  it("connect returns false when missing appId", async () => {
    const client = new LansengerClient({ appId: "", appSecret: "" });
    const ok = await client.connect();
    expect(ok).toBe(false);
  });

  it("setMessageHandler stores and can be retrieved", () => {
    const client = makeClient();
    const handler = async (_event: any) => {};
    client.setMessageHandler(handler);
    expect((client as any).messageHandler).toBe(handler);
  });
});