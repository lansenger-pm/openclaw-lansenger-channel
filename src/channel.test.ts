import { describe, it, expect } from "vitest";
import { lansengerPlugin, resolveAccount } from "./channel.js";
import { LansengerClient, mediaTypeFromPath, buildI18n } from "./client.js";

const lansengerOnboarding = (lansengerPlugin as any).onboarding;

describe("lansenger plugin", () => {
  it("resolves account from config", () => {
    const cfg = {
      channels: {
        lansenger: { appId: "test-app-id", appSecret: "test-secret", allowFrom: ["user1"] },
      },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.appId).toBe("test-app-id");
    expect(account.appSecret).toBe("test-secret");
    expect(account.allowFrom).toEqual(["user1"]);
    expect(account.enabled).toBe(true);
  });

  it("falls back to env vars", () => {
    const origId = process.env.LANSENGER_APP_ID;
    const origSecret = process.env.LANSENGER_APP_SECRET;
    process.env.LANSENGER_APP_ID = "env-app-id";
    process.env.LANSENGER_APP_SECRET = "env-secret";
    const cfg = { channels: {} } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.appId).toBe("env-app-id");
    expect(account.appSecret).toBe("env-secret");
    expect(account.enabled).toBe(true);
    if (origId === undefined) delete process.env.LANSENGER_APP_ID;
    else process.env.LANSENGER_APP_ID = origId;
    if (origSecret === undefined) delete process.env.LANSENGER_APP_SECRET;
    else process.env.LANSENGER_APP_SECRET = origSecret;
  });

  it("reports missing config", () => {
    const origId = process.env.LANSENGER_APP_ID;
    const origSecret = process.env.LANSENGER_APP_SECRET;
    delete process.env.LANSENGER_APP_ID;
    delete process.env.LANSENGER_APP_SECRET;
    const cfg = { channels: {} } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.enabled).toBe(false);
    if (origId === undefined) delete process.env.LANSENGER_APP_ID;
    else process.env.LANSENGER_APP_ID = origId;
    if (origSecret === undefined) delete process.env.LANSENGER_APP_SECRET;
    else process.env.LANSENGER_APP_SECRET = origSecret;
  });

  it("has correct plugin id", () => {
    expect(lansengerPlugin.id).toBe("lansenger");
  });
});

describe("LansengerClient", () => {
  it("constructs with default gateway URL", () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    expect(client).toBeDefined();
  });

  it("constructs with custom gateway URL", () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret", apiGatewayUrl: "https://custom.url" });
    expect(client).toBeDefined();
  });
});

