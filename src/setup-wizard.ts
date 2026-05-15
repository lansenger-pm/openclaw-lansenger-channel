import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  createStandardChannelSetupStatus,
  setSetupChannelEnabled,
  patchChannelConfigForAccount,
  createAccountScopedAllowFromSection,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  createTopLevelChannelDmPolicy,
  formatDocsLink,
} from "openclaw/plugin-sdk/channel-setup";

const CHANNEL = "lansenger";

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
  "Lansenger Desktop → Contacts → Bots → Personal Bots / 蓝信桌面端 → 通讯录 → 智能机器人 → 个人机器人",
  "Click the ℹ️ icon to view App ID and App Secret / 点击 ℹ️ 图标查看凭证",
  "Personal Bots only — organization bots not supported / 仅支持个人机器人",
  "Mobile client does NOT support viewing credentials / 移动端不支持查看凭证",
  `Docs: ${formatDocsLink("https://open.e.lanxin.cn/docs", "lansenger")}`,
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
    channelLabel: "Lansenger",
    configuredLabel: "configured",
    unconfiguredLabel: "needs App ID and App Secret",
    configuredHint: "configured",
    unconfiguredHint: "needs setup",
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
    title: "Lansenger Setup / 蓝信配置",
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
      credentialLabel: "Lansenger App ID",
      preferredEnvVar: "LANSENGER_APP_ID",
      helpTitle: "Lansenger App ID / 蓝信 App ID",
      helpLines: HELP_LINES,
      envPrompt: "LANSENGER_APP_ID detected. Use env var?",
      keepPrompt: "App ID already configured. Keep it?",
      inputPrompt: "Enter Lansenger App ID / 输入蓝信 App ID",
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
      credentialLabel: "Lansenger App Secret",
      preferredEnvVar: "LANSENGER_APP_SECRET",
      helpTitle: "Lansenger App Secret / 蓝信 App Secret",
      helpLines: [
        "App Secret from your Lansenger Personal Bot / 个人机器人的 App Secret",
        "Found alongside App ID → Contacts → Bots → Personal Bots / 通讯录 → 智能机器人 → 个人机器人",
      ],
      envPrompt: "LANSENGER_APP_SECRET detected. Use env var?",
      keepPrompt: "App Secret already configured. Keep it?",
      inputPrompt: "Enter Lansenger App Secret / 输入蓝信 App Secret",
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
      message: "API Gateway URL / API 网关地址（可选，默认蓝信公有云）",
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
    return patchChannelConfigForAccount({
      cfg, channel: CHANNEL, accountId,
      patch: { enabled: true, dmSecurity: "paired" },
    });
  },

  allowFrom: createAccountScopedAllowFromSection({
    channel: CHANNEL,
    helpTitle: "Lansenger user ID / 蓝信用户 ID",
    helpLines: [
      "Lansenger user IDs have format: appId-userId (e.g. 2285568-xxxxxxx)",
      "蓝信用户 ID 格式：appId-userId（如 2285568-xxxxxxx）",
    ],
    message: "Lansenger allowFrom (user IDs, format: 2285568-xxx)",
    placeholder: "2285568-xxxxxxx",
    invalidWithoutCredentialNote: "Lansenger allowFrom requires user IDs in format appId-userId.",
    parseId: (entry: string) => entry.trim() || null,
    resolveEntries: async ({ entries }: any) => entries.map((entry: string) => ({
      input: entry,
      resolved: Boolean(entry.trim()),
      id: entry.trim(),
    })),
  }),

  dmPolicy: createTopLevelChannelDmPolicy({
    label: "Lansenger",
    channel: CHANNEL,
    policyKey: "channels.lansenger.dmSecurity",
    allowFromKey: "channels.lansenger.allowFrom",
    getCurrent: (cfg: any) => {
      const section = getSection(cfg);
      return (section?.dmSecurity ?? "paired") as any;
    },
  }),

  disable: (cfg: any) => setSetupChannelEnabled(cfg, CHANNEL, false),
};