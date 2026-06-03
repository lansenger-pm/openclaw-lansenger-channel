import { describe, it, expect } from "vitest";
import { lansengerSetupWizard } from "./setup-wizard.js";
import { resolveAccount } from "./channel.js";

describe("lansengerSetupWizard", () => {
  it("channel is 'lansenger'", () => {
    expect(lansengerSetupWizard.channel).toBe("lansenger");
  });

  describe("status.resolveConfigured", () => {
    it("returns true when accounts have valid appId+appSecret", () => {
      const cfg = {
        channels: {
          lansenger: {
            accounts: {
              "bot1": { appId: "bot1", appSecret: "s1" },
            },
          },
        },
      };
      expect(lansengerSetupWizard.status.resolveConfigured({ cfg })).toBe(true);
    });

    it("returns false when accounts have no valid entries", () => {
      const cfg = {
        channels: {
          lansenger: {
            accounts: {
              "bot1": { appId: "bot1" },
            },
          },
        },
      };
      expect(lansengerSetupWizard.status.resolveConfigured({ cfg })).toBe(false);
    });

    it("returns true when top-level has appId+appSecret", () => {
      const cfg = { channels: { lansenger: { appId: "id", appSecret: "s" } } };
      expect(lansengerSetupWizard.status.resolveConfigured({ cfg })).toBe(true);
    });

    it("returns false when nothing configured", () => {
      const cfg = { channels: {} };
      expect(lansengerSetupWizard.status.resolveConfigured({ cfg })).toBe(false);
    });
  });

  describe("introNote.shouldShow", () => {
    it("returns false when already configured via accounts", () => {
      const cfg = {
        channels: {
          lansenger: {
            accounts: { "bot1": { appId: "b1", appSecret: "s1" } },
          },
        },
      };
      expect(lansengerSetupWizard.introNote.shouldShow({ cfg })).toBe(false);
    });

    it("returns true when not configured", () => {
      const cfg = { channels: {} };
      expect(lansengerSetupWizard.introNote.shouldShow({ cfg })).toBe(true);
    });
  });

  describe("credentials shouldPrompt", () => {
    it("appToken shouldPrompt returns false when hasConfiguredValue", () => {
      const state = { hasConfiguredValue: true };
      expect(lansengerSetupWizard.credentials[0].shouldPrompt({ state })).toBe(false);
    });

    it("appToken shouldPrompt returns true when no value", () => {
      const state = { hasConfiguredValue: false };
      expect(lansengerSetupWizard.credentials[0].shouldPrompt({ state })).toBe(true);
    });

    it("secret shouldPrompt returns false when hasConfiguredValue", () => {
      const state = { hasConfiguredValue: true };
      expect(lansengerSetupWizard.credentials[1].shouldPrompt({ state })).toBe(false);
    });

    it("secret shouldPrompt returns true when no value", () => {
      const state = { hasConfiguredValue: false };
      expect(lansengerSetupWizard.credentials[1].shouldPrompt({ state })).toBe(true);
    });
  });

  describe("credentials allowEnv", () => {
    it("appToken allowEnv returns true for default accountId", () => {
      expect(lansengerSetupWizard.credentials[0].allowEnv({ accountId: "default" })).toBe(true);
      expect(lansengerSetupWizard.credentials[0].allowEnv({ accountId: undefined })).toBe(true);
    });

    it("appToken allowEnv returns false for specific accountId", () => {
      expect(lansengerSetupWizard.credentials[0].allowEnv({ accountId: "2285568-10117376" })).toBe(false);
    });
  });

  describe("credentials inspect", () => {
    it("appToken inspect reads appId from config", () => {
      const cfg = { channels: { lansenger: { appId: "my-app-id" } } };
      const result = lansengerSetupWizard.credentials[0].inspect({ cfg, accountId: undefined });
      expect(result.hasConfiguredValue).toBe(true);
      expect(result.resolvedValue).toBe("my-app-id");
    });

    it("secret inspect reads appSecret from accounts", () => {
      const cfg = {
        channels: {
          lansenger: {
            accounts: { "bot1": { appSecret: "my-secret" } },
          },
        },
      };
      const result = lansengerSetupWizard.credentials[1].inspect({ cfg, accountId: "bot1" });
      expect(result.hasConfiguredValue).toBe(true);
      expect(result.resolvedValue).toBe("my-secret");
    });
  });

  describe("textInputs baseUrl", () => {
    it("initialValue returns from account config", () => {
      const cfg = { channels: { lansenger: { apiGatewayUrl: "https://custom.url" } } };
      const val = lansengerSetupWizard.textInputs[0].initialValue({ cfg, accountId: undefined });
      expect(val).toBe("https://custom.url");
    });

    it("initialValue defaults to public cloud URL", () => {
      const cfg = { channels: {} };
      const val = lansengerSetupWizard.textInputs[0].initialValue({ cfg, accountId: undefined });
      expect(val).toBe("https://open.e.lanxin.cn/open/apigw");
    });
  });

  describe("dmPolicy.getCurrent", () => {
    it("returns dmPolicy when present", () => {
      const cfg = { channels: { lansenger: { dmPolicy: "open" } } };
      expect(lansengerSetupWizard.dmPolicy.getCurrent(cfg)).toBe("open");
    });

    it("falls back to dmSecurity", () => {
      const cfg = { channels: { lansenger: { dmSecurity: "paired" } } };
      expect(lansengerSetupWizard.dmPolicy.getCurrent(cfg)).toBe("paired");
    });

    it("defaults to pairing", () => {
      const cfg = { channels: {} };
      expect(lansengerSetupWizard.dmPolicy.getCurrent(cfg)).toBe("pairing");
    });
  });

  describe("allowFrom", () => {
    it("parseId returns trimmed string", () => {
      expect(lansengerSetupWizard.allowFrom.parseId(" 2285568-xxx ")).toBe("2285568-xxx");
    });

    it("parseId returns null for empty string", () => {
      expect(lansengerSetupWizard.allowFrom.parseId("")).toBe(null);
    });

    it("resolveEntries maps entries to resolved objects", async () => {
      const entries = ["2285568-xxx", "2285568-yyy"];
      const result = await lansengerSetupWizard.allowFrom.resolveEntries({ entries });
      expect(result).toEqual([
        { input: "2285568-xxx", resolved: true, id: "2285568-xxx" },
        { input: "2285568-yyy", resolved: true, id: "2285568-yyy" },
      ]);
    });
  });

  describe("disable", () => {
    it("sets enabled to false", () => {
      const cfg = { channels: { lansenger: { enabled: true, appId: "id" } } };
      const result = lansengerSetupWizard.disable(cfg);
      expect(result.channels.lansenger.enabled).toBe(false);
    });
  });
});

