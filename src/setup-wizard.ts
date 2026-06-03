import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  createStandardChannelSetupStatus,
  setSetupChannelEnabled,
  patchChannelConfigForAccount,
  createAccountScopedAllowFromSection,
  splitSetupEntries,
  createSetupTranslator,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  createTopLevelChannelDmPolicy,
  formatDocsLink,
} from "openclaw/plugin-sdk/channel-setup";
import { lt } from "./setup-i18n.js";

const CHANNEL = "lansenger";
const t = createSetupTranslator();

function getSection(cfg: OpenClawConfig): Record<string, any> | undefined {
  return (cfg.channels as Record<string, any>)?.[CHANNEL];
}

function resolveAccountFromCfg(cfg: OpenClawConfig, accountId?: string): Record<string, any> | undefined {
  const section = getSection(cfg);
  if (!section) return undefined;
  const accounts = section.accounts as Record<string, any> | undefined;
  if (!accountId || accountId === "default" || accountId === DEFAULT_ACCOUNT_ID) {
    return accounts?.default ?? section;
  }
  if (section.appId === accountId) return section;
  if (accounts?.[accountId]) return accounts[accountId];
  if (accounts) {
    for (const [, acc] of Object.entries(accounts)) {
      if (acc?.appId === accountId) return acc;
    }
  }
  return section;
}

const HELP_LINES = [
  lt("introDesktopPath"),
  lt("introClickInfo"),
  lt("introPersonalOnly"),
  lt("introNoMobile"),
  t("wizard.channels.docs", { link: formatDocsLink("https://open.e.lanxin.cn/docs", "lansenger") }),
  "",
  lt("introToolsIncluded"),
  lt("introCliAlt"),
];

function makeInspect(field: string, envVar: string) {
  return ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }): any => {
    const account = resolveAccountFromCfg(cfg, accountId);
    const value = account?.[field];
    const envValue = (!accountId || accountId === "default" || accountId === DEFAULT_ACCOUNT_ID)
      ? (process.env[envVar]?.trim() || undefined)
      : undefined;
    return {
      accountConfigured: Boolean(value || envValue),
      hasConfiguredValue: Boolean(value),
      resolvedValue: value || undefined,
      envValue,
    };
  };
}

