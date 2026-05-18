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
  "",
  "✅ Agent tools are included in this plugin (no separate install needed). / 代理工具已内置于此插件，无需单独安装。",
  "CLI is an optional alternative: pip install lansenger-cli / CLI 为可选替代方案：pip install lansenger-cli",
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
    channelLabel: "Lansenger (蓝信)",
    configuredLabel: "已配置 / configured",
    unconfiguredLabel: "需要 App ID 和 App Secret / needs App ID and App Secret",
    configuredHint: "已配置 / configured",
    unconfiguredHint: "需要配置 / needs setup",
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
      helpLines: [
        "App ID from your Lansenger Personal Bot / 个人机器人的 App ID",
        "Found alongside App Secret → Contacts → Bots → Personal Bots / 通讯录 → 智能机器人 → 个人机器人",
      ],
      envPrompt: "检测到环境变量 LANSENGER_APP_ID，是否使用？/ LANSENGER_APP_ID detected. Use env var?",
      keepPrompt: "App ID 已配置，是否保留？/ App ID already configured. Keep it?",
      inputPrompt: "输入蓝信 App ID / Enter Lansenger App ID",
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
      credentialLabel: "Lansenger App Secret",
      preferredEnvVar: "LANSENGER_APP_SECRET",
      helpTitle: "Lansenger App Secret / 蓝信 App Secret",
      helpLines: [
        "App Secret from your Lansenger Personal Bot / 个人机器人的 App Secret",
        "Found alongside App ID → Contacts → Bots → Personal Bots / 通讯录 → 智能机器人 → 个人机器人",
      ],
      envPrompt: "检测到环境变量 LANSENGER_APP_SECRET，是否使用？/ LANSENGER_APP_SECRET detected. Use env var?",
      keepPrompt: "App Secret 已配置，是否保留？/ App Secret already configured. Keep it?",
      inputPrompt: "输入蓝信 App Secret / Enter Lansenger App Secret",
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
      message: "API 网关地址（可选，默认蓝信公有云）/ API Gateway URL (optional, default Lansenger public cloud)",
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
    helpTitle: "Lansenger user ID / 蓝信用户 ID",
    helpLines: [
      "Lansenger user IDs have format: appId-userId (e.g. 2285568-xxxxxxx)",
      "蓝信用户 ID 格式：appId-userId（如 2285568-xxxxxxx）",
    ],
    message: "蓝信允许的用户 ID（格式：2285568-xxx）/ Lansenger allowFrom (user IDs, format: 2285568-xxx)",
    placeholder: "2285568-xxxxxxx",
    invalidWithoutCredentialNote: "蓝信 allowFrom 需要格式为 appId-userId 的用户 ID。/ Lansenger allowFrom requires user IDs in format appId-userId.",
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
    policyKey: "channels.lansenger.dmPolicy",
    allowFromKey: "channels.lansenger.allowFrom",
    getCurrent: (cfg: any) => {
      const section = getSection(cfg);
      return (section?.dmPolicy ?? section?.dmSecurity ?? "pairing") as any;
    },
  }),

  disable: (cfg: any) => setSetupChannelEnabled(cfg, CHANNEL, false),

  companionNote: {
    title: "Messaging Tools / 消息工具",
    lines: [
      "Agent tools (lansenger_send_file, etc.) are included in this plugin — no separate install needed. / 代理工具（lansenger_send_file 等）已内置于此插件，无需单独安装。",
      "",
      "CLI is an optional alternative (works via bash): / CLI 为可选替代方案（通过 bash 调用）：",
      "  pip install lansenger-cli",
      "",
      "Without CLI, the agent can still use built-in tools for files, cards, and formatted messages. / 未安装 CLI 时，代理仍可使用内置工具发送文件、卡片和格式化消息。",
    ],
    shouldShow: () => true,
  },
};