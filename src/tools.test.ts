import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerLansengerTools } from "./tools.js";
import { LansengerClient } from "./client.js";
import * as runtime from "./runtime.js";

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

function makeMockApi() {
  const tools: Record<string, any> = {};
  return {
    config: { bindings: [{ agentId: "test", match: { channel: "lansenger", accountId: "test-account" } }] },
    registerTool: (def: any) => {
      if (typeof def === "function") {
        const ctx = { agentAccountId: "test-account" };
        const result = def(ctx);
        if (Array.isArray(result)) {
          for (const tool of result) tools[tool.name] = tool;
        } else if (result) {
          tools[result.name] = result;
        }
      } else {
        tools[def.name] = def;
      }
    },
    _tools: tools,
  };
}

const mockClient = new LansengerClient({ appId: "test-id", appSecret: "test-secret" });
const mockAccount = {
  accountId: "test-account",
  appId: "test-id",
  appSecret: "test-secret",
  apiGatewayUrl: "https://open.e.lanxin.cn/open/apigw",
  allowFrom: [],
  groupAllowFrom: [],
  dmPolicy: undefined,
  groupPolicy: undefined,
  homeChannel: undefined,
  enabled: true,
  ackMessage: false,
  ackMessageTextZh: "",
  ackMessageTextEn: "",
  revokeAckMessage: false,
  dangerouslyAllowPrivateNetwork: false,
  mediaLocalRoots: [] as string[],
  autoMentionReply: false,
  autoQuoteReply: false,
  respondToAtAll: false,
};

function mockRunning() {
  vi.spyOn(runtime, "getRunningClient").mockReturnValue(mockClient);
  vi.spyOn(runtime, "getRunningAccount").mockReturnValue(mockAccount);
  vi.spyOn(runtime, "getRunningClientByAccountId").mockReturnValue(mockClient);
  vi.spyOn(runtime, "getRunningAccountByAccountId").mockReturnValue(mockAccount);
  vi.spyOn(runtime, "getLastInboundChatId").mockReturnValue("chat-1");
}

function mockNotRunning() {
  vi.spyOn(runtime, "getRunningClient").mockReturnValue(null);
  vi.spyOn(runtime, "getRunningAccount").mockReturnValue(null);
  vi.spyOn(runtime, "getRunningClientByAccountId").mockReturnValue(null);
  vi.spyOn(runtime, "getRunningAccountByAccountId").mockReturnValue(null);
}

function mockNoChatId() {
  vi.spyOn(runtime, "getLastInboundChatId").mockReturnValue("");
}

describe("registerLansengerTools", () => {
  it("registers all 15 tools", () => {
    mockRunning();
    const api = makeMockApi();
    registerLansengerTools(api);
    const names = Object.keys(api._tools);
    expect(names.length).toBe(15);
    expect(names).toContain("lansenger_send_file");
    expect(names).toContain("lansenger_send_text");
    expect(names).toContain("lansenger_send_format_text");
    expect(names).toContain("lansenger_send_image_url");
    expect(names).toContain("lansenger_revoke_message");
    expect(names).toContain("lansenger_send_link_card");
    expect(names).toContain("lansenger_send_app_articles");
    expect(names).toContain("lansenger_send_app_card");
    expect(names).toContain("lansenger_update_dynamic_card");
    expect(names).toContain("lansenger_send_approve_card");
    expect(names).toContain("lansenger_query_groups");
    expect(names).toContain("lansenger_group_info");
    expect(names).toContain("lansenger_group_members");
    expect(names).toContain("lansenger_group_check_membership");
    expect(names).toContain("lansenger_download_media");
    vi.restoreAllMocks();
  });
});

describe("lansenger_send_file", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_send_file"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  filePath: "/tmp/test.txt", to: "chat-1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when filePath missing", async () => {
    const result = await api._tools["lansenger_send_file"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  to: "chat-1" });
    expect(parseResult(result).error).toContain("filePath is required");
  });

  it("returns error when to missing and no inbound chat", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_file"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  filePath: "/tmp/test.txt" });
    expect(parseResult(result).error).toContain("No target");
  });

  it("returns error when file not found", async () => {
    const result = await api._tools["lansenger_send_file"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  filePath: "/tmp/nonexistent_abc.txt", to: "chat-1" });
    expect(parseResult(result).error).toContain("File not found");
  });

  it("returns error when path is directory", async () => {
    const result = await api._tools["lansenger_send_file"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  filePath: "/tmp", to: "chat-1" });
    expect(parseResult(result).error).toContain("Not a file");
  });

  it("uses session deliveryContext as default target", async () => {
    // The mock ctx doesn't have deliveryContext, so passing no 'to' should
    // result in a "No target" error since the session target is empty.
    const result = await api._tools["lansenger_send_file"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  filePath: "/tmp" });
    expect(parseResult(result).error).toContain("No target");
  });
});