export const lansengerSetupWizard: any = {
  channel: CHANNEL,

  status: createStandardChannelSetupStatus({
    channelLabel: lt("channelLabel"),
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsSetup"),
    configuredScore: 1,
    unconfiguredScore: 10,
    resolveConfigured: ({ cfg }: any) => {
      const section = getSection(cfg);
      const accounts = section?.accounts as Record<string, any> | undefined;
      if (accounts && Object.keys(accounts).length > 0) {
        return Object.values(accounts).some((a: any) => Boolean(a?.appId && a?.appSecret));
      }
      return Boolean(section?.appId && section?.appSecret) ||
        Boolean(process.env.LANSENGER_APP_ID && process.env.LANSENGER_APP_SECRET);
    },
  }),

  introNote: {
    title: lt("introTitle"),
    lines: HELP_LINES,
    shouldShow: ({ cfg }: any) => {
      const section = getSection(cfg);
      const accounts = section?.accounts as Record<string, any> | undefined;
      if (accounts && Object.keys(accounts).length > 0) {
        return !Object.values(accounts).some((a: any) => a?.appId && a?.appSecret);
      }
      return !Boolean(section?.appId && section?.appSecret);
    },
  },

  credentials: [
    {
      inputKey: "appToken",
      providerHint: "lansenger",
      credentialLabel: lt("appIdLabel"),
      preferredEnvVar: "LANSENGER_APP_ID",
      helpTitle: lt("appIdLabel"),
      helpLines: [lt("appIdHelpLine1"), lt("appIdHelpLine2")],
      envPrompt: lt("appIdEnvPrompt"),
      keepPrompt: lt("appIdKeepPrompt"),
      inputPrompt: lt("appIdInputPrompt"),
      shouldPrompt: ({ state }: any) => !state.hasConfiguredValue,
      allowEnv: ({ accountId }: any) => !accountId || accountId === "default" || accountId === DEFAULT_ACCOUNT_ID,
      inspect: makeInspect("appId", "LANSENGER_APP_ID"),
      applySet: ({ cfg, accountId, resolvedValue }: any) => patchChannelConfigForAccount({
        cfg, channel: CHANNEL, accountId,
        patch: { appId: resolvedValue },
      }),
    },
    {
      inputKey: "secret",
      providerHint: "lansenger",
      credentialLabel: lt("secretLabel"),
      preferredEnvVar: "LANSENGER_APP_SECRET",
      helpTitle: lt("secretLabel"),
      helpLines: [lt("secretHelpLine1"), lt("secretHelpLine2")],
      envPrompt: lt("secretEnvPrompt"),
      keepPrompt: lt("secretKeepPrompt"),
      inputPrompt: lt("secretInputPrompt"),
      shouldPrompt: ({ state }: any) => !state.hasConfiguredValue,
      allowEnv: ({ accountId }: any) => !accountId || accountId === "default" || accountId === DEFAULT_ACCOUNT_ID,
      inspect: makeInspect("appSecret", "LANSENGER_APP_SECRET"),
      applySet: ({ cfg, accountId, resolvedValue }: any) => patchChannelConfigForAccount({
        cfg, channel: CHANNEL, accountId,
        patch: { appSecret: resolvedValue },
      }),
    },
  ],

  textInputs: [
    {
      inputKey: "baseUrl",
      message: lt("baseUrlMessage"),
      placeholder: "https://open.e.lanxin.cn/open/apigw",
      required: false,
      initialValue: ({ cfg, accountId }: any) => {
        const account = resolveAccountFromCfg(cfg, accountId);
        return account?.apiGatewayUrl || "https://open.e.lanxin.cn/open/apigw";
      },
      applySet: ({ cfg, accountId, value }: any) => patchChannelConfigForAccount({
        cfg, channel: CHANNEL, accountId,
        patch: { apiGatewayUrl: value },
      }),
    },
  ],

  finalize: async ({ cfg, accountId }: any) => {
    const channels = { ...((cfg.channels as Record<string, any>) ?? {}) };
    let section = { ...(channels[CHANNEL] ?? {}) };
    let accounts = section.accounts as Record<string, any> | undefined;

    if (accounts && Object.keys(accounts).length > 0) {
      accounts = { ...accounts };
      section.accounts = accounts;

      const defaultAcc = accounts.default ?? {};
      const defaultAppId = defaultAcc.appId || section.appId;

      if (defaultAppId && Object.keys(defaultAcc).length === 0) {
        delete accounts.default;
      } else if (defaultAppId && Object.keys(defaultAcc).length > 0) {
        const existing = accounts[defaultAppId] ?? {};
        const merged = { ...existing };
        for (const key of ["appId", "appSecret", "apiGatewayUrl", "allowFrom", "dmPolicy", "enabled", "name"]) {
          const val = defaultAcc[key] || section[key];
          if (val && !merged[key]) merged[key] = val;
        }
        merged.appId = merged.appId || defaultAppId;
        merged.enabled = true;
        merged.dmPolicy = merged.dmPolicy ?? merged.dmSecurity ?? "pairing";
        accounts[defaultAppId] = merged;
        delete accounts.default;
      }

      if (section.appId && !Object.values(accounts).some((a: any) => a.appId === section.appId)) {
        accounts[section.appId] = {
          ...accounts[section.appId] ?? {},
          appId: section.appId,
          appSecret: section.appSecret,
          apiGatewayUrl: section.apiGatewayUrl,
          enabled: true,
          dmPolicy: section.dmPolicy ?? section.dmSecurity ?? "pairing",
        };
      }

      delete section.appId;
      delete section.appSecret;
      delete section.apiGatewayUrl;
      delete section.allowFrom;
      delete section.dmPolicy;
      delete section.dmSecurity;
      section.enabled = true;
      section.dmPolicy = "pairing";
    } else {
      section.enabled = true;
      section.dmPolicy = section.dmPolicy ?? section.dmSecurity ?? "pairing";
    }

    channels[CHANNEL] = section;
    cfg = { ...cfg, channels };

    const finalAccounts = section.accounts as Record<string, any> | undefined;
    let hasPlaintextSecret = false;
    if (finalAccounts && Object.keys(finalAccounts).length > 0) {
      hasPlaintextSecret = Object.values(finalAccounts).some((a: any) =>
        typeof a?.appSecret === "string" && a.appSecret.trim() && !a.appSecret.startsWith("__OPENCLAW_SECRET__")
      );
    } else {
      hasPlaintextSecret = typeof section.appSecret === "string" && section.appSecret.trim() && !section.appSecret.startsWith("__OPENCLAW_SECRET__");
    }
    if (hasPlaintextSecret) {
      console.log("");
      console.log(lt("finalizePlaintext1"));
      console.log(lt("finalizePlaintext2"));
      console.log("");
      console.log(lt("finalizePlaintext3"));
      console.log(lt("finalizePlaintext4"));
      console.log("");
    }

    const effectiveAccountId = accountId && accountId !== "default" && accountId !== DEFAULT_ACCOUNT_ID
      ? accountId
      : (section.accounts ? Object.keys(section.accounts)[0] : "default");

    return patchChannelConfigForAccount({
      cfg, channel: CHANNEL, accountId: effectiveAccountId,
      patch: { enabled: true, dmPolicy: "pairing" },
    });
  },

  allowFrom: createAccountScopedAllowFromSection({
    channel: CHANNEL,
    helpTitle: lt("allowFromHelpTitle"),
    helpLines: [lt("allowFromHelpLine1")],
    message: lt("allowFromMessage"),
    placeholder: "xxx-xxxxxxx",
    invalidWithoutCredentialNote: lt("allowFromInvalidNote"),
    parseId: (entry: string) => entry.trim() || null,
    resolveEntries: async ({ entries }: any) => entries.map((entry: string) => ({
      input: entry,
      resolved: Boolean(entry.trim()),
      id: entry.trim(),
    })),
  }),

  dmPolicy: createTopLevelChannelDmPolicy({
    label: lt("channelLabel"),
    channel: CHANNEL,
    policyKey: "channels.lansenger.dmPolicy",
    allowFromKey: "channels.lansenger.allowFrom",
    getCurrent: (cfg: any) => {
      const section = getSection(cfg);
      return (section?.dmPolicy ?? section?.dmSecurity ?? "pairing") as any;
    },
  }),

  disable: (cfg: any) => setSetupChannelEnabled(cfg, CHANNEL, false),

  companionNote: {
    title: lt("companionTitle"),
    lines: [
      lt("companionLine1"),
      "",
      lt("companionLine2"),
      "  pip install lansenger-cli",
      "",
      lt("companionLine3"),
    ],
    shouldShow: () => true,
  },

  securityNote: {
    title: lt("securityTitle"),
    lines: [
      lt("securityLine1"),
      lt("securityLine2"),
      "",
      lt("securityLine3"),
      "  openclaw secrets configure",
      "",
      lt("securityLine4"),
    ],
    shouldShow: ({ cfg }: any) => {
      const section = getSection(cfg);
      const accounts = section?.accounts as Record<string, any> | undefined;
      if (accounts && Object.keys(accounts).length > 0) {
        return Object.values(accounts).some((a: any) =>
          typeof a?.appSecret === "string" && a.appSecret.trim() && !a.appSecret.startsWith("__OPENCLAW_SECRET__")
        );
      }
      return typeof section?.appSecret === "string" && section.appSecret.trim() && !section.appSecret.startsWith("__OPENCLAW_SECRET__");
    },
  },
};