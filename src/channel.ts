import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig, ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-runtime";
import { createResolvedApproverActionAuthAdapter } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  buildProbeChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { coerceSecretRef, type SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-policy";
import { chunkMarkdownTextWithMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { LansengerClient, DEFAULT_API_GATEWAY_URL } from "./client.js";
import type { ApproveCardData, ApproveCardButton, I18nAppCardData, ClientLogger } from "./client.js";
import { getRunningClientByAccountId, getSessionAccountId, getLastInboundTimeByAccountId, stripOpenClawUuidSuffix, gatewayStartAccount, gatewayStopAccount } from "./runtime.js";
import { lansengerSetupWizard } from "./setup-wizard.js";

const log = createSubsystemLogger("lansenger");
const LANSENGER_TEXT_CHUNK_LIMIT = 4000;

import { PersistentStore } from "./persistent-store.js";

const APPROVAL_CARD_FILE = path.join(os.homedir(), ".openclaw", "lansenger-approval-cards.json");

class PersistentApprovalCardStore extends PersistentStore<{ messageId: string; lang: "zh" | "en" }> {
  constructor() {
    super(APPROVAL_CARD_FILE, "approval cards");
  }
}

const pendingApprovalCards = new PersistentApprovalCardStore();

const APPROVAL_CALLBACK_FILE = path.join(os.homedir(), ".openclaw", "lansenger-approval-callbacks.json");

class PersistentApprovalCallbackStore extends PersistentStore<{ messageId: string; lang: "zh" | "en"; chatId: string; sessionKey: string }> {
  constructor() {
    super(APPROVAL_CALLBACK_FILE, "approval callbacks");
  }
}

const pendingApprovalCallbacks = new PersistentApprovalCallbackStore();

function isPathAllowed(filePath: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const resolved = path.resolve(filePath);
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot) return true;
  }
  return false;
}

type LansengerProbeResult = {
  ok: boolean;
  appId?: string;
  error?: string;
};

type LansengerAccount = {
  appId?: string;
  appSecret?: string;
  apiGatewayUrl?: string;
  allowFrom?: string[];
  dmPolicy?: string;
  dmSecurity?: string;
  homeChannel?: string;
  enabled?: boolean;
  ackMessage?: boolean;
  revokeAckMessage?: boolean;
  ackMessageTextZh?: string;
  ackMessageTextEn?: string;
  dangerouslyAllowPrivateNetwork?: boolean;
  mediaLocalRoots?: string[];
  autoMentionReply?: boolean;
  autoQuoteReply?: boolean;
  respondToAtAll?: boolean;
  execApprovals?: { approvers?: string[] };
}

type ResolvedAccount = {
  accountId: string | null;
  appId: string;
  appSecret: string;
  apiGatewayUrl: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  homeChannel: string | undefined;
  enabled: boolean;
  configured?: boolean;
  ackMessage: boolean;
  ackMessageTextZh: string;
  ackMessageTextEn: string;
  revokeAckMessage: boolean;
  dangerouslyAllowPrivateNetwork: boolean;
  mediaLocalRoots: string[];
  autoMentionReply: boolean;
  autoQuoteReply: boolean;
  respondToAtAll: boolean;
  execApprovals?: { approvers?: string[] };
};

function resolveSecretValue(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw;
  const ref = coerceSecretRef(raw, { env: "LANSENGER_APP_SECRET" });
  if (ref) {
    const envVal = process.env[ref.id] ?? "";
    if (envVal) return envVal;
    log.warn(`SecretRef for appSecret: env var '${ref.id}' is empty or not set`);
    return "";
  }
  return "";
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.["lansenger"];
  const accounts = section?.accounts as Record<string, LansengerAccount> | undefined;

  let resolvedAccountId: string | null = accountId ?? null;
  let account: LansengerAccount | undefined;

  if (resolvedAccountId && accounts && accounts[resolvedAccountId]) {
    account = accounts[resolvedAccountId];
  } else if (accounts && Object.keys(accounts).length > 0) {
    for (const [key, acc] of Object.entries(accounts)) {
      if (acc?.appId && acc?.appSecret) {
        account = acc;
        resolvedAccountId = key;
        break;
      }
    }
    if (!account) {
      account = Object.values(accounts)[0] ?? {};
      resolvedAccountId = Object.keys(accounts)[0] ?? null;
    }
  } else if (section && section.appId) {
    account = section;
    resolvedAccountId = section.appId;
  } else {
    account = section ?? {};
    resolvedAccountId = null;
  }
  
  const appId = account?.appId ?? process.env.LANSENGER_APP_ID ?? "";
  const rawSecret = account?.appSecret ?? process.env.LANSENGER_APP_SECRET ?? "";
  const appSecret = resolveSecretValue(rawSecret);
  const configSecret = account?.appSecret;
  if (typeof configSecret === "string" && configSecret.trim() && !configSecret.startsWith("__OPENCLAW_SECRET__")) {
    log.warn(
      `⚠️ appSecret for account '${resolvedAccountId || "default"}' is stored as plaintext in openclaw.json. ` +
      `Migrate to SecretRef for better security: run 'openclaw secrets configure'`
    );
  }
  const apiGatewayUrl = account?.apiGatewayUrl ?? section?.apiGatewayUrl ?? process.env.LANSENGER_API_GATEWAY_URL ?? DEFAULT_API_GATEWAY_URL;

  // ── Config field priority in multi-account mode ──────────────────────────
  //
  // Two distinct priority patterns are used deliberately, NOT a bug:
  //
  // 1. SECURITY FIELDS → `section ?? account` (top-level wins)
  //    Fields: allowFrom, dmPolicy, dmSecurity, mediaLocalRoots, homeChannel
  //
  //    These are consumed by the OpenClaw SDK security layer
  //    (security.dm.resolvePolicy / resolveAllowFrom) and act as a global
  //    security baseline. The section-level config represents the bot owner's
  //    security posture — sub-accounts should NOT be able to silently widen
  //    access (e.g. change dmPolicy from "pairing" to "open" or expose
  //    media paths the owner didn't approve). Section-first ensures the
  //    owner's security constraints always apply.
  //
  //    The SDK itself does NOT do section/account merging for these values;
  //    it receives the per-account resolved object and passes it directly
  //    to resolvePolicy/resolveAllowFrom. Priority is entirely the plugin's
  //    responsibility.
  //
  // 2. CHANNEL BEHAVIOR FIELDS → `account ?? section` (sub-account wins)
  //    Fields: ackMessage, ackMessageText*, revokeAckMessage,
  //            autoMentionReply, autoQuoteReply, respondToAtAll
  //
  //    These are UX/behavior preferences used by the channel plugin itself
  //    (not the SDK security layer). Sub-accounts should be able to
  //    customize their own reply behavior independently.
  //
  // 3. INFRASTRUCTURE FIELDS → `account ?? section` (sub-account wins)
  //    Fields: apiGatewayUrl
  //
  //    Different accounts may point to different Lansenger API gateways
  //    (e.g. different enterprise deployments).
  // ─────────────────────────────────────────────────────────────────────────

  const allowFrom: string[] = section?.allowFrom ?? account?.allowFrom ?? [];
  const dmPolicy = section?.dmPolicy ?? section?.dmSecurity ?? account?.dmPolicy ?? account?.dmSecurity;
  const homeChannel = section?.homeChannel ?? account?.homeChannel;
  const enabled = Boolean(appId && appSecret);
  const ackMessage = account?.ackMessage !== undefined ? account.ackMessage : (section?.ackMessage ?? false);
  const ackMessageTextZh = account?.ackMessageTextZh ?? section?.ackMessageTextZh ?? "收到，正在处理...";
  const ackMessageTextEn = account?.ackMessageTextEn ?? section?.ackMessageTextEn ?? "Received, processing...";
  const revokeAckMessage = account?.revokeAckMessage !== undefined ? account.revokeAckMessage : (section?.revokeAckMessage ?? true);
  const dangerouslyAllowPrivateNetwork = isPrivateNetworkOptInEnabled(section?.dangerouslyAllowPrivateNetwork ?? section?.allowPrivateNetwork ?? account?.dangerouslyAllowPrivateNetwork ?? null);
  const mediaLocalRoots: string[] = section?.mediaLocalRoots ?? account?.mediaLocalRoots ?? [];
  const autoMentionReply = account?.autoMentionReply !== undefined ? account.autoMentionReply : (section?.autoMentionReply ?? false);
  const autoQuoteReply = account?.autoQuoteReply !== undefined ? account.autoQuoteReply : (section?.autoQuoteReply ?? false);
  const respondToAtAll = account?.respondToAtAll !== undefined ? account.respondToAtAll : (section?.respondToAtAll ?? false);
  const execApprovals = account?.execApprovals ?? section?.execApprovals;

  return {
    accountId: resolvedAccountId || appId || null,
    appId,
    appSecret,
    apiGatewayUrl,
    allowFrom,
    dmPolicy,
    homeChannel,
    enabled,
    ackMessage,
    ackMessageTextZh,
    ackMessageTextEn,
    revokeAckMessage,
    dangerouslyAllowPrivateNetwork,
    mediaLocalRoots,
    autoMentionReply,
    autoQuoteReply,
    respondToAtAll,
    execApprovals,
  };
}