describe("lansenger_send_text", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_send_text"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "hello", to: "chat-1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_text"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "hello" });
    expect(parseResult(result).error).toContain("No target");
  });

  it("returns error when file attachment not found", async () => {
    const result = await api._tools["lansenger_send_text"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "caption", filePath: "/tmp/nonexistent_xyz.txt", to: "chat-1" });
    expect(parseResult(result).error).toContain("File not found");
  });
});

describe("lansenger_send_format_text", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_send_format_text"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "**bold**", to: "chat-1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_format_text"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "**bold**" });
    expect(parseResult(result).error).toContain("No target");
  });
});

describe("lansenger_send_image_url", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when imageUrl missing", async () => {
    const result = await api._tools["lansenger_send_image_url"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  to: "chat-1" });
    expect(parseResult(result).error).toContain("imageUrl is required");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_image_url"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  imageUrl: "https://img.com/x.jpg" });
    expect(parseResult(result).error).toContain("No target");
  });
});

describe("lansenger_revoke_message", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when messageIds empty", async () => {
    const result = await api._tools["lansenger_revoke_message"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  messageIds: [] });
    expect(parseResult(result).error).toContain("messageIds is required");
  });

  it("returns error when chatType=group without senderId", async () => {
    const result = await api._tools["lansenger_revoke_message"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  messageIds: ["m1"], chatType: "group" });
    expect(parseResult(result).error).toContain("chatType='group' requires senderId");
  });
});

describe("lansenger_send_link_card", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when title or link missing", async () => {
    const result = await api._tools["lansenger_send_link_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  title: "", link: "", to: "chat-1" });
    expect(parseResult(result).error).toContain("title and link are required");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_link_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  title: "T", link: "https://x.com" });
    expect(parseResult(result).error).toContain("No target");
  });
});

describe("lansenger_send_app_articles", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when articles empty", async () => {
    const result = await api._tools["lansenger_send_app_articles"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  articles: [], to: "chat-1" });
    expect(parseResult(result).error).toContain("articles is required");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_app_articles"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  articles: [{ imgUrl: "i", title: "t", url: "u" }] });
    expect(parseResult(result).error).toContain("No target");
  });
});

describe("lansenger_send_app_card", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when bodyTitle missing", async () => {
    const result = await api._tools["lansenger_send_app_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  to: "chat-1" });
    expect(parseResult(result).error).toContain("bodyTitle is required");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_app_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  bodyTitle: "Card" });
    expect(parseResult(result).error).toContain("No target");
  });

  it("auto-adds headStatusInfo when isDynamic=true without one", async () => {
    vi.stubGlobal("fetch", async (url: any) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
    });
    const params = { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", bodyTitle: "Approval", isDynamic: true, to: "chat-1" };
    const result = await api._tools["lansenger_send_app_card"].execute("tc1", params);
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    vi.restoreAllMocks();
  });

  it("keeps provided headStatusInfo when isDynamic=true", async () => {
    vi.stubGlobal("fetch", async (url: any) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken"))
        return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
    });
    const params = { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", bodyTitle: "Approval", isDynamic: true, headStatusInfo: { description: "Custom", colour: "#FFB116" }, to: "chat-1" };
    const result = await api._tools["lansenger_send_app_card"].execute("tc1", params);
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("lansenger_update_dynamic_card", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when msgId missing", async () => {
    const result = await api._tools["lansenger_update_dynamic_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", });
    expect(parseResult(result).error).toContain("msgId is required");
  });
});

describe("lansenger_query_groups", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_query_groups"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", });
    expect(parseResult(result).error).toContain("not configured or not running");
  });
});

