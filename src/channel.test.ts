import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lansengerPlugin, resolveAccount, pendingApprovalCards, resolveLansengerApprovers } from "./channel.js";
import { LansengerClient, mediaTypeFromPath, uploadMediaTypeFromPath, buildI18n } from "./client.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const lansengerOnboarding = (lansengerPlugin as any).onboarding;
const configObj = (lansengerPlugin as any).config ?? (lansengerPlugin as any).base?.config;

describe("Lansenger plugin", () => {
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

  it("resolves account from accounts by accountId", () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "default-id",
          appSecret: "default-secret",
          accounts: {
            "bot1-id": { appId: "bot1-id", appSecret: "bot1-secret" },
            "bot2-id": { appId: "bot2-id", appSecret: "bot2-secret" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot2-id");
    expect(account.appId).toBe("bot2-id");
    expect(account.appSecret).toBe("bot2-secret");
    expect(account.accountId).toBe("bot2-id");
  });

  it("falls back to top-level when accountId not in accounts", () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "default-id",
          appSecret: "default-secret",
          accounts: {
            "bot1-id": { appId: "bot1-id", appSecret: "bot1-secret" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.appId).toBe("bot1-id");
    expect(account.appSecret).toBe("bot1-secret");
    expect(account.accountId).toBe("bot1-id");
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

describe("uploadMediaTypeFromPath", () => {
  it("detects images", () => {
    expect(uploadMediaTypeFromPath("photo.jpg")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.png")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.gif")).toBe("image");
    expect(uploadMediaTypeFromPath("photo.webp")).toBe("image");
  });

  it("detects videos", () => {
    expect(uploadMediaTypeFromPath("clip.mp4")).toBe("video");
    expect(uploadMediaTypeFromPath("clip.mov")).toBe("video");
  });

  it("detects audio", () => {
    expect(uploadMediaTypeFromPath("song.mp3")).toBe("audio");
    expect(uploadMediaTypeFromPath("song.amr")).toBe("audio");
  });

  it("defaults to file", () => {
    expect(uploadMediaTypeFromPath("doc.pdf")).toBe("file");
    expect(uploadMediaTypeFromPath("data.xlsx")).toBe("file");
    expect(uploadMediaTypeFromPath("archive.zip")).toBe("file");
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

describe("LansengerOnboarding", () => {
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

  it("setDmPolicy merges dmPolicy into config", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = lansengerOnboarding.setDmPolicy(cfg, "open");
    expect(result.channels.lansenger.dmPolicy).toBe("open");
  });

  it("setDmPolicy preserves existing fields", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret", allowFrom: ["u1"] } } };
    const result = lansengerOnboarding.setDmPolicy(cfg, "pairing");
    expect(result.channels.lansenger.appId).toBe("id");
    expect(result.channels.lansenger.allowFrom).toEqual(["u1"]);
    expect(result.channels.lansenger.dmPolicy).toBe("pairing");
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
    expect(result.channels.lansenger.dmPolicy).toBe("pairing");
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

  it("promptAllowFrom sets dmPolicy to pairing when missing", async () => {
    const mockPrompter = {
      text: async () => "u1",
      confirm: async () => true,
      select: async () => "",
      note: async () => {},
    };
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = await lansengerOnboarding.promptAllowFrom({ cfg, prompter: mockPrompter, accountId: null });
    expect(result.channels.lansenger.dmPolicy).toBe("pairing");
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
    expect(result.channels.lansenger.dmPolicy).toBe("pairing");
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

describe("resolveAccount edge cases", () => {
  it("falls back to first valid account in accounts when no accountId specified", () => {
    const cfg = {
      channels: {
        lansenger: {
          accounts: {
            "key1": { appId: "first-id", appSecret: "first-secret" },
            "key2": { appId: "second-id", appSecret: "second-secret" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.appId).toBe("first-id");
  });

  it("falls back to first account (even without valid creds) when no valid account found", () => {
    const cfg = {
      channels: {
        lansenger: {
          accounts: {
            "key1": { appId: "only-id" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.accountId).toBe("key1");
    expect(account.appId).toBe("only-id");
    expect(account.appSecret).toBe("");
    expect(account.enabled).toBe(false);
  });

  it("resolves dmPolicy from dmSecurity fallback", () => {
    const cfg = {
      channels: {
        lansenger: { appId: "id", appSecret: "secret", dmSecurity: "paired" },
      },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.dmPolicy).toBe("paired");
  });

  it("resolves apiGatewayUrl from env var", () => {
    const orig = process.env.LANSENGER_API_GATEWAY_URL;
    process.env.LANSENGER_API_GATEWAY_URL = "https://custom.gateway";
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.apiGatewayUrl).toBe("https://custom.gateway");
    if (orig === undefined) delete process.env.LANSENGER_API_GATEWAY_URL;
    else process.env.LANSENGER_API_GATEWAY_URL = orig;
  });

  it("enabled is false when only appId provided", () => {
    const cfg = { channels: { lansenger: { appId: "id" } } } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.enabled).toBe(false);
  });

  it("enabled is false when only appSecret provided", () => {
    const cfg = { channels: { lansenger: { appSecret: "secret" } } } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.enabled).toBe(false);
  });

  it("extracts execApprovals from account config", () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "id", appSecret: "secret",
          execApprovals: { approvers: ["user-1", "user-2"] },
        },
      },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.execApprovals).toEqual({ approvers: ["user-1", "user-2"] });
  });

  it("execApprovals is undefined when not configured", () => {
    const cfg = {
      channels: { lansenger: { appId: "id", appSecret: "secret" } },
    } as any;
    const account = resolveAccount(cfg, undefined);
    expect(account.execApprovals).toBeUndefined();
  });
});

describe("resolveAccount config inheritance", () => {
  // -------------------------------------------------------------------
  // Multi-account mode: section = top-level, account = sub-account entry.
  // Priority rules:
  //   SDK-managed security fields: section ?? account  (section wins)
  //   Channel-behavior fields:     account ?? section  (account wins)
  //   apiGatewayUrl:               account ?? section  (account wins)
  // -------------------------------------------------------------------

  it("allowFrom: section overrides account (SDK security field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          allowFrom: ["section-user-1", "section-user-2"],
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", allowFrom: ["account-user"] },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.allowFrom).toEqual(["section-user-1", "section-user-2"]);
  });

  it("allowFrom: falls back to account when section not set", () => {
    const cfg = {
      channels: {
        lansenger: {
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", allowFrom: ["account-user"] },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.allowFrom).toEqual(["account-user"]);
  });

  it("allowFrom: empty array at account does NOT override section non-empty", () => {
    const cfg = {
      channels: {
        lansenger: {
          allowFrom: ["section-user"],
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", allowFrom: [] },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.allowFrom).toEqual(["section-user"]);
  });

  it("dmPolicy: section overrides account (SDK security field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          dmPolicy: "open",
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", dmPolicy: "disabled" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.dmPolicy).toBe("open");
  });

  it("dmPolicy: falls back to account when section not set", () => {
    const cfg = {
      channels: {
        lansenger: {
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", dmPolicy: "allowlist" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("dmPolicy: section dmSecurity fallback before account dmPolicy", () => {
    const cfg = {
      channels: {
        lansenger: {
          dmSecurity: "paired",
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", dmPolicy: "open" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    // section.dmSecurity wins over account.dmPolicy
    expect(account.dmPolicy).toBe("paired");
  });

  it("mediaLocalRoots: section overrides account (SDK security field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          mediaLocalRoots: ["/section/root"],
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", mediaLocalRoots: ["/account/root"] },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.mediaLocalRoots).toEqual(["/section/root"]);
  });

  it("mediaLocalRoots: falls back to account when section not set", () => {
    const cfg = {
      channels: {
        lansenger: {
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", mediaLocalRoots: ["/account/root"] },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.mediaLocalRoots).toEqual(["/account/root"]);
  });

  it("autoMentionReply: account overrides section (channel behavior field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          autoMentionReply: false,
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", autoMentionReply: true },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.autoMentionReply).toBe(true);
  });

  it("autoMentionReply: inherits section when account not set", () => {
    const cfg = {
      channels: {
        lansenger: {
          autoMentionReply: true,
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.autoMentionReply).toBe(true);
  });

  it("autoMentionReply: defaults to false when neither section nor account set", () => {
    const cfg = {
      channels: {
        lansenger: {
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.autoMentionReply).toBe(false);
  });

  it("autoQuoteReply: account overrides section (channel behavior field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          autoQuoteReply: false,
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", autoQuoteReply: true },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.autoQuoteReply).toBe(true);
  });

  it("ackMessage: account overrides section (channel behavior field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          ackMessage: true,
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", ackMessage: false },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.ackMessage).toBe(false);
  });

  it("ackMessage: inherits section when account not set", () => {
    const cfg = {
      channels: {
        lansenger: {
          ackMessage: true,
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.ackMessage).toBe(true);
  });

  it("apiGatewayUrl: account overrides section", () => {
    const cfg = {
      channels: {
        lansenger: {
          apiGatewayUrl: "https://section.example.com",
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", apiGatewayUrl: "https://account.example.com" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.apiGatewayUrl).toBe("https://account.example.com");
  });

  it("apiGatewayUrl: inherits section when account not set", () => {
    const cfg = {
      channels: {
        lansenger: {
          apiGatewayUrl: "https://section.example.com",
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.apiGatewayUrl).toBe("https://section.example.com");
  });

  it("homeChannel: section overrides account", () => {
    const cfg = {
      channels: {
        lansenger: {
          homeChannel: "section-owner",
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", homeChannel: "account-owner" },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.homeChannel).toBe("section-owner");
  });

  it("respondToAtAll: account overrides section (channel behavior field)", () => {
    const cfg = {
      channels: {
        lansenger: {
          respondToAtAll: false,
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1", respondToAtAll: true },
          },
        },
      },
    } as any;
    const account = resolveAccount(cfg, "bot1");
    expect(account.respondToAtAll).toBe(true);
  });
});

describe("config callbacks", () => {

  it("isConfigured returns true with appId+appSecret", () => {
    const account = { appId: "id", appSecret: "secret", enabled: true, allowFrom: [], dmPolicy: undefined, homeChannel: undefined, apiGatewayUrl: "", accountId: null };
    expect(configObj.isConfigured(account, {} as any)).toBe(true);
  });

  it("isConfigured returns true with configured=true", () => {
    const account = { appId: "", appSecret: "", configured: true, enabled: false, allowFrom: [], dmPolicy: undefined, homeChannel: undefined, apiGatewayUrl: "", accountId: null };
    expect(configObj.isConfigured(account, {} as any)).toBe(true);
  });

  it("isConfigured returns false with no creds", () => {
    const account = { appId: "", appSecret: "", enabled: false, allowFrom: [], dmPolicy: undefined, homeChannel: undefined, apiGatewayUrl: "", accountId: null };
    expect(configObj.isConfigured(account, {} as any)).toBe(false);
  });

  it("hasConfiguredState returns true with accounts", () => {
    const cfg = { channels: { lansenger: { accounts: { "bot1": { appId: "b1", appSecret: "s1" } } } } } as any;
    expect(configObj.hasConfiguredState({ cfg, env: {} })).toBe(true);
  });

  it("hasConfiguredState returns true with env vars", () => {
    const origId = process.env.LANSENGER_APP_ID;
    const origSecret = process.env.LANSENGER_APP_SECRET;
    process.env.LANSENGER_APP_ID = "env-id";
    process.env.LANSENGER_APP_SECRET = "env-secret";
    const cfg = { channels: {} } as any;
    expect(configObj.hasConfiguredState({ cfg, env: { LANSENGER_APP_ID: "env-id", LANSENGER_APP_SECRET: "env-secret" } })).toBe(true);
    if (origId === undefined) delete process.env.LANSENGER_APP_ID;
    else process.env.LANSENGER_APP_ID = origId;
    if (origSecret === undefined) delete process.env.LANSENGER_APP_SECRET;
    else process.env.LANSENGER_APP_SECRET = origSecret;
  });

  it("hasConfiguredState returns false with no creds", () => {
    const cfg = { channels: {} } as any;
    expect(configObj.hasConfiguredState({ cfg, env: {} })).toBe(false);
  });

  it("listAccountIds returns single appId", () => {
    const cfg = { channels: { lansenger: { appId: "single-id" } } } as any;
    expect(configObj.listAccountIds(cfg)).toEqual(["single-id"]);
  });

  it("listAccountIds returns multi-account appIds", () => {
    const cfg = { channels: { lansenger: { accounts: { "key1": { appId: "bot1" }, "key2": { appId: "bot2" } } } } } as any;
    expect(configObj.listAccountIds(cfg)).toEqual(["bot1", "bot2"]);
  });

  it("listAccountIds deduplicates", () => {
    const cfg = { channels: { lansenger: { appId: "bot1", accounts: { "key1": { appId: "bot1" } } } } } as any;
    const ids = configObj.listAccountIds(cfg);
    expect(ids.filter((id: string) => id === "bot1").length).toBe(1);
  });

  it("inspectAccount returns configured for default account", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } } as any;
    const result = configObj.inspectAccount(cfg, undefined);
    expect(result.configured).toBe(true);
    expect(result.appIdStatus).toBe("available");
    expect(result.appSecretStatus).toBe("available");
  });

  it("inspectAccount returns env status when missing from config", () => {
    const origId = process.env.LANSENGER_APP_ID;
    const origSecret = process.env.LANSENGER_APP_SECRET;
    delete process.env.LANSENGER_APP_ID;
    delete process.env.LANSENGER_APP_SECRET;
    const cfg = { channels: { lansenger: {} } } as any;
    const result = configObj.inspectAccount(cfg, undefined);
    expect(result.appIdStatus).toBe("missing");
    expect(result.appSecretStatus).toBe("missing");
    if (origId === undefined) delete process.env.LANSENGER_APP_ID;
    else process.env.LANSENGER_APP_ID = origId;
    if (origSecret === undefined) delete process.env.LANSENGER_APP_SECRET;
    else process.env.LANSENGER_APP_SECRET = origSecret;
  });

  it("inspectAccount looks up account by appId key in accounts", () => {
    const cfg = { channels: { lansenger: { accounts: { "bot1": { appId: "bot1", appSecret: "s1" } } } } } as any;
    const result = configObj.inspectAccount(cfg, "bot1");
    expect(result.configured).toBe(true);
  });

  it("inspectAccount finds account by appId match across accounts", () => {
    const cfg = { channels: { lansenger: { accounts: { "key1": { appId: "target-id", appSecret: "s1" } } } } } as any;
    const result = configObj.inspectAccount(cfg, "target-id");
    expect(result.configured).toBe(true);
  });
});

describe("applyAccountConfig", () => {
  const applyAccountConfig = (lansengerPlugin as any).setup?.applyAccountConfig ?? (lansengerPlugin as any).base?.setup?.applyAccountConfig;

  it("patches appId into config", () => {
    const cfg = { channels: { lansenger: { appSecret: "existing-secret" } } } as any;
    const result = applyAccountConfig({ cfg, accountId: undefined, input: { appToken: "new-app-id" } });
    expect(result.channels.lansenger.appId).toBe("new-app-id");
    expect(result.channels.lansenger.appSecret).toBe("existing-secret");
  });

  it("patches secret into config", () => {
    const cfg = { channels: { lansenger: { appId: "existing-id" } } } as any;
    const result = applyAccountConfig({ cfg, accountId: undefined, input: { secret: "new-secret" } });
    expect(result.channels.lansenger.appId).toBe("existing-id");
    expect(result.channels.lansenger.appSecret).toBe("new-secret");
  });

  it("patches baseUrl into config", () => {
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } } as any;
    const result = applyAccountConfig({ cfg, accountId: undefined, input: { baseUrl: "https://custom.url" } });
    expect(result.channels.lansenger.apiGatewayUrl).toBe("https://custom.url");
  });
});

describe("actions.describeMessageTool", () => {
  it("returns null when account not enabled", () => {
    const result = (lansengerPlugin as any).actions.describeMessageTool({ cfg: { channels: { lansenger: {} } }, accountId: undefined, senderIsOwner: false });
    expect(result).toBeNull();
  });

  it("returns actions schema when account enabled", () => {
    const result = (lansengerPlugin as any).actions.describeMessageTool({ cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, accountId: undefined, senderIsOwner: false });
    expect(result).toBeDefined();
    expect(result.actions).toContain("send");
    expect(result.actions).toContain("delete");
    expect(result.schema[0].properties.filePath).toBeDefined();
  });
});

describe("actions.handleAction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("apptoken")) return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { appToken: "tok", expiresIn: 7200 } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ errCode: 0, errMsg: "", data: { msgId: "m1" } }), { headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error for unknown action", async () => {
    const ctx = { action: "unknown", cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, args: {} };
    const result = await (lansengerPlugin as any).actions.handleAction(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  it("returns error for send without to and text", async () => {
    const ctx = { action: "send", cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, args: {} };
    const result = await (lansengerPlugin as any).actions.handleAction(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("to and text are required");
  });

  it("returns error for send with filePath not found", async () => {
    const ctx = { action: "send", cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, args: { filePath: "/tmp/nonexistent_handle.txt", to: "chat-1" } };
    const result = await (lansengerPlugin as any).actions.handleAction(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("returns error for send with filePath pointing to directory", async () => {
    const ctx = { action: "send", cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, args: { filePath: "/tmp", to: "chat-1" } };
    const result = await (lansengerPlugin as any).actions.handleAction(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not a file");
  });

  it("delete action revokes message", async () => {
    const ctx = { action: "delete", cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, args: { messageId: "msg-to-delete" } };
    const result = await (lansengerPlugin as any).actions.handleAction(ctx);
    expect(result.success).toBeDefined();
  });

  it("send resolves target from sessionKey", async () => {
    const ctx = { action: "send", cfg: { channels: { lansenger: { appId: "id", appSecret: "secret" } } }, args: { text: "hello" }, sessionKey: "lansenger:agent-1:chat-from-session" };
    const result = await (lansengerPlugin as any).actions.handleAction(ctx);
    expect(result).toBeDefined();
  });
});

describe("resolveLansengerApprovers", () => {
  it("Priority 1: returns execApprovals.approvers from account config", () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "id", appSecret: "secret",
          execApprovals: { approvers: ["approver-from-exec"] },
        },
      },
      commands: { ownerAllowFrom: ["approver-from-commands"] },
    } as any;
    const result = resolveLansengerApprovers({ cfg, accountId: undefined });
    expect(result).toEqual(["approver-from-exec"]);
  });

  it("Priority 2: falls back to commands.ownerAllowFrom when no execApprovals", () => {
    const cfg = {
      channels: { lansenger: { appId: "id", appSecret: "secret" } },
      commands: { ownerAllowFrom: ["approver-1", "lansenger:approver-2"] },
    } as any;
    const result = resolveLansengerApprovers({ cfg, accountId: undefined });
    expect(result).toEqual(["approver-1", "approver-2"]);
  });

  it("strips lansenger: prefix from ownerAllowFrom entries", () => {
    const cfg = {
      channels: { lansenger: { appId: "id", appSecret: "secret" } },
      commands: { ownerAllowFrom: ["lansenger:user-a", "user-b"] },
    } as any;
    const result = resolveLansengerApprovers({ cfg, accountId: undefined });
    expect(result).toEqual(["user-a", "user-b"]);
  });

  it("Priority 3: falls back to allowFrom when no execApprovals or ownerAllowFrom", () => {
    const cfg = {
      channels: {
        lansenger: { appId: "id", appSecret: "secret", allowFrom: ["from-allow"] },
      },
    } as any;
    const result = resolveLansengerApprovers({ cfg, accountId: undefined });
    expect(result).toEqual(["from-allow"]);
  });

  it("Priority 4: falls back to homeChannel as last resort", () => {
    const cfg = {
      channels: {
        lansenger: { appId: "id", appSecret: "secret", homeChannel: "home-user" },
      },
    } as any;
    const result = resolveLansengerApprovers({ cfg, accountId: undefined });
    expect(result).toEqual(["home-user"]);
  });

  it("returns empty array when nothing configured", () => {
    const cfg = {
      channels: { lansenger: { appId: "id", appSecret: "secret" } },
    } as any;
    const result = resolveLansengerApprovers({ cfg, accountId: undefined });
    expect(result).toEqual([]);
  });
});

describe("approvalCapability", () => {
  it("getActionAvailabilityState returns enabled for configured account", () => {
    const getActionAvailabilityState = (lansengerPlugin as any).approvalCapability?.getActionAvailabilityState;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = getActionAvailabilityState({ cfg, accountId: undefined });
    expect(result.kind).toBe("enabled");
  });

  it("getActionAvailabilityState returns unsupported for unconfigured account", () => {
    const getActionAvailabilityState = (lansengerPlugin as any).approvalCapability?.getActionAvailabilityState;
    const cfg = { channels: { lansenger: {} } };
    const result = getActionAvailabilityState({ cfg, accountId: undefined });
    expect(result.kind).toBe("unsupported");
  });

  it("describeDeliveryCapabilities returns enabled", () => {
    const desc = (lansengerPlugin as any).approvalCapability?.native?.describeDeliveryCapabilities;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = desc({ cfg, accountId: undefined });
    expect(result.enabled).toBe(true);
    expect(result.preferredSurface).toBe("origin");
  });

  it("resolveOriginTarget returns target from request", () => {
    const resolve = (lansengerPlugin as any).approvalCapability?.native?.resolveOriginTarget;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = resolve({ cfg, accountId: undefined, request: { id: "test-id", request: { turnSourceTo: "chat-1" }, createdAtMs: 0, expiresAtMs: 0 } });
    expect(result).toBeDefined();
    expect(result!.to).toBe("chat-1");
  });

  it("resolveOriginTarget returns null when no target", () => {
    const resolve = (lansengerPlugin as any).approvalCapability?.native?.resolveOriginTarget;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = resolve({ cfg, accountId: undefined, request: { id: "test-id", request: { sessionKey: "s1" }, createdAtMs: 0, expiresAtMs: 0 } });
    expect(result).toBeNull();
  });

  it("delivery.shouldSuppressForwardingFallback returns true", () => {
    const suppress = (lansengerPlugin as any).approvalCapability?.delivery?.shouldSuppressForwardingFallback;
    expect(suppress).toBeDefined();
    const result = suppress({ cfg: {}, approvalKind: "exec", target: { channel: "lansenger" }, request: { id: "test-id" } });
    expect(result).toBe(true);
  });

  it("buildPendingPayload returns appCard type", () => {
    const build = (lansengerPlugin as any).approvalCapability?.nativeRuntime?.presentation?.buildPendingPayload;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = build({ cfg, request: { command: "rm -rf /", sessionKey: "sess-1" }, target: { to: "chat-1" }, nowMs: Date.now() });
    expect(result.type).toBe("approveCard");
    expect(result.zh).toBeDefined();
    expect(result.en).toBeDefined();
    expect(result.isDynamic).toBe(true);
  });

  it("buildResolvedResult returns update action for approved", () => {
    const build = (lansengerPlugin as any).approvalCapability?.nativeRuntime?.presentation?.buildResolvedResult;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = build({ cfg, resolved: { kind: "approved", actorLabel: "admin" }, entry: {} });
    expect(result.kind).toBe("update");
    expect(result.payload.status).toBe("approved");
  });

  it("buildResolvedResult returns update action for denied", () => {
    const build = (lansengerPlugin as any).approvalCapability?.nativeRuntime?.presentation?.buildResolvedResult;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    const result = build({ cfg, resolved: { kind: "denied" }, entry: {} });
    expect(result.kind).toBe("update");
    expect(result.payload.status).toBe("denied");
  });

  it("buildResolvedResult returns approved when kind is nested in strategy.kind", () => {
    const build = (lansengerPlugin as any).approvalCapability?.nativeRuntime?.presentation?.buildResolvedResult;
    const cfg = { channels: { lansenger: { appId: "id", appSecret: "secret" } } };
    // Simulates framework nesting approval kind inside strategy.kind:
    // resolved.kind="resolved" (not in approvedKinds), strategy.kind="allow-once" (approved)
    const result = build({ cfg, resolved: { kind: "resolved", strategy: { kind: "allow-once" } }, entry: {} });
    expect(result.kind).toBe("update");
    expect(result.payload.status).toBe("approved");
    expect(result.payload.strategyKind).toBe("allow-once");
  });
});

describe("normalizePayload", () => {
  const outbound = (lansengerPlugin as any).outbound ?? (lansengerPlugin as any).base?.outbound;
  const base = outbound?.base ?? outbound;

  it("marks pure text as formatText", () => {
    const result = base.normalizePayload({ payload: { text: "hello world" }, cfg: {} });
    expect(result._lansengerFormatText).toBe(true);
  });

  it("does not mark text with mediaUrl as formatText", () => {
    const result = base.normalizePayload({ payload: { text: "caption", mediaUrl: "/tmp/img.jpg" }, cfg: {} });
    expect(result._lansengerFormatText).toBeUndefined();
  });

  it("does not mark text with presentation as formatText", () => {
    const result = base.normalizePayload({ payload: { text: "hello", presentation: {} }, cfg: {} });
    expect(result._lansengerFormatText).toBeUndefined();
  });

  it("marks text with code blocks as formatText even with mediaUrl", () => {
    const result = base.normalizePayload({ payload: { text: "```js\nconsole.log('hi')\n```", mediaUrl: "/tmp/img.jpg" }, cfg: {} });
    expect(result._lansengerFormatText).toBe(true);
  });

  it("marks text with inline code block as formatText", () => {
    const result = base.normalizePayload({ payload: { text: "Here is code:\n```\nx=1\n```\nDone." }, cfg: {} });
    expect(result._lansengerFormatText).toBe(true);
  });

  it("returns null for empty payload", () => {
    const result = base.normalizePayload({ payload: null, cfg: {} });
    expect(result).toBeNull();
  });
});

describe("shouldSuppressLocalPayloadPrompt", () => {
  const outbound = (lansengerPlugin as any).outbound ?? (lansengerPlugin as any).base?.outbound;
  const suppress = (outbound?.shouldSuppressLocalPayloadPrompt ?? outbound?.base?.shouldSuppressLocalPayloadPrompt) as ((params: any) => boolean) | undefined;

  it("suppresses local prompt for approval-pending", () => {
    const result = suppress?.({ payload: { text: "审批请求" }, hint: { kind: "approval-pending", approvalKind: "exec", nativeRouteActive: true } });
    expect(result).toBe(true);
  });

  it("suppresses local prompt for approval-pending regardless of nativeRouteActive", () => {
    const result = suppress?.({ payload: { text: "审批请求" }, hint: { kind: "approval-pending", approvalKind: "exec", nativeRouteActive: false } });
    expect(result).toBe(true);
  });

  it("does not suppress local prompt for approval-resolved", () => {
    const result = suppress?.({ payload: { text: "✅ 已批准" }, hint: { kind: "approval-resolved", approvalKind: "exec" } });
    expect(result).toBe(false);
  });

  it("does not suppress local prompt without hint", () => {
    const result = suppress?.({ payload: { text: "hello" } });
    expect(result).toBe(false);
  });
});

describe("textChunkLimit and chunker", () => {
  const outbound = (lansengerPlugin as any).outbound ?? (lansengerPlugin as any).base?.outbound;
  const base = outbound?.base ?? outbound;

  it("declares textChunkLimit as 4000", () => {
    expect(base.textChunkLimit).toBe(4000);
  });

  it("declares chunkerMode as markdown", () => {
    expect(base.chunkerMode).toBe("markdown");
  });

  it("chunker splits long markdown text", () => {
    const longText = "Line 1\n\nLine 2\n\nLine 3\n\n" + "A".repeat(4000) + "\n\nLine 5";
    const chunks = base.chunker(longText, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000 * 1.1);
    }
  });

  it("chunker preserves short text as single chunk", () => {
    const shortText = "Hello world";
    const chunks = base.chunker(shortText, 4000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("Hello world");
  });
});

describe("pendingApprovalCards", () => {
  beforeEach(() => {
    pendingApprovalCards.clear();
  });

  it("stores and retrieves card info", () => {
    pendingApprovalCards.set("chat-1", { messageId: "msg-123", lang: "zh" });
    const info = pendingApprovalCards.get("chat-1");
    expect(info?.messageId).toBe("msg-123");
    expect(info?.lang).toBe("zh");
  });

  it("deletes card info after retrieval", () => {
    pendingApprovalCards.set("chat-1", { messageId: "msg-123", lang: "zh" });
    pendingApprovalCards.delete("chat-1");
    expect(pendingApprovalCards.get("chat-1")).toBeUndefined();
  });
});