function makeClient(account: ResolvedAccount, logger?: ClientLogger): LansengerClient {
  const client = new LansengerClient({
    appId: account.appId,
    appSecret: account.appSecret,
    apiGatewayUrl: account.apiGatewayUrl,
    dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork,
    logger,
  });
  // Set ownerId so isGroupChat() can correctly identify group vs DM endpoints.
  // Without this, fresh clients default to chatId.startsWith("group:") which
  // never matches Lansenger IDs. The running client sets this from WS data.
  client.ownerId = account.appId;
  return client;
}

function resolveLansengerApprovers({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }): string[] {
  // Priority 1: per-account execApprovals.approvers (official OpenClaw channel pattern)
  const account = resolveAccount(cfg, accountId);
  if (account.execApprovals?.approvers && account.execApprovals.approvers.length > 0) {
    return account.execApprovals.approvers.map(String);
  }
  // Priority 2: commands.ownerAllowFrom (framework-level owner list)
  const commands = (cfg as any).commands ?? {};
  const explicitApprovers: string[] = commands.ownerAllowFrom ?? [];
  if (explicitApprovers.length > 0) {
    return explicitApprovers.map(String).map((id) => id.startsWith("lansenger:") ? id.slice("lansenger:".length) : id);
  }
  // Priority 3: channel allowFrom
  if (account.allowFrom.length > 0) return account.allowFrom;
  // Priority 4: homeChannel fallback
  const homeChannel = account.homeChannel;
  if (homeChannel) return [homeChannel];
  return [];
}

const approverAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Lansenger",
  resolveApprovers: resolveLansengerApprovers,
});