describe("multi-account support", () => {
  const mockAccountA = { ...mockAccount, accountId: "account-A", appId: "app-A" };
  const mockAccountB = { ...mockAccount, accountId: "account-B", appId: "app-B" };

  it("uses appId from params to override session context", async () => {
    const mockClientSpy = { sendText: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }) };
    vi.spyOn(runtime, "getRunningClientByAccountId").mockImplementation((id) => {
      if (id === "account-A") return mockClientSpy as any;
      return null;
    });
    vi.spyOn(runtime, "getRunningAccountByAccountId").mockImplementation((id) => {
      if (id === "account-A") return mockAccountA;
      return null;
    });
    vi.spyOn(runtime, "getRunningClient").mockReturnValue(null);
    vi.spyOn(runtime, "getRunningAccount").mockReturnValue(null);
    vi.spyOn(runtime, "getLastInboundChatId").mockReturnValue("chat-1");

    const api = makeMockApi();
    registerLansengerTools(api);

    const result = await api._tools["lansenger_send_text"].execute("tc1", { appId: "account-A", content: "hello", to: "chat-1" });
    expect(parseResult(result).success).toBe(true);

    expect(runtime.getRunningClientByAccountId).toHaveBeenCalledWith("account-A");
    expect(runtime.getRunningAccountByAccountId).toHaveBeenCalledWith("account-A");
    expect(mockClientSpy.sendText).toHaveBeenCalledWith("chat-1", "hello", undefined);

    vi.restoreAllMocks();
  });

  it("returns error when session account is not running", async () => {
    vi.spyOn(runtime, "getRunningClientByAccountId").mockReturnValue(null);
    vi.spyOn(runtime, "getRunningAccountByAccountId").mockReturnValue(null);
    vi.spyOn(runtime, "getRunningClient").mockReturnValue(null);
    vi.spyOn(runtime, "getRunningAccount").mockReturnValue(null);
    vi.spyOn(runtime, "getLastInboundChatId").mockReturnValue("chat-1");

    const api = makeMockApi();
    registerLansengerTools(api);

    const result = await api._tools["lansenger_send_text"].execute("tc1", { content: "hello", to: "chat-1" });
    expect(parseResult(result).error).toContain("not configured or not running");

    vi.restoreAllMocks();
  });
});

describe("lansenger_send_approve_card", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_send_approve_card"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  head: { title: "T" }, body: { title: "B" }, to: "chat-1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when head missing", async () => {
    const result = await api._tools["lansenger_send_approve_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  body: { title: "B" }, to: "chat-1" });
    expect(parseResult(result).error).toContain("head is required");
  });

  it("returns error when body missing", async () => {
    const result = await api._tools["lansenger_send_approve_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  head: { title: "T" }, to: "chat-1" });
    expect(parseResult(result).error).toContain("body is required");
  });

  it("returns error when to missing", async () => {
    mockNoChatId();
    const result = await api._tools["lansenger_send_approve_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  head: { title: "T" }, body: { title: "B" } });
    expect(parseResult(result).error).toContain("No target");
  });

  it("sends approve card with all params", async () => {
    const sendSpy = vi.spyOn(mockClient, "sendApproveCard").mockResolvedValue({ success: true, messageId: "m1" });
    const params = { _sessionKey: "agent:test:lansenger:dm:user1", 
      appId: "test-id",
      head: { title: "Approval" },
      body: { title: "Details" },
      to: "chat-1",
      reminder: { all: true },
      cardLink: { cardLink: "https://x.com" },
      buttons: [{ text: "OK", buttonTheme: 1 }],
      expireTime: 3600,
    };
    const result = await api._tools["lansenger_send_approve_card"].execute("tc1", params);
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", {
      head: { title: "Approval" },
      body: { title: "Details" },
      reminder: { all: true },
      cardLink: { cardLink: "https://x.com" },
      buttons: [{ text: "OK", buttonTheme: 1 }],
      expireTime: 3600,
    });
  });
});

describe("happy path: lansenger_send_text", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends text successfully", async () => {
    const sendSpy = vi.spyOn(mockClient, "sendText").mockResolvedValue({ success: true, messageId: "m1" });
    const result = await api._tools["lansenger_send_text"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "hello", to: "chat-1" });
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", "hello", undefined);
  });
});

describe("happy path: lansenger_send_format_text", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends format text successfully", async () => {
    const sendSpy = vi.spyOn(mockClient, "sendFormatText").mockResolvedValue({ success: true, messageId: "m1" });
    const result = await api._tools["lansenger_send_format_text"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  content: "**bold**", to: "chat-1" });
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", "**bold**", undefined);
  });
});