describe("mediaTypeFromPath", () => {
  it("detects images", () => {
    expect(mediaTypeFromPath("photo.jpg")).toBe(2);
    expect(mediaTypeFromPath("photo.png")).toBe(2);
    expect(mediaTypeFromPath("photo.gif")).toBe(2);
    expect(mediaTypeFromPath("photo.webp")).toBe(2);
  });

  it("detects videos", () => {
    expect(mediaTypeFromPath("clip.mp4")).toBe(1);
    expect(mediaTypeFromPath("clip.mov")).toBe(1);
  });

  it("detects files", () => {
    expect(mediaTypeFromPath("doc.pdf")).toBe(3);
    expect(mediaTypeFromPath("data.xlsx")).toBe(3);
    expect(mediaTypeFromPath("archive.zip")).toBe(3);
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

describe("processRawMessage", () => {
  it("parses text message from raw JSON", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const raw = JSON.stringify({
      events: [
        {
          data: {
            msgType: "text",
            messageId: "msg-123",
            chatType: "p2p",
            from: "user-1",
            conversationId: "conv-1",
            senderName: "Alice",
            msgData: { text: { content: "Hello!" } },
          },
        },
      ],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("Hello!");
    expect(events[0]!.senderId).toBe("user-1");
    expect(events[0]!.isGroup).toBe(false);
  });

  it("handles group messages", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const raw = JSON.stringify({
      events: [
        {
          data: {
            msgType: "text",
            messageId: "msg-456",
            chatType: "group",
            from: "user-2",
            conversationId: "group-1",
            conversationTitle: "Team Chat",
            senderName: "Bob",
            msgData: { text: { content: "Hi team!" } },
          },
        },
      ],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.isGroup).toBe(true);
    expect(events[0]!.chatName).toBe("Team Chat");
  });

  it("skips empty text messages", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const raw = JSON.stringify({
      events: [
        {
          data: {
            msgType: "text",
            messageId: "msg-empty",
            msgData: { text: { content: "" } },
          },
        },
      ],
    });
    const events = await client.processRawMessage(raw);
    expect(events.length).toBe(0);
  });

  it("handles invalid JSON", async () => {
    const client = new LansengerClient({ appId: "id", appSecret: "secret" });
    const events = await client.processRawMessage("not json");
    expect(events.length).toBe(0);
  });
});

describe("lansengerOnboarding", () => {
  it("configuredCheck returns true when both appId and appSecret present", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    expect(lansengerOnboarding.configuredCheck(cfg)).toBe(true);
  });

  it("configuredCheck returns false when missing appId", () => {
    const cfg = { channels: { lansenger: { appSecret: "secret" } } };
    expect(lansengerOnboarding.configuredCheck(cfg)).toBe(false);
  });

  it("configuredCheck returns false when missing appSecret", () => {
    const cfg = { channels: { lansenger: { appId: "id" } } };
    expect(lansengerOnboarding.configuredCheck(cfg)).toBe(false);
  });

  it("configuredCheck returns false when section missing", () => {
    const cfg = { channels: {} };
    expect(lansengerOnboarding.configuredCheck(cfg)).toBe(false);
  });

  it("setDmPolicy merges dmSecurity into config", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = lansengerOnboarding.setDmPolicy(cfg, "open");
    expect(result.channels.lansenger.dmSecurity).toBe("open");
  });

  it("setDmPolicy preserves existing fields", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret", allowFrom: ["u1"] } } };
    const result = lansengerOnboarding.setDmPolicy(cfg, "paired");
    expect(result.channels.lansenger.appId).toBe("id");
    expect(result.channels.lansenger.allowFrom).toEqual(["u1"]);
    expect(result.channels.lansenger.dmSecurity).toBe("paired");
  });

  it("promptAllowFrom adds new ID with dedup", async () => {
    const mockPrompter = {
      text: async () => "user-new",
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret", allowFrom: ["user-old"] } } };
    const result = await lansengerOnboarding.promptAllowFrom({ cfg, prompter: mockPrompter, accountId: null });
    expect(result.channels.lansenger.allowFrom).toEqual(["user-old", "user-new"]);
    expect(result.channels.lansenger.enabled).toBe(true);
    expect(result.channels.lansenger.dmSecurity).toBe("paired");
  });

  it("promptAllowFrom deduplicates existing entries", async () => {
    const mockPrompter = {
      text: async () => "user-old",
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret", allowFrom: ["user-old"] } } };
    const result = await lansengerOnboarding.promptAllowFrom({ cfg, prompter: mockPrompter, accountId: null });
    expect(result.channels.lansenger.allowFrom).toEqual(["user-old"]);
  });

  it("promptAllowFrom sets dmSecurity to paired when missing", async () => {
    const mockPrompter = {
      text: async () => "u1",
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = await lansengerOnboarding.promptAllowFrom({ cfg, prompter: mockPrompter, accountId: null });
    expect(result.channels.lansenger.dmSecurity).toBe("paired");
  });

  it("noteSetupHelp calls prompter.note", async () => {
    let noted = false;
    const mockPrompter = {
      text: async () => "",
      confirm: async () => true,
      select: async () => "",
      note: async () => { noted = true; },
    };
    await lansengerOnboarding.noteSetupHelp({ cfg: {}, prompter: mockPrompter, accountId: null });
    expect(noted).toBe(true);
  });

  it("runSetupWizard with token sets appId and appSecret", async () => {
    const mockPrompter = {
      text: async () => "",
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: {} };
    const result = await lansengerOnboarding.runSetupWizard({ cfg, prompter: mockPrompter, token: "my-app-id:my-secret" });
    expect(result.channels.lansenger.appId).toBe("my-app-id");
    expect(result.channels.lansenger.appSecret).toBe("my-secret");
    expect(result.channels.lansenger.enabled).toBe(true);
    expect(result.channels.lansenger.dmSecurity).toBe("paired");
    expect(result.channels.lansenger.approval.enabled).toBe(true);
  });

  it("runSetupWizard prompts for credentials when not configured and no token", async () => {
    let prompts = 0;
    const mockPrompter = {
      text: async () => { prompts++; return prompts === 1 ? "new-id" : "new-secret"; },
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: {} };
    const result = await lansengerOnboarding.runSetupWizard({ cfg, prompter: mockPrompter, token: undefined });
    expect(result.channels.lansenger.appId).toBe("new-id");
    expect(result.channels.lansenger.appSecret).toBe("new-secret");
    expect(result.channels.lansenger.enabled).toBe(true);
  });

  it("runSetupWizard keeps existing credentials when user confirms", async () => {
    const mockPrompter = {
      text: async () => "",
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: { lansenger: { appId: "existing-id", appSecret: "existing-secret", allowFrom: ["u1"] } } };
    const result = await lansengerOnboarding.runSetupWizard({ cfg, prompter: mockPrompter, token: undefined });
    expect(result.channels.lansenger.appId).toBe("existing-id");
    expect(result.channels.lansenger.appSecret).toBe("existing-secret");
    expect(result.channels.lansenger.allowFrom).toEqual(["u1"]);
  });

  it("runSetupWizard replaces credentials when user declines keep", async () => {
    let prompts = 0;
    const mockPrompter = {
      text: async () => { prompts++; return prompts === 1 ? "replaced-id" : "replaced-secret"; },
      confirm: async () => false,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: { lansenger: { appId: "old-id", appSecret: "old-secret" } } };
    const result = await lansengerOnboarding.runSetupWizard({ cfg, prompter: mockPrompter, token: undefined });
    expect(result.channels.lansenger.appId).toBe("replaced-id");
    expect(result.channels.lansenger.appSecret).toBe("replaced-secret");
  });
});