async function probeLansengerAccount(account: ResolvedAccount): Promise<LansengerProbeResult> {
  if (!account.appId || !account.appSecret) {
    return { ok: false, error: "missing credentials (appId, appSecret)" };
  }
  try {
    const client = makeClient(account);
    const token = await client.getAppToken();
    if (token) {
      return { ok: true, appId: account.appId };
    }
    return { ok: false, appId: account.appId, error: "Failed to obtain app token — verify appId/appSecret/apiGatewayUrl" };
  } catch (err) {
    return {
      ok: false,
      appId: account.appId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const chatPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "lansenger",
    meta: {
      label: "Lansenger (蓝信)",
      selectionLabel: "Lansenger (蓝信)",
      docsPath: "https://open.e.lanxin.cn/docs",
      blurb: "Connect OpenClaw to Lansenger enterprise messaging platform. / 连接 OpenClaw 与蓝信企业即时通讯平台。",
      markdownCapable: true,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      reply: true,
    },
    config: {
      resolveAccount,
      isConfigured: (account: ResolvedAccount, cfg: OpenClawConfig) => {
        if (account.appId && account.appSecret) return true;
        if ((account as any).configured === true) return true;
        if ((account as any).appIdStatus === "available" && (account as any).appSecretStatus === "available") return true;
        return false;
      },
      hasConfiguredState: ({ cfg, env }) => {
        const section = (cfg.channels as Record<string, any>)?.["lansenger"];
        const accounts = section?.accounts as Record<string, any> | undefined;
        if (accounts && Object.keys(accounts).length > 0) {
          return Object.values(accounts).some((a: any) => Boolean(a?.appId && a?.appSecret));
        }
        return Boolean(section?.appId && section?.appSecret) ||
          Boolean(env?.LANSENGER_APP_ID && env?.LANSENGER_APP_SECRET);
      },
      listAccountIds: (cfg) => {
        const section = (cfg.channels as Record<string, any>)?.["lansenger"];
        const accounts = section?.accounts as Record<string, any> | undefined;
        const ids: string[] = [];
        // Single account mode (appId as key)
        if (section?.appId) ids.push(section.appId);
        // Multi-account mode
        if (accounts) {
          for (const [id, account] of Object.entries(accounts)) {
            if (account?.appId) {
              // Use appId as the canonical key
              const key = account.appId;
              if (!ids.includes(key)) ids.push(key);
            }
          }
        }
        return ids;
      },
      inspectAccount: (cfg, accountId) => {
        const section = (cfg.channels as Record<string, any>)?.["lansenger"];
        const accounts = section?.accounts as Record<string, any> | undefined;
        let account: any = undefined;
        if (!accountId || accountId === "default" || accountId === DEFAULT_ACCOUNT_ID) {
          account = accounts?.default ?? section;
        } else if (section?.appId === accountId) {
          account = section;
        } else if (accounts && accounts[accountId]) {
          account = accounts[accountId];
        } else if (accounts) {
          for (const [, acc] of Object.entries(accounts)) {
            if (acc?.appId === accountId) {
              account = acc;
              break;
            }
          }
        }
        const hasCreds = Boolean(account?.appId && account?.appSecret) || Boolean(process.env.LANSENGER_APP_ID && process.env.LANSENGER_APP_SECRET);
        const displayAppId = account?.appId ?? section?.appId ?? "";
        const displayAccountId = accountId && accountId !== "default" && accountId !== DEFAULT_ACCOUNT_ID ? accountId : undefined;
        return {
          name: displayAccountId ?? displayAppId,
          appId: displayAppId,
          accountId: displayAccountId,
          enabled: Boolean((account?.enabled ?? false) || hasCreds),
          configured: hasCreds,
          appIdStatus: account?.appId ? "available" : (process.env.LANSENGER_APP_ID ? "env" : "missing"),
          appSecretStatus: account?.appSecret ? "available" : (process.env.LANSENGER_APP_SECRET ? "env" : "missing"),
          apiGatewayUrl: account?.apiGatewayUrl,
        };
      },
    },
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const channels = { ...((cfg.channels as Record<string, any>) ?? {}) };
        const current = channels.lansenger ?? {};
        const updated = { ...current };
        if (input.appToken) updated.appId = input.appToken;
        if (input.secret) updated.appSecret = input.secret;
        if (input.baseUrl) updated.apiGatewayUrl = input.baseUrl;
        channels.lansenger = updated;
        return { ...cfg, channels };
      },
    },
  }) as any,

  security: {
    dm: {
      channelKey: "lansenger",
      resolvePolicy: (account) => account.dmPolicy ?? "pairing",
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "pairing",
    },
    collectWarnings: (ctx) => {
      const warnings: string[] = [];
      const section = (ctx.cfg.channels as Record<string, any>)?.["lansenger"];
      if (!section) return warnings;
      const accounts = section.accounts as Record<string, any> | undefined;
      const topLevelAppId = section.appId;
      const topLevelAppSecret = section.appSecret;
      const hasAnyCompleteAccount = accounts
        ? Object.values(accounts).some((a: any) => Boolean(a?.appId && a?.appSecret))
        : false;
      const envHasAppId = Boolean(process.env.LANSENGER_APP_ID);
      const envHasAppSecret = Boolean(process.env.LANSENGER_APP_SECRET);
      if (!topLevelAppId && !topLevelAppSecret && !hasAnyCompleteAccount && !envHasAppId && !envHasAppSecret) {
        warnings.push("Lansenger channel is not configured: missing appId and appSecret. Run 'openclaw channels add' to set up credentials. / 蓝信频道未配置：缺少 appId 和 appSecret。运行 'openclaw channels add' 设置凭证。");
      } else if (topLevelAppId && !topLevelAppSecret && !hasAnyCompleteAccount && !envHasAppSecret) {
        warnings.push("Lansenger channel has appId but no appSecret. Add the appSecret to complete setup. / 蓝信频道有 appId 但缺少 appSecret。");
      } else if (!topLevelAppId && topLevelAppSecret && !hasAnyCompleteAccount && !envHasAppId) {
        warnings.push("Lansenger channel has appSecret but no appId. Add the appId to complete setup. / 蓝信频道有 appSecret 但缺少 appId。");
      }
      if (accounts) {
        for (const [key, acc] of Object.entries(accounts)) {
          if (acc?.appId && !acc?.appSecret) {
            warnings.push(`Lansenger account '${key}' has appId but no appSecret. / 蓝信子账号 '${key}' 有 appId 但缺少 appSecret。`);
          } else if (!acc?.appId && acc?.appSecret) {
            warnings.push(`Lansenger account '${key}' has appSecret but no appId. / 蓝信子账号 '${key}' 有 appSecret 但缺少 appId。`);
          } else if (!acc?.appId && !acc?.appSecret) {
            warnings.push(`Lansenger account '${key}' has no appId or appSecret. / 蓝信子账号 '${key}' 缺少 appId 和 appSecret。`);
          }
        }
      }
      const dmPolicy = section.dmPolicy ?? section.dmSecurity;
      if (dmPolicy && dmPolicy !== "pairing") {
        warnings.push(`Lansenger dmPolicy is '${dmPolicy}', but personal bots only receive DMs from their owner — 'pairing' is the recommended mode. / 蓝信私聊策略为 '${dmPolicy}'，但个人机器人仅接收创建者私聊，推荐使用 'pairing'。`);
      }
      const topLevelGatewayUrl = section.apiGatewayUrl;
      const envHasGatewayUrl = Boolean(process.env.LANSENGER_API_GATEWAY_URL);
      const allAccountsWithAppIdHaveGatewayUrl = accounts
        ? Object.values(accounts).every((a: any) => !a?.appId || Boolean(a?.apiGatewayUrl))
        : true;
      if (!topLevelGatewayUrl && !envHasGatewayUrl && !allAccountsWithAppIdHaveGatewayUrl && (topLevelAppId || hasAnyCompleteAccount || envHasAppId)) {
        warnings.push("Lansenger apiGatewayUrl is not set — most enterprise deployments require a custom gateway URL (e.g. https://apigw.lx.qianxin.com). The default https://open.e.lanxin.cn/open/apigw only works for Lansenger public cloud. / 蓝信 apiGatewayUrl 未设置 — 大部分企业部署需要自定义网关地址（如 https://apigw.lx.qianxin.com），默认地址仅适用于蓝信公有云。");
      }
      if (accounts) {
        for (const [key, acc] of Object.entries(accounts)) {
          if (acc?.appId && !acc?.apiGatewayUrl && !topLevelGatewayUrl && !envHasGatewayUrl) {
            warnings.push(`Lansenger account '${key}' has appId but no apiGatewayUrl (and top-level not set either). / 蓝信子账号 '${key}' 有 appId 但未设置 apiGatewayUrl（顶层也未设置）。`);
          }
          const accDmPolicy = acc?.dmPolicy;
          if (accDmPolicy && accDmPolicy !== "pairing") {
            warnings.push(`Lansenger account '${key}' dmPolicy is '${accDmPolicy}', but personal bots only receive DMs from their owner. / 蓝信子账号 '${key}' 私聊策略为 '${accDmPolicy}'，但个人机器人仅接收创建者私聊。`);
          }
        }
      }
      return warnings;
    },
    collectAuditFindings: (ctx) => {
      const findings: Array<{ checkId: string; severity: "info" | "warn" | "critical"; title: string; detail: string; remediation?: string }> = [];
      const section = (ctx.cfg.channels as Record<string, any>)?.["lansenger"];
      if (!section) return findings;
      const accounts = section.accounts as Record<string, any> | undefined;
      const topLevelAppId = section.appId;
      const topLevelAppSecret = section.appSecret;
      const hasAnyCompleteAccount = accounts
        ? Object.values(accounts).some((a: any) => Boolean(a?.appId && a?.appSecret))
        : false;
      const envHasAppId = Boolean(process.env.LANSENGER_APP_ID);
      const envHasAppSecret = Boolean(process.env.LANSENGER_APP_SECRET);
      if (!topLevelAppId && !topLevelAppSecret && !hasAnyCompleteAccount && !envHasAppId && !envHasAppSecret) {
        findings.push({ checkId: "lansenger/credentials-missing", severity: "critical", title: "Lansenger credentials not configured / 蓝信凭证未配置", detail: "The Lansenger channel has no appId or appSecret configured. The bot cannot connect. / 蓝信频道未配置 appId 和 appSecret，机器人无法连接。", remediation: "Run 'openclaw channels add' to configure credentials, or set LANSENGER_APP_ID and LANSENGER_APP_SECRET environment variables. / 运行 'openclaw channels add' 配置凭证，或设置环境变量 LANSENGER_APP_ID 和 LANSENGER_APP_SECRET。" });
      } else if (topLevelAppId && !topLevelAppSecret && !hasAnyCompleteAccount && !envHasAppSecret) {
        findings.push({ checkId: "lansenger/credentials-incomplete", severity: "critical", title: "Lansenger appSecret missing / 蓝信 appSecret 缺失", detail: "appId is set but appSecret is missing. The bot cannot authenticate. / 已配置 appId 但缺少 appSecret，机器人无法认证。", remediation: "Set the appSecret: openclaw config set channels.lansenger.appSecret <your-secret>. / 设置 appSecret：openclaw config set channels.lansenger.appSecret <你的密钥>。" });
      } else if (!topLevelAppId && topLevelAppSecret && !hasAnyCompleteAccount && !envHasAppId) {
        findings.push({ checkId: "lansenger/credentials-incomplete", severity: "critical", title: "Lansenger appId missing / 蓝信 appId 缺失", detail: "appSecret is set but appId is missing. The bot cannot identify itself. / 已配置 appSecret 但缺少 appId，机器人无法标识自身。", remediation: "Set the appId: openclaw config set channels.lansenger.appId <your-app-id>. / 设置 appId：openclaw config set channels.lansenger.appId <你的App-ID>。" });
      }
      if (accounts) {
        for (const [key, acc] of Object.entries(accounts)) {
          if (acc?.appId && !acc?.appSecret) {
            findings.push({ checkId: "lansenger/account-credentials-incomplete", severity: "warn", title: `Account '${key}' missing appSecret / 子账号 '${key}' 缺少 appSecret`, detail: `Account '${key}' has appId but no appSecret. / 子账号 '${key}' 有 appId 但缺少 appSecret。`, remediation: `openclaw config set channels.lansenger.accounts.${key}.appSecret <secret>` });
          } else if (!acc?.appId && acc?.appSecret) {
            findings.push({ checkId: "lansenger/account-credentials-incomplete", severity: "warn", title: `Account '${key}' missing appId / 子账号 '${key}' 缺少 appId`, detail: `Account '${key}' has appSecret but no appId. / 子账号 '${key}' 有 appSecret 但缺少 appId。`, remediation: `openclaw config set channels.lansenger.accounts.${key}.appId <appid>` });
          }
        }
      }
      const dmPolicy = section.dmPolicy ?? section.dmSecurity;
      if (dmPolicy && dmPolicy !== "pairing") {
        findings.push({ checkId: "lansenger/dmpolicy-not-pairing", severity: "warn", title: `dmPolicy '${dmPolicy}' is not recommended for personal bots / 私聊策略 '${dmPolicy}' 不适合个人机器人`, detail: "Lansenger personal bots only receive DMs from their owner. 'pairing' is the only effective mode. / 蓝信个人机器人仅接收创建者私聊，'pairing' 是唯一有效模式。", remediation: "openclaw config set channels.lansenger.dmPolicy pairing" });
      }
      if (accounts) {
        for (const [key, acc] of Object.entries(accounts)) {
          const accDmPolicy = acc?.dmPolicy;
          if (accDmPolicy && accDmPolicy !== "pairing") {
            findings.push({ checkId: "lansenger/account-dmpolicy-not-pairing", severity: "warn", title: `Account '${key}' dmPolicy '${accDmPolicy}' not recommended / 子账号 '${key}' 私聊策略 '${accDmPolicy}' 不适合个人机器人`, detail: "Personal bots only receive DMs from their owner. / 个人机器人仅接收创建者私聊。", remediation: `openclaw config set channels.lansenger.accounts.${key}.dmPolicy pairing` });
          }
        }
      }
      const topLevelGatewayUrl = section.apiGatewayUrl;
      const envHasGatewayUrl = Boolean(process.env.LANSENGER_API_GATEWAY_URL);
      const allAccountsWithAppIdHaveGatewayUrl = accounts
        ? Object.values(accounts).every((a: any) => !a?.appId || Boolean(a?.apiGatewayUrl))
        : true;
      if (!topLevelGatewayUrl && !envHasGatewayUrl && !allAccountsWithAppIdHaveGatewayUrl && (topLevelAppId || hasAnyCompleteAccount || envHasAppId)) {
        findings.push({ checkId: "lansenger/apigatewayurl-not-set", severity: "warn", title: "apiGatewayUrl not set / API 网关地址未设置", detail: "Most enterprise deployments require a custom gateway URL (e.g. https://apigw.lx.qianxin.com). The default https://open.e.lanxin.cn/open/apigw only works for Lansenger public cloud. / 大部分企业部署需要自定义网关地址，默认地址仅适用于蓝信公有云。", remediation: "openclaw config set channels.lansenger.apiGatewayUrl https://apigw.lx.qianxin.com (or your enterprise gateway URL)" });
      }
      if (accounts) {
        for (const [key, acc] of Object.entries(accounts)) {
          if (acc?.appId && !acc?.apiGatewayUrl && !topLevelGatewayUrl && !envHasGatewayUrl) {
            findings.push({ checkId: "lansenger/account-apigatewayurl-not-set", severity: "warn", title: `Account '${key}' apiGatewayUrl not set / 子账号 '${key}' API 网关地址未设置`, detail: `Account '${key}' has appId but no apiGatewayUrl (and top-level not set either). / 子账号 '${key}' 有 appId 但未设置 apiGatewayUrl，顶层也未设置。`, remediation: `openclaw config set channels.lansenger.accounts.${key}.apiGatewayUrl <gateway-url> or set top-level apiGatewayUrl` });
          }
        }
      }
      if (isPrivateNetworkOptInEnabled(section?.dangerouslyAllowPrivateNetwork ?? section?.allowPrivateNetwork ?? null)) {
        findings.push({ checkId: "lansenger/dangerously-allow-private-network", severity: "warn", title: "dangerouslyAllowPrivateNetwork is enabled / dangerouslyAllowPrivateNetwork 已启用", detail: "Lansenger sendImageUrl SSRF protection is disabled — image URLs targeting private/internal networks (RFC1918, link-local, metadata IPs) will be allowed. This is a security risk in production. / 蓝信图片 URL SSRF 防护已禁用——指向内网的图片 URL 将被允许，这在生产环境中存在安全风险。", remediation: "Remove dangerouslyAllowPrivateNetwork from config or set it to false. Only enable in trusted/isolated environments. / 删除 dangerouslyAllowPrivateNetwork 配置或设为 false，仅在可信/隔离环境中启用。" });
      }
      return findings;
    },
  },

  pairing: {
    text: {
      idLabel: "Lansenger user ID (蓝信用户 ID)",
      message: "Send this pairing code to verify your identity / 发送此配对码验证身份:",
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolveAccount(cfg, accountId ?? undefined);
        const client = makeClient(account);
        await client.sendFormatText(id, message);
      },
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      channel: "lansenger",
      sendText: async (ctx) => {
        const sdkSessionKey = (ctx as any).sessionKey as string | undefined;
        const sessionAccountId = sdkSessionKey ? getSessionAccountId(sdkSessionKey) : undefined;
        const account = resolveAccount(ctx.cfg, sessionAccountId ?? ctx.accountId);
        const client = getRunningClientByAccountId(account.appId) ?? makeClient(account);
        log.debug(`sendText: to=${ctx.to} textLen=${ctx.text?.length ?? 0} accountId=${ctx.accountId ?? "n/a"}`);
        const result = await client.sendFormatText(ctx.to, ctx.text);
        return { messageId: result.messageId ?? "", sessionKey: sdkSessionKey };
      },
      sendMedia: async (ctx) => {
        const sessionKey = (ctx as any).sessionKey as string | undefined;
        const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
        const client = makeClient(account);
        const caption = ctx.text ?? "";

        if (ctx.mediaUrl && /^https?:\/\//i.test(ctx.mediaUrl)) {
          const result = await client.sendImageUrl(ctx.to, ctx.mediaUrl, caption, account.dangerouslyAllowPrivateNetwork);
          return { messageId: result.messageId ?? "", sessionKey };
        }

        if (ctx.mediaUrl) {
          if (!isPathAllowed(ctx.mediaUrl, account.mediaLocalRoots)) {
            log.warn(`sendMedia: path '${ctx.mediaUrl}' outside mediaLocalRoots — blocked`);
            return { messageId: "", sessionKey };
          }
          const readFile = ctx.mediaReadFile ?? ctx.mediaAccess?.readFile;
          if (readFile) {
            const buffer = await readFile(ctx.mediaUrl);
            const srcExt = path.extname(ctx.mediaUrl).toLowerCase();
            const ext = srcExt || (ctx.audioAsVoice ? ".amr" : ".dat");
            const originalName = stripOpenClawUuidSuffix(path.basename(ctx.mediaUrl));
            const tmpPath = path.join(os.tmpdir(), `lansenger_media_${crypto.randomUUID()}${ext}`);
            await fs.writeFile(tmpPath, buffer);
            const mt = ctx.audioAsVoice ? 4 : undefined;
            try {
              const result = await client.sendFile(ctx.to, tmpPath, caption, mt, srcExt ? originalName : undefined);
              return { messageId: result.messageId ?? "", sessionKey };
            } finally {
              try { await fs.unlink(tmpPath); } catch {}
            }
          }
          const result = await client.sendFile(ctx.to, ctx.mediaUrl, caption);
          return { messageId: result.messageId ?? "", sessionKey };
        }

        return { messageId: "", sessionKey };
      },
    },
    base: {
      deliveryMode: "direct" as const,
      normalizePayload: (params: any) => {
        const payload = params.payload as any;
        const hasCodeBlock = payload?.text && /```/.test(payload.text);
        if (payload?.text && !payload?.mediaUrl && !payload?.presentation) {
          return { ...payload, _lansengerFormatText: true };
        }
        if (hasCodeBlock && payload?.text) {
          return { ...payload, _lansengerFormatText: true };
        }
        return payload ?? null;
      },
      beforeDeliverPayload: async (params: any) => {
        const target = params.target as any;
        const payload = params.payload as any;
        const hint = params.hint as any;

        if (hint?.kind === "approval-resolved") {
          const chatId = target?.to;
          const cardKey = target?.accountId ? `${target.accountId}:${chatId}` : chatId;
          const cardInfo = pendingApprovalCards.get(cardKey);
          if (cardInfo?.messageId) {
            const account = resolveAccount(params.cfg, target?.accountId ?? undefined);
            const client = makeClient(account);
            const status: "approved" | "denied" = payload?.text?.includes("✅") ? "approved" : "denied";
            try {
              await client.updateCardStatus(cardInfo.messageId, status, cardInfo.lang);
              pendingApprovalCards.delete(cardKey);
            } catch (e: unknown) {
              log.error(`beforeDeliverPayload: card update failed — ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      },
      sendFormattedText: async (ctx) => {
        const sdkSessionKey = (ctx as any).sessionKey as string | undefined;
        const sessionAccountId = sdkSessionKey ? getSessionAccountId(sdkSessionKey) : undefined;
        const account = resolveAccount(ctx.cfg, sessionAccountId ?? ctx.accountId);
        const client = getRunningClientByAccountId(account.appId) ?? makeClient(account);
        log.debug(`sendFormattedText: to=${ctx.to} textLen=${ctx.text?.length ?? 0} accountId=${account.appId ?? "n/a"}`);
        const result = await client.sendFormatText(ctx.to, ctx.text);
        log.debug(`sendFormattedText: result — success=${result.success} messageId=${result.messageId ?? "none"} error=${result.error ?? "none"}`);
        return [{ channel: "lansenger", messageId: result.messageId ?? "", sessionKey: sdkSessionKey }];
      },
      textChunkLimit: LANSENGER_TEXT_CHUNK_LIMIT,
      chunkerMode: "markdown",
      chunker: (text: string, limit: number, ctx?: any) => {
        const mode = ctx?.formatting?.chunkMode ?? "length";
        return chunkMarkdownTextWithMode(text, limit, mode as "length" | "newline");
      },
      resolveEffectiveTextChunkLimit: (params: any) => {
        return resolveTextChunkLimit(params.cfg, "lansenger", params.accountId, { fallbackLimit: LANSENGER_TEXT_CHUNK_LIMIT });
      },
      shouldSuppressLocalPayloadPrompt: (params: any) => {
        // Suppress the native approval text — we use approval cards instead.
        return params.hint?.kind === "approval-pending";
      },
    },
  },
});