describe("happy path: lansenger_send_image_url", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends image url successfully", async () => {
    const sendSpy = vi.spyOn(mockClient, "sendImageUrl").mockResolvedValue({ success: true, messageId: "m1" });
    const result = await api._tools["lansenger_send_image_url"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  imageUrl: "https://img.com/x.jpg", to: "chat-1" });
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", "https://img.com/x.jpg", "");
  });
});

describe("happy path: lansenger_send_file", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends file successfully", async () => {
    const { fileURLToPath } = await import("node:url");
    const testFilePath = fileURLToPath(import.meta.url);
    const sendSpy = vi.spyOn(mockClient, "sendFile").mockResolvedValue({ success: true, messageId: "m1" });
    const result = await api._tools["lansenger_send_file"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  filePath: testFilePath, to: "chat-1" });
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", testFilePath, "", undefined, undefined, undefined, undefined, undefined, undefined);
  });
});

describe("happy path: lansenger_revoke_message", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("revokes messages successfully", async () => {
    const revokeSpy = vi.spyOn(mockClient, "revokeMessage").mockResolvedValue({ success: true });
    const result = await api._tools["lansenger_revoke_message"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  messageIds: ["m1"] });
    expect(parseResult(result).success).toBe(true);
    expect(revokeSpy).toHaveBeenCalledWith(["m1"], "bot", undefined);
  });
});

describe("happy path: lansenger_send_link_card", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends link card successfully", async () => {
    const sendSpy = vi.spyOn(mockClient, "sendLinkCard").mockResolvedValue({ success: true, messageId: "m1" });
    const result = await api._tools["lansenger_send_link_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  title: "T", link: "https://x.com", to: "chat-1" });
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", "T", "https://x.com", {
      description: "",
      iconLink: "",
      pcLink: "",
      fromName: "",
      fromIconLink: "",
    });
  });
});

describe("happy path: lansenger_send_app_articles", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends app articles successfully", async () => {
    const articles = [{ imgUrl: "i", title: "t", url: "u" }];
    const sendSpy = vi.spyOn(mockClient, "sendAppArticles").mockResolvedValue({ success: true, messageId: "m1" });
    const result = await api._tools["lansenger_send_app_articles"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  articles, to: "chat-1" });
    expect(parseResult(result).success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("chat-1", articles);
  });
});

describe("happy path: lansenger_query_groups", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("queries groups successfully", async () => {
    const querySpy = vi.spyOn(mockClient, "queryGroups").mockResolvedValue({ totalGroupIds: 5, groupIds: ["g1", "g2"] });
    const result = await api._tools["lansenger_query_groups"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", });
    expect(parseResult(result).success).toBe(true);
    expect(querySpy).toHaveBeenCalledWith(0, 100);
  });
});

describe("happy path: lansenger_update_dynamic_card", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("updates dynamic card successfully", async () => {
    const updateSpy = vi.spyOn(mockClient, "updateDynamicCard").mockResolvedValue({ success: true });
    const result = await api._tools["lansenger_update_dynamic_card"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id",  msgId: "m1" });
    expect(parseResult(result).success).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith("m1", undefined, undefined, false);
  });
});

describe("lansenger_group_info", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_group_info"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when API returns null", async () => {
    vi.spyOn(mockClient, "getGroupInfo").mockResolvedValue(null);
    const result = await api._tools["lansenger_group_info"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    expect(parseResult(result).error).toContain("Failed to get group info");
  });
});

describe("happy path: lansenger_group_info", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns group info successfully", async () => {
    const info = { name: "Test Group", avatarUrl: "https://img.com/a.png", description: "desc", state: 0, totalMembers: 42 };
    vi.spyOn(mockClient, "getGroupInfo").mockResolvedValue(info);
    const result = await api._tools["lansenger_group_info"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.groupId).toBe("g1");
    expect(parsed.name).toBe("Test Group");
    expect(parsed.totalMembers).toBe(42);
  });
});

describe("lansenger_group_members", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_group_members"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when API returns null", async () => {
    vi.spyOn(mockClient, "getGroupMembers").mockResolvedValue(null);
    const result = await api._tools["lansenger_group_members"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    expect(parseResult(result).error).toContain("Failed to get group members");
  });
});