describe("resolveAccountFromCfg (via setup wizard inspect)", () => {
  it("returns default account from accounts.default", () => {
    const cfg = { channels: { lansenger: { accounts: { default: { appId: "default-id", appSecret: "default-secret" } } } } };
    const result = lansengerSetupWizard.credentials[0].inspect({ cfg, accountId: "default" });
    expect(result.hasConfiguredValue).toBe(true);
    expect(result.resolvedValue).toBe("default-id");
  });

  it("returns account by appId key", () => {
    const cfg = { channels: { lansenger: { accounts: { "bot1-id": { appId: "bot1-id", appSecret: "s1" } } } } };
    const result = lansengerSetupWizard.credentials[0].inspect({ cfg, accountId: "bot1-id" });
    expect(result.hasConfiguredValue).toBe(true);
  });

  it("returns undefined for missing account", () => {
    const cfg = { channels: { lansenger: { appId: "top-id" } } };
    const result = lansengerSetupWizard.credentials[0].inspect({ cfg, accountId: "nonexistent" });
    expect(result.hasConfiguredValue).toBe(true);
  });
});

describe("lansengerSetupWizard.finalize", () => {
  it("merges default account into appId-keyed account", async () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "top-id",
          appSecret: "top-secret",
          accounts: {
            default: { appId: "default-id", appSecret: "default-secret" },
          },
        },
      },
    };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result.channels.lansenger.accounts["default-id"]).toBeDefined();
    expect(result.channels.lansenger.accounts["default-id"].appId).toBe("default-id");
    expect(result.channels.lansenger.accounts["default-id"].appSecret).toBe("default-secret");
    expect(result.channels.lansenger.accounts["default"]).toBeUndefined();
    expect(result.channels.lansenger.enabled).toBe(true);
  });

  it("migrates top-level creds into accounts when not present", async () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "top-id",
          appSecret: "top-secret",
          accounts: {
            "existing-id": { appId: "existing-id", appSecret: "existing-secret" },
          },
        },
      },
    };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result.channels.lansenger.accounts["top-id"]).toBeDefined();
    expect(result.channels.lansenger.accounts["top-id"].appId).toBe("top-id");
    expect(result.channels.lansenger.appId).toBeUndefined();
    expect(result.channels.lansenger.appSecret).toBeUndefined();
  });

  it("cleans up top-level fields after migration", async () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "top-id",
          appSecret: "top-secret",
          apiGatewayUrl: "https://custom.url",
          allowFrom: ["user-1"],
          dmPolicy: "open",
          accounts: {
            "bot1": { appId: "bot1", appSecret: "s1" },
          },
        },
      },
    };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result.channels.lansenger.appId).toBeUndefined();
    expect(result.channels.lansenger.appSecret).toBeUndefined();
    expect(result.channels.lansenger.apiGatewayUrl).toBeUndefined();
    expect(result.channels.lansenger.allowFrom).toBeUndefined();
    expect(result.channels.lansenger.dmPolicy).toBe("pairing");
  });

  it("sets enabled=true and dmPolicy=pairing for flat config", async () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "id",
          appSecret: "secret",
        },
      },
    };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result.channels.lansenger.enabled).toBe(true);
  });

  it("handles empty config", async () => {
    const cfg = { channels: {} };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result).toBeDefined();
  });

  it("preserves existing appId-keyed account data during merge", async () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "merge-id",
          appSecret: "merge-secret",
          accounts: {
            "merge-id": { appId: "merge-id", appSecret: "existing-secret", allowFrom: ["existing-user"] },
          },
        },
      },
    };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result.channels.lansenger.accounts["merge-id"].appSecret).toBe("existing-secret");
    expect(result.channels.lansenger.accounts["merge-id"].allowFrom).toEqual(["existing-user"]);
  });

  it("removes empty default account when it has no appId", async () => {
    const cfg = {
      channels: {
        lansenger: {
          appId: "top-id",
          accounts: {
            default: {},
            "bot1": { appId: "bot1", appSecret: "s1" },
          },
        },
      },
    };
    const result = await lansengerSetupWizard.finalize({ cfg, accountId: undefined });
    expect(result.channels.lansenger.accounts.default).toBeUndefined();
  });
});

describe("lansengerSetupWizard.companionNote", () => {
  it("has correct title", () => {
    expect(lansengerSetupWizard.companionNote.title).toMatch(/Messaging Tools|消息工具|訊息工具/);
  });

  it("shouldShow always returns true", () => {
    expect(lansengerSetupWizard.companionNote.shouldShow()).toBe(true);
  });

  it("lines contain built-in tools info", () => {
    const lines = lansengerSetupWizard.companionNote.lines;
    expect(lines.some((l: string) => l.includes("built-in") || l.includes("内置"))).toBe(true);
  });
});