const lansengerOnboarding = {
  configuredCheck: (cfg: any) => {
    const section = (cfg.channels as Record<string, any>)?.["lansenger"];
    const accounts = section?.accounts as Record<string, any> | undefined;
    if (accounts && Object.keys(accounts).length > 0) {
      return Object.values(accounts).some((a: any) => a?.appId && a?.appSecret);
    }
    return Boolean(section?.appId && section?.appSecret);
  },
  setDmPolicy: (cfg: any, policy: string) => {
    const channels = { ...((cfg.channels as Record<string, any>) ?? {}) };
    const current = channels.lansenger ?? {};
    channels.lansenger = { ...current, dmPolicy: policy };
    return { ...cfg, channels };
  },
  promptAllowFrom: async (params: any) => {
    const { cfg, prompter, accountId } = params;
    const section = (cfg.channels as Record<string, any>)?.["lansenger"] ?? {};
    const accounts = section?.accounts as Record<string, any> | undefined;
    const account = accountId ? accounts?.[accountId] : section;
    const currentAllowFrom: string[] = account?.allowFrom ?? [];
    const input = await prompter.text({
      message: "Lansenger User ID (蓝信用户 ID，格式：orgId-applicationId)",
      placeholder: "xxx-xxxxxxx",
      initialValue: currentAllowFrom[0] ? String(currentAllowFrom[0]) : undefined,
      validate: (v: string) => String(v ?? "").trim() ? undefined : "Required / 必填",
    });
    const newId = String(input).trim();
    const merged = [...currentAllowFrom.map(String).filter(Boolean), newId];
    const unique = [...new Set(merged)];
    const channels = { ...((cfg.channels as Record<string, any>) ?? {}) };
    const current = channels.lansenger ?? {};
    const accountsCopy = current.accounts ? { ...current.accounts } : {};
    if (accountId && accountsCopy[accountId]) {
      accountsCopy[accountId] = { ...accountsCopy[accountId], allowFrom: unique };
    } else {
      current.allowFrom = unique;
    }
    channels.lansenger = { ...current, enabled: true, accounts: accountsCopy, dmPolicy: current.dmPolicy ?? current.dmSecurity ?? "pairing" };
    return { ...cfg, channels };
  },
  noteSetupHelp: async (params: any) => {
    const { prompter } = params;
    await prompter.note([
      "Lansenger (蓝信) Personal Bot Setup Guide / 个人机器人配置指南",
      "",
      "📍 Get Credentials / 获取凭证:",
      "   Lansenger Desktop → Contacts → Bots → Personal Bots / 蓝信桌面端 → 通讯录 → 智能机器人 → 个人机器人",
      "   → Click ℹ️ icon to view App ID and App Secret / 点击右侧 ℹ️ 图标查看 App ID 和 App Secret",
      "",
      "   ⚠️ Personal Bots only (organization bots not supported) / 仅支持个人机器人（不支持组织机器人）",
      "   ⚠️ Mobile client does NOT support viewing credentials / 移动端不支持查看凭证",
      "",
      "   Create a new bot / 创建新机器人:",
      "   Contacts → Bots → Personal Bots → Create / 通讯录 → 智能机器人 → 个人机器人 → 创建",
      "",
      "🔧 After Getting Credentials / 获取凭证后:",
      "   1. Enter App ID and App Secret in the configuration / 在配置中输入 App ID 和 App Secret",
      "   2. API Gateway URL is optional / API 网关地址可选",
      "      Default: https://open.e.lanxin.cn/open/apigw (Lansenger public cloud) /",
      "      默认：https://open.e.lanxin.cn/open/apigw（蓝信公有云）",
      "",
      "🤝 Multi-Bot Support / 多机器人支持:",
      "   - Each bot has independent App ID and App Secret / 每个机器人配置独立的 App ID 和 App Secret",
      "   - Bots can be bound to different OpenClaw Agents / 可将不同机器人绑定到不同 OpenClaw Agent",
      "   - Each bot can use a different API Gateway URL / 每个机器人可使用不同的 API 网关地址",
      "",
      "📨 After Setup / 配置完成后:",
      "   - Bot receives messages via WebSocket long connection / 机器人通过 WebSocket 长连接接收消息",
      "   - Replies via formatText (Markdown) or text (plain text) / 通过 formatText (Markdown) 或 text (纯文本) 发送回复",
      "",
      "🔐 DM Security / 私聊安全:",
      "   - Default: pairing mode / 默认：配对模式",
      "   - First DM triggers a pairing code / 首次私聊会触发配对码",
      "   - Approve with: openclaw pairing approve lansenger <code> / 审批：openclaw pairing approve lansenger <配对码>",
      "   - Personal bots only receive DMs from their owner / 个人机器人仅接收归属人的私聊消息",
    ], "Lansenger Setup / 蓝信配置");
  },
  runSetupWizard: async (params: any) => {
    const { cfg, prompter, token } = params;
    let appId: string | null = null;
    let appSecret: string | null = null;
    let apiGatewayUrl: string | null = null;

    if (token) {
      const [id, secret, ...rest] = token.split(":");
      if (id && secret) {
        appId = id.trim();
        appSecret = secret.trim();
        if (rest.length > 0) apiGatewayUrl = rest.join(":").trim();
      }
    }

    const section = (cfg.channels as Record<string, any>)?.["lansenger"] ?? {};
    const accounts = section?.accounts as Record<string, any> | undefined;
    const alreadyConfigured = Boolean(section.appId && section.appSecret) || (accounts && Object.keys(accounts).length > 0);

    if (!alreadyConfigured && !appId) {
      await prompter.note([
        "Lansenger (蓝信) Personal Bot Setup / 个人机器人配置",
        "",
        "📍 Get Credentials / 获取凭证:",
        "   Lansenger Desktop → Contacts → Bots → Personal Bots / 蓝信桌面端 → 通讯录 → 智能机器人 → 个人机器人",
        "   → Click ℹ️ icon to view credentials / 点击 ℹ️ 图标查看凭证",
        "",
        "   ⚠️ Personal Bots only / 仅支持个人机器人",
        "   ⚠️ Mobile client NOT supported / 移动端不支持",
        "",
        "App ID and App Secret are required to continue / 需要 App ID 和 App Secret 才能继续",
      ], "Lansenger Setup / 蓝信配置");
    }

    if (!appId) {
      appId = String(await prompter.text({
        message: "Lansenger App ID / 蓝信 App ID",
        placeholder: "e.g. xxx-xxxxxxx",
        validate: (v: string) => String(v ?? "").trim() ? undefined : "Required / 必填",
      })).trim();
      appSecret = String(await prompter.text({
        message: "Lansenger App Secret / 蓝信 App Secret",
        placeholder: "e.g. ABCDEF123456...",
        validate: (v: string) => String(v ?? "").trim() ? undefined : "Required / 必填",
      })).trim();
      apiGatewayUrl = String(await prompter.text({
        message: "API Gateway URL (Optional / 可选)",
        initialValue: "https://open.e.lanxin.cn/open/apigw",
        validate: () => undefined,
      })).trim();
    }

    const channels = { ...((cfg.channels as Record<string, any>) ?? {}) };
    const current = channels.lansenger ?? {};
    const accountsCopy = current.accounts ? { ...current.accounts } : {};

    if (appId && appSecret) {
      const accountEntry = {
        appId,
        appSecret,
        apiGatewayUrl: apiGatewayUrl || undefined,
        enabled: true,
        dmPolicy: current.dmPolicy ?? current.dmSecurity ?? "pairing",
        allowFrom: current.allowFrom ?? [],
        approval: { enabled: true, highRiskTools: "write,delete,trash,rm" },
      };

      if (alreadyConfigured) {
        const keep = await prompter.confirm({
          message: "Existing config found. Add as new bot or replace? / 已存在配置，添加新机器人还是替换？",
          initialValue: false,
          yesLabel: "Add new bot / 添加新机器人",
          noLabel: "Replace / 替换",
        });
        if (keep) {
          accountsCopy[appId] = accountEntry;
          current.accounts = accountsCopy;
          delete current.appId;
          delete current.appSecret;
        } else {
          Object.assign(current, accountEntry);
        }
      } else {
        Object.assign(current, accountEntry);
      }
    }

    channels.lansenger = current;
    return { ...cfg, channels };
  },
};