describe("happy path: lansenger_group_members", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns member list successfully with defaults", async () => {
    const data = { totalMembers: 3, members: [{ status: 1, staffId: "u1", name: "Alice", role: 2 }] };
    vi.spyOn(mockClient, "getGroupMembers").mockResolvedValue(data);
    const result = await api._tools["lansenger_group_members"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.groupId).toBe("g1");
    expect(parsed.totalMembers).toBe(3);
    expect(parsed.members).toEqual(data.members);
  });

  it("passes pagination params", async () => {
    const spy = vi.spyOn(mockClient, "getGroupMembers").mockResolvedValue({ totalMembers: 100, members: [] });
    await api._tools["lansenger_group_members"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1", pageOffset: 2, pageSize: 50 });
    expect(spy).toHaveBeenCalledWith("g1", 2, 50);
  });
});

describe("lansenger_group_check_membership", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_group_check_membership"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1", staffId: "u1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when API returns null", async () => {
    vi.spyOn(mockClient, "checkMembership").mockResolvedValue(null);
    const result = await api._tools["lansenger_group_check_membership"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1", staffId: "u1" });
    expect(parseResult(result).error).toContain("Failed to check membership");
  });
});

describe("happy path: lansenger_group_check_membership", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns isInGroup=true when member exists", async () => {
    vi.spyOn(mockClient, "checkMembership").mockResolvedValue(true);
    const result = await api._tools["lansenger_group_check_membership"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1", staffId: "u1" });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.isInGroup).toBe(true);
    expect(parsed.staffId).toBe("u1");
  });

  it("returns isInGroup=false when member does not exist", async () => {
    vi.spyOn(mockClient, "checkMembership").mockResolvedValue(false);
    const result = await api._tools["lansenger_group_check_membership"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1", staffId: "u2" });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.isInGroup).toBe(false);
  });

  it("omits staffId param when not provided (checks bot itself)", async () => {
    const spy = vi.spyOn(mockClient, "checkMembership").mockResolvedValue(true);
    await api._tools["lansenger_group_check_membership"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1",  appId: "test-id", groupId: "g1" });
    expect(spy).toHaveBeenCalledWith("g1", undefined);
  });
});

describe("lansenger_download_media", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when account not running", async () => {
    mockNotRunning();
    const api2 = makeMockApi();
    registerLansengerTools(api2);
    const tool = api2._tools["lansenger_download_media"];
    expect(tool).toBeDefined();
    const result = await tool.execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1", appId: "test-id", mediaId: "media-1" });
    expect(parseResult(result).error).toContain("not configured or not running");
  });

  it("returns error when mediaId missing", async () => {
    const result = await api._tools["lansenger_download_media"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1", appId: "test-id" });
    expect(parseResult(result).error).toContain("mediaId is required");
  });

  it("returns error when download fails", async () => {
    vi.spyOn(mockClient, "downloadMedia").mockResolvedValue(null);
    const result = await api._tools["lansenger_download_media"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1", appId: "test-id", mediaId: "media-1" });
    expect(parseResult(result).error).toContain("Failed to download media");
  });

  it("returns error when saveMediaToTemp fails", async () => {
    vi.spyOn(mockClient, "downloadMedia").mockResolvedValue({ bytes: Buffer.from("data"), ext: ".txt", fname: "file.txt" });
    vi.spyOn(mockClient, "saveMediaToTemp").mockResolvedValue(null);
    const result = await api._tools["lansenger_download_media"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1", appId: "test-id", mediaId: "media-1" });
    expect(parseResult(result).error).toContain("Failed to save downloaded media");
  });
});

describe("happy path: lansenger_download_media", () => {
  let api: any;
  beforeEach(() => { api = makeMockApi(); mockRunning(); registerLansengerTools(api); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("downloads media successfully and returns filePath", async () => {
    vi.spyOn(mockClient, "downloadMedia").mockResolvedValue({ bytes: Buffer.from("data"), ext: ".pdf", fname: "report.pdf" });
    vi.spyOn(mockClient, "saveMediaToTemp").mockResolvedValue("/tmp/lansenger_media_abc123_report.pdf");
    const result = await api._tools["lansenger_download_media"].execute("tc1", { _sessionKey: "agent:test:lansenger:dm:user1", appId: "test-id", mediaId: "media-1" });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.mediaId).toBe("media-1");
    expect(parsed.filePath).toContain("/tmp/lansenger_media_");
    expect(parsed.fileName).toBe("report.pdf");
  });
});
