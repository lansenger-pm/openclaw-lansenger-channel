/**
 * Token self-heal tests (v3.18.6, spec §5 T1).
 *
 * Covers the one-shot refresh+retry around rotated/invalidated appTokens:
 * - T1-1  invalid-token errCode triggers exactly one refresh + retry → success
 * - T1-2  retry happens at most once per outbound call
 * - T1-3  40018 (secret rejected) never enters the retry set
 * - T1-4  other errCodes / HTTP failures never trigger a refresh
 * - T1-5  concurrent callers share one refresh (single-flight)
 * - T1-6  refresh rejected (40018) → original failure + actionable hint
 * - T1-7  getAppToken caching semantics unchanged
 * - T1-8  raw-fetch call sites (uploadMedia / queryGroups / downloadMedia) heal too
 * - T1-9  tokenStatus accounting (ok / rejected / none)
 * - T1-10 still-invalid after retry → second result returned as-is, no loop
 * - T1-11 LANSENGER_TOKEN_INVALID_ERRCODES override takes effect
 * - T1-12 40018 can NEVER be injected into the retry set via env
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LansengerClient } from "./client.js";

vi.mock("ws", () => ({ default: class { constructor(_u: string) {} on() {} ping() {} close() {} terminate() {} } }));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

function jsonResp(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}
function successApi(data: Record<string, unknown> | null = {}): Response {
  return jsonResp({ errCode: 0, errMsg: "", data });
}
function errorApi(errCode: number, errMsg: string): Response {
  return jsonResp({ errCode, errMsg, data: null });
}

type FetchCall = { url: string };
let calls: FetchCall[] = [];
let responder: (url: string) => Response = () => successApi({});

function makeClient(): LansengerClient {
  return new LansengerClient({ appId: "test-id", appSecret: "test-secret" });
}

function installFetch() {
  vi.stubGlobal("fetch", async (input: string | Request | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url });
    return responder(url);
  });
}

function countCalls(fragment: string): number {
  return calls.filter((c) => c.url.includes(fragment)).length;
}

beforeEach(() => {
  calls = [];
  responder = () => successApi({});
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LANSENGER_TOKEN_INVALID_ERRCODES;
});

// T1-1
describe("token self-heal: sendText", () => {
  it("refreshes once and retries when the token is rejected (40019), delivering exactly once", async () => {
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      if (url.includes("bot/messages/create")) {
        return url.includes("tok-1") ? errorApi(40019, "access token invalid") : successApi({ msgId: "m-1" });
      }
      return successApi({});
    };
    const client = makeClient();
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("m-1");
    // apptoken: initial + one refresh; message POST: one rejected + one delivered
    expect(countCalls("apptoken")).toBe(2);
    expect(countCalls("bot/messages/create")).toBe(2);
  });
});

// T1-2 + T1-10
describe("token self-heal: retry bounds", () => {
  it("retries at most once — a persistently invalid token fails without looping", async () => {
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      return errorApi(40019, "access token invalid");
    };
    const client = makeClient();
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(false);
    expect(countCalls("apptoken")).toBe(2); // initial + exactly one refresh
    expect(countCalls("bot/messages/create")).toBe(2); // first + one retry
  });
});

// T1-3
describe("token self-heal: 40018 is never a retry code", () => {
  it("does not refresh or retry when an outbound call answers 40018", async () => {
    responder = (url) => {
      if (url.includes("apptoken")) return successApi({ appToken: "tok-1", expiresIn: 7200 });
      return errorApi(40018, "APP Secret error");
    };
    const client = makeClient();
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(false);
    expect(countCalls("apptoken")).toBe(1); // no refresh
    expect(countCalls("bot/messages/create")).toBe(1); // no retry
  });
});

// T1-4
describe("token self-heal: non-token failures untouched", () => {
  it("does not refresh on other errCodes (e.g. 40001 param error)", async () => {
    responder = (url) => {
      if (url.includes("apptoken")) return successApi({ appToken: "tok-1", expiresIn: 7200 });
      return errorApi(40001, "invalid params");
    };
    const client = makeClient();
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(false);
    expect(countCalls("apptoken")).toBe(1);
    expect(countCalls("bot/messages/create")).toBe(1);
  });

  it("does not refresh on HTTP-level failures", async () => {
    responder = (url) => {
      if (url.includes("apptoken")) return successApi({ appToken: "tok-1", expiresIn: 7200 });
      return new Response("boom", { status: 500 });
    };
    const client = makeClient();
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(false);
    expect(countCalls("apptoken")).toBe(1);
    expect(countCalls("bot/messages/create")).toBe(1);
  });
});

// T1-5
describe("token self-heal: single-flight refresh", () => {
  it("concurrent failing callers share exactly one refresh", async () => {
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      if (url.includes("bot/messages/create")) {
        return url.includes("tok-1") ? errorApi(40019, "access token invalid") : successApi({ msgId: "ok" });
      }
      return successApi({});
    };
    const client = makeClient();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => client.sendText(`user-${i}`, "hello")),
    );
    expect(results.every((r) => r.success)).toBe(true);
    // initial refresh (deduped across callers) + exactly one post-failure refresh
    expect(countCalls("apptoken")).toBe(2);
    // 5 rejected + 5 delivered
    expect(countCalls("bot/messages/create")).toBe(10);
  });
});

// T1-6 + T1-9
describe("token self-heal: rejected secret surfaces actionable error", () => {
  it("returns the original failure with a rotation hint when the refresh itself is rejected", async () => {
    let apptokenCalls = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        apptokenCalls += 1;
        return apptokenCalls === 1
          ? successApi({ appToken: "tok-old", expiresIn: 7200 })
          : errorApi(40018, "APP Secret error");
      }
      return errorApi(40019, "access token invalid");
    };
    const client = makeClient();
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("access token invalid");
    expect(result.error).toContain("openclaw gateway restart");
    const status = client.getTokenStatus();
    expect(status.lastRefreshResult).toBe("rejected");
    expect(status.lastRefreshErrCode).toBe(40018);
    expect(status.hasToken).toBe(false);
  });
});

// T1-7
describe("getAppToken caching semantics unchanged", () => {
  it("returns the cached token without hitting the network", async () => {
    responder = (url) => {
      if (url.includes("apptoken")) return successApi({ appToken: "tok-1", expiresIn: 7200 });
      return successApi({ msgId: "m" });
    };
    const client = makeClient();
    await client.sendText("user-1", "a");
    await client.sendText("user-2", "b");
    expect(countCalls("apptoken")).toBe(1); // cached
  });

  it("refreshes again after the cache window passes", async () => {
    vi.useFakeTimers();
    try {
      responder = (url) => {
        if (url.includes("apptoken")) return successApi({ appToken: "tok-1", expiresIn: 10 });
        return successApi({ msgId: "m" });
      };
      const client = makeClient();
      await client.sendText("user-1", "a");
      // expiresIn-300 clamps to a non-negative expiry of "now": advance past it
      vi.advanceTimersByTime(11_000);
      await client.sendText("user-2", "b");
      expect(countCalls("apptoken")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// T1-8
describe("raw-fetch call sites heal too", () => {
  it("uploadMedia refreshes and retries on 40019", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("img"));
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      if (url.includes("medias/create")) {
        return url.includes("tok-1") ? errorApi(40019, "access token invalid") : successApi({ mediaId: "media-9" });
      }
      return successApi({});
    };
    const client = makeClient();
    const result = await client.uploadMedia("/tmp/photo.jpg");
    expect(result).toEqual({ mediaId: "media-9" });
    expect(countCalls("apptoken")).toBe(2);
    expect(countCalls("medias/create")).toBe(2);
  });

  it("queryGroups refreshes and retries on 40019", async () => {
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      if (url.includes("groups/fetch")) {
        return url.includes("tok-1")
          ? errorApi(40019, "access token invalid")
          : successApi({ totalGroupIds: 1, groupIds: ["g1"] });
      }
      return successApi({});
    };
    const client = makeClient();
    const result = await client.queryGroups();
    expect(result).toEqual({ totalGroupIds: 1, groupIds: ["g1"] });
    expect(countCalls("apptoken")).toBe(2);
  });

  it("downloadMedia refreshes and retries when the gateway answers a JSON error before media bytes", async () => {
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      if (url.includes("medias/media-1/fetch")) {
        if (url.includes("tok-1")) return errorApi(40019, "access token invalid");
        return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return successApi({});
    };
    const client = makeClient();
    const result = await client.downloadMedia("media-1");
    expect(result?.bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(countCalls("apptoken")).toBe(2);
  });
});

// T1-11 + T1-12
describe("LANSENGER_TOKEN_INVALID_ERRCODES override", () => {
  it("adds custom codes to the retry set", async () => {
    vi.resetModules();
    process.env.LANSENGER_TOKEN_INVALID_ERRCODES = "40100";
    const { LansengerClient: FreshClient } = await import("./client.js");
    let tokenGeneration = 0;
    responder = (url) => {
      if (url.includes("apptoken")) {
        tokenGeneration += 1;
        return successApi({ appToken: `tok-${tokenGeneration}`, expiresIn: 7200 });
      }
      if (url.includes("bot/messages/create")) {
        return url.includes("tok-1") ? errorApi(40100, "custom invalid") : successApi({ msgId: "m" });
      }
      return successApi({});
    };
    const client = new FreshClient({ appId: "test-id", appSecret: "test-secret" });
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(true);
    expect(countCalls("apptoken")).toBe(2);
  });

  it("never allows 40018 into the retry set, even via env", async () => {
    vi.resetModules();
    process.env.LANSENGER_TOKEN_INVALID_ERRCODES = "40018";
    const { LansengerClient: FreshClient } = await import("./client.js");
    responder = (url) => {
      if (url.includes("apptoken")) return successApi({ appToken: "tok-1", expiresIn: 7200 });
      return errorApi(40018, "APP Secret error");
    };
    const client = new FreshClient({ appId: "test-id", appSecret: "test-secret" });
    const result = await client.sendText("user-1", "hello");
    expect(result.success).toBe(false);
    expect(countCalls("apptoken")).toBe(1);
    expect(countCalls("bot/messages/create")).toBe(1);
  });
});