export const lansengerPlugin: ChannelPlugin<ResolvedAccount, LansengerProbeResult> = {
  ...chatPlugin as any,
  setupWizard: lansengerSetupWizard,
  gateway: {
    startAccount: gatewayStartAccount,
    stopAccount: gatewayStopAccount,
  },
  status: {
    buildChannelSummary: ({ snapshot, cfg }) => {
      const hasCfg = (() => {
        const section = (cfg.channels as Record<string, any>)?.["lansenger"];
        const accounts = section?.accounts as Record<string, any> | undefined;
        const topLevel = Boolean(section?.appId && section?.appSecret);
        const fromAccounts = accounts && Object.keys(accounts).length > 0
          ? Object.values(accounts).some((a: any) => Boolean(a?.appId && a?.appSecret))
          : false;
        const fromEnv = Boolean(process.env.LANSENGER_APP_ID && process.env.LANSENGER_APP_SECRET);
        return topLevel || fromAccounts || fromEnv;
      })();
      const patched = { ...snapshot, configured: snapshot.configured || hasCfg };
      return buildProbeChannelStatusSummary(patched);
    },
    probeAccount: async ({ account, timeoutMs, cfg }) => {
      return await probeLansengerAccount(account);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const liveClient = getRunningClientByAccountId(account.accountId ?? account.appId);
      const connected = liveClient?.isWsAlive() ?? false;
      const lastInboundAt = getLastInboundTimeByAccountId(account.accountId ?? account.appId);
      return {
        accountId: account.accountId ?? account.appId ?? DEFAULT_ACCOUNT_ID,
        enabled: account.enabled,
        configured: account.configured ?? (Boolean(account.appId && account.appSecret) || Boolean(process.env.LANSENGER_APP_ID && process.env.LANSENGER_APP_SECRET)),
        name: account.accountId ?? account.appId ?? DEFAULT_ACCOUNT_ID,
        appId: account.appId,
        running: connected || (runtime?.running ?? false),
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        connected,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastInboundAt,
      };
    },
  },
  onboarding: lansengerOnboarding as any,
  approvalCapability: createChannelApprovalCapability({
    authorizeActorAction: approverAuth.authorizeActorAction,
    getActionAvailabilityState: ({ cfg, accountId }: any) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled) return { kind: "unsupported" };
      return { kind: "enabled" };
    },
    delivery: {
      shouldSuppressForwardingFallback: () => true,
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId }: any) => ({
        enabled: true,
        preferredSurface: "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
      }),
      resolveOriginTarget: ({ cfg, accountId, request }: any) => {
        const req = request?.request ?? request;
        const to = req?.turnSourceTo ?? req?.sessionTarget?.to;
        if (to) return { to, threadId: null, accountId: accountId ?? null };
        return null;
      },
    },
    nativeRuntime: {
      eventKinds: ["exec", "plugin"],
      availability: {
        isConfigured: ({ cfg, accountId }: any) => {
          const account = resolveAccount(cfg, accountId);
          return account.enabled;
        },
        shouldHandle: ({ cfg, accountId, request }: any) => {
          const account = resolveAccount(cfg, accountId);
          return account.enabled;
        },
      } as any,
      presentation: {
        buildPendingPayload: ({ cfg, request, target, nowMs, view }: any) => {
          const req = request?.request ?? request;
          const commandPreview = (req?.command ?? req?.summary ?? "").slice(0, 300);
          const sessionKey = req?.sessionKey ?? "unknown";
          log.debug(`buildPendingPayload: command="${commandPreview.slice(0, 60)}" sessionKey="${sessionKey.slice(0, 40)}" requestKeys=${Object.keys(request ?? {}).join(",")} reqKeys=${Object.keys(req ?? {}).join(",")}`);
          const requestId = request?.id ?? req?.id ?? "unknown";
          const shortId = requestId.length > 8 ? requestId.slice(0, 8) : requestId;
          const approverIds = resolveLansengerApprovers({ cfg, accountId: target?.accountId ?? null });
          const buttonScope: ApproveCardButton["permissionScope"] = approverIds.length > 0
            ? { permittedStaffs: approverIds }
            : undefined;
          // Expiration: view.expiresAtMs is absolute ms, compute remaining seconds
          const expireTime = view?.expiresAtMs ? Math.max(1, Math.ceil((view.expiresAtMs - nowMs) / 1000)) : undefined;
          // Use the framework's allowedDecisions to determine which buttons to show.
          // When exec.ask is "always", only allow-once + deny are available (no session/always).
          const allowedDecisions: string[] = req?.allowedDecisions ?? ["allow-once", "allow-session", "allow-always", "deny"];
          const showSession = allowedDecisions.includes("allow-session");
          const showAlways = allowedDecisions.includes("allow-always");
          log.debug(`buildPendingPayload: allowedDecisions=${allowedDecisions.join(",")} showSession=${showSession} showAlways=${showAlways}`);
          const zhCard: ApproveCardData = {
            head: {
              title: "⚠️ 命令审批",
              headStatus: {
                describe: "待审批",
                colour: "#FFB116",
                statusIcon: 1,
              },
            },
            body: {
              title: "危险命令审批请求",
              content: {
                formatType: 1,
                text: [
                  `**会话 ID**`,
                  sessionKey,
                  "",
                  `**命令**`,
                  "```",
                  commandPreview,
                  "```",
                  "",
                  `> 按钮不可用时请发送命令审批：`,
                  "",
                  `> 执行一次`,
                  "> ```",
                  `> /approve ${shortId} allow-once`,
                  "> ```",
                  "",
                  ...(showSession ? [
                    `> 本会话有效`,
                    "> ```",
                    `> /approve ${shortId} allow-session`,
                    "> ```",
                    "",
                  ] : []),
                  ...(showAlways ? [
                    `> 永久允许`,
                    "> ```",
                    `> /approve ${shortId} allow-always`,
                    "> ```",
                    "",
                  ] : []),
                  `> 拒绝执行`,
                  "> ```",
                  `> /approve ${shortId} deny`,
                  "> ```",
                ].join("\n"),
              },
            },
            buttons: [
              { text: "执行一次", buttonTheme: 1, permissionScope: buttonScope, callbackInfo: `once:${requestId}` },
              ...(showSession ? [{ text: "本会话有效", buttonTheme: 2, permissionScope: buttonScope, callbackInfo: `session:${requestId}` }] : []),
              ...(showAlways ? [{ text: "永久允许", buttonTheme: 3, permissionScope: buttonScope, callbackInfo: `always:${requestId}` }] : []),
              { text: "拒绝执行", buttonTheme: 4, permissionScope: buttonScope, callbackInfo: `deny:${requestId}` },
            ],
            expireTime,
          };
          const enCard: ApproveCardData = {
            head: {
              title: "⚠️ Command Approval",
              headStatus: {
                describe: "Pending",
                colour: "#FFB116",
                statusIcon: 1,
              },
            },
            body: {
              title: "Dangerous Command Approval Request",
              content: {
                formatType: 1,
                text: [
                  `**Session**`,
                  sessionKey,
                  "",
                  `**Command**`,
                  "```",
                  commandPreview,
                  "```",
                  "",
                  `> If buttons are unavailable, use:`,
                  "",
                  `> Approve once`,
                  "> ```",
                  `> /approve ${shortId} allow-once`,
                  "> ```",
                  "",
                  ...(showSession ? [
                    `> This session`,
                    "> ```",
                    `> /approve ${shortId} allow-session`,
                    "> ```",
                    "",
                  ] : []),
                  ...(showAlways ? [
                    `> Always allow`,
                    "> ```",
                    `> /approve ${shortId} allow-always`,
                    "> ```",
                    "",
                  ] : []),
                  `> Deny`,
                  "> ```",
                  `> /approve ${shortId} deny`,
                  "> ```",
                ].join("\n"),
              },
            },
            buttons: [
              { text: "Approve Once", buttonTheme: 1, permissionScope: buttonScope, callbackInfo: `once:${requestId}` },
              ...(showSession ? [{ text: "This Session", buttonTheme: 2, permissionScope: buttonScope, callbackInfo: `session:${requestId}` }] : []),
              ...(showAlways ? [{ text: "Always Allow", buttonTheme: 3, permissionScope: buttonScope, callbackInfo: `always:${requestId}` }] : []),
              { text: "Deny", buttonTheme: 4, permissionScope: buttonScope, callbackInfo: `deny:${requestId}` },
            ],
            expireTime,
          };
          return { type: "approveCard", zh: zhCard, en: enCard, isDynamic: true, requestId, sessionKey };
        },
        buildResolvedResult: ({ cfg, resolved, entry }: any) => {
          // Dump all params to understand the resolved structure from native approval runtime
          const resolvedType = typeof resolved;
          const resolvedKeys = resolved && typeof resolved === "object" ? Object.keys(resolved) : [];
          const resolvedRaw = resolved && typeof resolved === "object" ? JSON.stringify(resolved).slice(0, 200) : String(resolved);
          log.debug(`buildResolvedResult: resolved.type=${resolvedType} keys=[${resolvedKeys.join(",")}] raw=${resolvedRaw} entryKeys=${entry ? Object.keys(entry).join(",") : "no-entry"}`);
          
          const kindFromStrategy = resolved?.strategy?.kind as string | undefined;
          const kindFromResolved = resolved?.kind as string | undefined;
          const decisionFromResolved = resolved?.decision as string | undefined; // webchat/control-ui resolution
          const strategyKind = kindFromStrategy ?? kindFromResolved ?? decisionFromResolved ?? "deny";
          // Button theme: 1=primary (allow-once), 2=secondary (allow-session), 3=secondary-black (allow-always), 4=warning (deny)
          const buttonThemeMap: Record<string, number> = { "allow-once": 1, "allow-session": 2, "allow-always": 3, deny: 4 };
          const resolvedButtonTheme = buttonThemeMap[strategyKind] ?? 4;
          // Only consider known approved kinds as approved; everything else is denied.
          // This is safer than trying to enumerate all possible deny values.
          const approvedKinds = new Set(["approved", "allow-once", "allow-session", "allow-always"]);
          if (approvedKinds.has(strategyKind)) {
            return { kind: "update", payload: { status: "approved", strategyKind, buttonTheme: resolvedButtonTheme } };
          }
          return { kind: "update", payload: { status: "denied", strategyKind: "deny", buttonTheme: 4 } };
        },
        buildExpiredResult: ({ cfg, request, entry }: any) => {
          return { kind: "update", payload: { status: "denied", strategyKind: "expired" } };
        },
      } as any,
      transport: {
        prepareTarget: ({ cfg, accountId, plannedTarget }: any) => {
          const to = plannedTarget?.target?.to ?? plannedTarget?.to;
          if (!to) return null;
          return { dedupeKey: to, target: { to, threadId: null, accountId: accountId ?? null } };
        },
        deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }: any) => {
          const target = preparedTarget?.target ?? preparedTarget;
          const payload = pendingPayload;
          const account = resolveAccount(cfg, accountId);
          const client = makeClient(account);
          if (payload?.type === "approveCard") {
            const lang = client.getUserLang(target.to);
            const approveCard = (lang === "zh" ? payload.zh : payload.en) ?? payload.en;
            const result = await client.sendApproveCard(target.to, approveCard as ApproveCardData);
            if (result.messageId) {
              const cardKey = account.accountId ? `${account.accountId}:${target.to}` : target.to;
              pendingApprovalCards.set(cardKey, { messageId: result.messageId, lang: lang as "zh" | "en" });
              // Store callback mapping for button click resolution
              if (payload.requestId) {
                pendingApprovalCallbacks.set(payload.requestId, {
                  messageId: result.messageId,
                  lang: lang as "zh" | "en",
                  chatId: target.to,
                  sessionKey: payload.sessionKey ?? "unknown",
                });
              }
            }
            return { delivered: result.success, messageId: result.messageId ?? null, to: target.to, lang };
          }
          if (payload?.type === "text" && payload?.text) {
            const result = await client.sendFormatText(target.to, payload.text);
            return { delivered: result.success, messageId: result.messageId ?? null };
          }
          return { delivered: false, messageId: null };
        },
        updateEntry: async ({ cfg, accountId, entry, payload, phase }: any) => {
          const messageId = entry?.messageId;
          const to = entry?.to;
          const lang = entry?.lang ?? "zh";
          if (!messageId || !to) return;
          const account = resolveAccount(cfg, accountId);
          const client = makeClient(account);
          const status = payload?.status ?? (phase === "expired" ? "denied" : "pending");
          const strategyKind = payload?.strategyKind;
          const buttonTheme = payload?.buttonTheme as number | undefined;
          await client.updateCardStatus(messageId, status as "approved" | "denied", lang, strategyKind, buttonTheme);
          // Clean up callback mapping (search by messageId since requestId is not in entry)
          for (const [key, val] of pendingApprovalCallbacks.entries()) {
            if (val.messageId === messageId) {
              pendingApprovalCallbacks.delete(key);
              break;
            }
          }
        },
        deleteEntry: async ({ cfg, accountId, entry, phase }: any) => {
          const messageId = entry?.messageId;
          const to = entry?.to;
          if (!messageId) return;
          const account = resolveAccount(cfg, accountId);
          const client = makeClient(account);
          const isGroup = to ? client.isGroupChat(to) : false;
          await client.revokeMessage([messageId], isGroup ? "group" : "bot");
          // Clean up callback mapping
          for (const [key, val] of pendingApprovalCallbacks.entries()) {
            if (val.messageId === messageId) {
              pendingApprovalCallbacks.delete(key);
              break;
            }
          }
        },
      } as any,
    } as any,
  }),

  message: createChannelMessageAdapterFromOutbound({
    outbound: {
      sendText: async (ctx: any) => {
         const sdkSessionKey = (ctx as any).sessionKey as string | undefined;
          const sessionAccountId = sdkSessionKey ? getSessionAccountId(sdkSessionKey) : undefined;
          const account = resolveAccount(ctx.cfg, sessionAccountId ?? ctx.accountId);
         const client = getRunningClientByAccountId(account.appId) ?? makeClient(account);
         log.debug(`message.sendText: to=${ctx.to} textLen=${ctx.text?.length ?? 0}`);
         const result = await client.sendFormatText(ctx.to, ctx.text);
         log.debug(`message.sendText: result — success=${result.success} messageId=${result.messageId ?? "none"}`);
         return { messageId: result.messageId ?? "" };
      },
    },
  }),

  commands: {
    nativeCommandsAutoEnabled: true,
    nativeSkillsAutoEnabled: true,
  },

  actions: {
    describeMessageTool: ({ cfg, accountId, senderIsOwner }: any) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled) return null;
      return {
        actions: ["send", "delete"],
        capabilities: ["presentation"],
        schema: [{
          properties: {
            action: { const: "send", description: "Send a message, optionally with a file attachment. If filePath is provided, the file is delivered as an attachment (caption must be plain text — no Markdown). If filePath is omitted, the message text is sent as Markdown. The `to` parameter is optional — omit it to send to the current conversation target automatically. Do NOT use MEDIA: tags for file delivery on Lansenger — use this send action with filePath instead." },
            filePath: { type: "string", description: "Absolute local path to a file to send as attachment. Any local path works. Optional — omit for plain text/Markdown messages." },
            caption: { type: "string", description: "Plain-text caption for the file attachment (Markdown will NOT render). Only used when filePath is provided." },
            to: { type: "string", description: "Lansenger target chat ID. Optional — defaults to the current conversation if omitted." },
          },
          actions: ["send"],
          visibility: "current-channel",
        }],
        mediaSourceParams: { send: ["filePath"] },
      };
    },
    handleAction: async (ctx: any) => {
      const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
      const client = makeClient(account);
      const sessionTarget = (() => {
        if (ctx.sessionKey) {
          const parts = String(ctx.sessionKey).split(":");
          if (parts.length >= 3) return parts[2];
        }
        return ctx.requesterSenderId ?? "";
      })();
      const to = ctx.args?.to ?? sessionTarget;

      if (ctx.action === "send") {
        const filePath = ctx.args?.filePath ?? ctx.args?.mediaUrl ?? ctx.args?.media ?? "";
        const caption = ctx.args?.caption ?? ctx.args?.text ?? "";
        const text = ctx.args?.text ?? ctx.args?.content ?? ctx.args?.message ?? "";
        log.debug(`tool:send to=${to} filePath=${filePath || "none"} textLen=${text.length} captionLen=${caption.length}`);
        if (filePath) {
          const resolved = path.resolve(filePath);
          try {
            const stat = await fs.stat(resolved);
            if (!stat.isFile()) return { success: false, error: `Not a file: ${filePath}` };
          } catch {
            return { success: false, error: `File not found: ${filePath}` };
          }
          if (!to) return { success: false, error: "No target specified and no active session context. Provide a 'to' parameter." };
          const result = await client.sendFile(to, resolved, caption);
          return { success: result.success, data: { messageId: result.messageId } };
        }
        if (!to || !text) return { success: false, error: "to and text are required for text messages" };
        const result = await client.sendFormatText(to, text);
        return { success: result.success, data: { messageId: result.messageId } };
      }

      if (ctx.action === "delete") {
        const messageId = ctx.args?.messageId ?? "";
        log.debug(`tool:delete messageId=${messageId}`);
        const isGroup = client.isGroupChat(to);
        const result = await client.revokeMessage([messageId], isGroup ? "group" : "bot");
        return { success: result.success };
      }

      return { success: false, error: `Unknown action: ${ctx.action}` };
    },
  },
  doctor: {
    repairConfig: ({ cfg }) => {
      const channels = { ...((cfg.channels as Record<string, any>) ?? {}) };
      const section = channels.lansenger ?? {};
      const changes: string[] = [];
      const updated = { ...section };
      const dmPolicy = updated.dmPolicy ?? updated.dmSecurity;
      if (dmPolicy && dmPolicy !== "pairing") {
        updated.dmPolicy = "pairing";
        if (updated.dmSecurity) delete updated.dmSecurity;
        changes.push(`Set dmPolicy to 'pairing' (personal bots only receive DMs from owner) / 将私聊策略设为 'pairing'`);
      }
      const accounts = updated.accounts as Record<string, any> | undefined;
      if (accounts) {
        const accountsCopy = { ...accounts };
        for (const [key, acc] of Object.entries(accountsCopy)) {
          const accDmPolicy = acc?.dmPolicy;
          if (accDmPolicy && accDmPolicy !== "pairing") {
            accountsCopy[key] = { ...acc, dmPolicy: "pairing" };
            changes.push(`Set account '${key}' dmPolicy to 'pairing' / 将子账号 '${key}' 私聊策略设为 'pairing'`);
          }
        }
        updated.accounts = accountsCopy;
      }
      channels.lansenger = updated;
      return { config: { ...cfg, channels }, changes };
    },
  },
};

export { resolveAccount, makeClient, isPathAllowed, pendingApprovalCards, pendingApprovalCallbacks, LANSENGER_TEXT_CHUNK_LIMIT, resolveLansengerApprovers };
export type { ResolvedAccount };