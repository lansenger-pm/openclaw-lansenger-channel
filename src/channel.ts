import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-runtime";
import { createResolvedApproverActionAuthAdapter } from "openclaw/plugin-sdk/approval-auth-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { LansengerClient, DEFAULT_API_GATEWAY_URL } from "./client.js";
import type { AppCardData, I18nAppCardData, ClientLogger } from "./client.js";

type LansengerAccount = {
  appId?: string;
  appSecret?: string;
  apiGatewayUrl?: string;
  allowFrom?: string[];
  dmSecurity?: string;
  homeChannel?: string;
  enabled?: boolean;
  agentId?: string;
};

type ResolvedAccount = {
  accountId: string | null;
  appId: string;
  appSecret: string;
  apiGatewayUrl: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  homeChannel: string | undefined;
  enabled: boolean;
  agentId?: string;
};

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.["lansenger"];
  const accounts = section?.accounts as Record<string, LansengerAccount> | undefined;
  const defaultAccount = section?.defaultAccount as string | undefined;

  let resolvedAccountId: string | null = accountId ?? defaultAccount ?? null;
  let account: LansengerAccount | undefined;

  if (resolvedAccountId && accounts && accounts[resolvedAccountId]) {
    account = accounts[resolvedAccountId];
  } else if (section && section.appId) {
    account = section;
    resolvedAccountId = section.appId;
  } else {
    account = section ?? {};
    resolvedAccountId = null;
  }
  
  const appId = account?.appId ?? process.env.LANSENGER_APP_ID ?? "";
  const appSecret = account?.appSecret ?? process.env.LANSENGER_APP_SECRET ?? "";
  const apiGatewayUrl = account?.apiGatewayUrl ?? process.env.LANSENGER_API_GATEWAY_URL ?? DEFAULT_API_GATEWAY_URL;
  const allowFrom: string[] = account?.allowFrom ?? [];
  const dmPolicy = account?.dmSecurity;
  const homeChannel = account?.homeChannel;
  const enabled = Boolean(appId && appSecret);
  const agentId = account?.agentId;

  return {
    accountId: resolvedAccountId || appId || null,
    appId,
    appSecret,
    apiGatewayUrl,
    allowFrom,
    dmPolicy,
    homeChannel,
    enabled,
    agentId,
  };
}

function makeClient(account: ResolvedAccount, logger?: ClientLogger): LansengerClient {
  return new LansengerClient({
    appId: account.appId,
    appSecret: account.appSecret,
    apiGatewayUrl: account.apiGatewayUrl,
    logger,
  });
}

function resolveLansengerApprovers({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }): string[] {
  const commands = (cfg as any).commands ?? {};
  const explicitApprovers: string[] = commands.ownerAllowFrom ?? [];
  if (explicitApprovers.length > 0) return explicitApprovers.map(String);
  const account = resolveAccount(cfg, accountId);
  return account.allowFrom;
}

const approverAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Lansenger",
  resolveApprovers: resolveLansengerApprovers,
});

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
        // Find account by appId
        let account: any = undefined;
        if (section?.appId === accountId) {
          account = section;
        } else if (accounts && accountId && accounts[accountId]) {
          account = accounts[accountId];
        } else if (accounts) {
          // Search by appId value
          for (const [, acc] of Object.entries(accounts)) {
            if (acc?.appId === accountId) {
              account = acc;
              break;
            }
          }
        }
        return {
          enabled: Boolean((account?.enabled ?? false) || (account?.appId && account?.appSecret)),
          configured: Boolean(account?.appId && account?.appSecret),
          appIdStatus: account?.appId ? "available" : "missing",
          appSecretStatus: account?.appSecret ? "available" : "missing",
          agentId: account?.agentId,
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
      resolvePolicy: (account) => account.dmPolicy ?? "paired",
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "paired",
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
        const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
        const client = makeClient(account);
        const result = await client.sendFormatText(ctx.to, ctx.text);
        return { messageId: result.messageId ?? "" };
      },
      sendMedia: async (ctx) => {
        const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
        const client = makeClient(account);
        const caption = ctx.text ?? "";

        if (ctx.mediaUrl && /^https?:\/\//i.test(ctx.mediaUrl)) {
          const result = await client.sendImageUrl(ctx.to, ctx.mediaUrl, caption);
          return { messageId: result.messageId ?? "" };
        }

        if (ctx.mediaUrl) {
          const readFile = ctx.mediaReadFile ?? ctx.mediaAccess?.readFile;
          if (readFile) {
            const buffer = await readFile(ctx.mediaUrl);
            const srcExt = path.extname(ctx.mediaUrl).toLowerCase();
            const ext = srcExt || (ctx.audioAsVoice ? ".amr" : ".dat");
            const tmpPath = path.join(os.tmpdir(), `lansenger_media_${crypto.randomUUID()}${ext}`);
            await fs.writeFile(tmpPath, buffer);
            const mt = ctx.audioAsVoice ? 4 : undefined;
            try {
              const result = await client.sendFile(ctx.to, tmpPath, caption, mt);
              return { messageId: result.messageId ?? "" };
            } finally {
              try { await fs.unlink(tmpPath); } catch {}
            }
          }
          const result = await client.sendFile(ctx.to, ctx.mediaUrl, caption);
          return { messageId: result.messageId ?? "" };
        }

        return { messageId: "" };
      },
    },
    base: {
      deliveryMode: "direct" as const,
      sendFormattedText: async (ctx) => {
        const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
        const client = makeClient(account);
        const result = await client.sendFormatText(ctx.to, ctx.text);
        return [{ channel: "lansenger", messageId: result.messageId ?? "" }];
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
    channels.lansenger = { ...current, dmSecurity: policy };
    return { ...cfg, channels };
  },
  promptAllowFrom: async (params: any) => {
    const { cfg, prompter, accountId } = params;
    const section = (cfg.channels as Record<string, any>)?.["lansenger"] ?? {};
    const accounts = section?.accounts as Record<string, any> | undefined;
    const account = accountId ? accounts?.[accountId] : section;
    const currentAllowFrom: string[] = account?.allowFrom ?? [];
    const input = await prompter.text({
      message: "Lansenger User ID (蓝信用户 ID，格式：2285568-xxx)",
      placeholder: "2285568-xxxxxxx",
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
    channels.lansenger = { ...current, enabled: true, accounts: accountsCopy, dmSecurity: current.dmSecurity ?? "paired" };
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
        placeholder: "e.g. 2285568-10117376",
        validate: (v: string) => String(v ?? "").trim() ? undefined : "Required / 必填",
      })).trim();
      appSecret = String(await prompter.text({
        message: "Lansenger App Secret / 蓝信 App Secret",
        placeholder: "e.g. 57E718CA1CAC20F2...",
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
        dmSecurity: current.dmSecurity ?? "paired",
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

export const lansengerPlugin: ChannelPlugin<ResolvedAccount> = {
  ...chatPlugin as any,
  onboarding: lansengerOnboarding as any,
  approvalCapability: createChannelApprovalCapability({
    authorizeActorAction: approverAuth.authorizeActorAction,
    getActionAvailabilityState: ({ cfg, accountId }: any) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled) return { kind: "unsupported" };
      return { kind: "enabled" };
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId }: any) => ({
        enabled: true,
        preferredSurface: "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
      }),
      resolveOriginTarget: ({ cfg, accountId, request }: any) => {
        const to = request?.turnSource?.target?.to ?? request?.sessionTarget?.to;
        if (to) return { to, threadId: null, accountId: accountId ?? null };
        return null;
      },
    },
    nativeRuntime: {
      eventKinds: ["exec", "plugin"],
      availability: {
        isConfiguredAndAvailable: ({ cfg, accountId }: any) => {
          const account = resolveAccount(cfg, accountId);
          return account.enabled;
        },
      } as any,
      presentation: {
        buildPendingPayload: ({ cfg, request, target, nowMs }: any) => {
          const commandPreview = (request?.command ?? request?.summary ?? "").slice(0, 300);
          const sessionKey = request?.sessionKey ?? "unknown";
          const zhCard: AppCardData = {
            headTitle: "⚠️ 命令审批",
            isDynamic: true,
            headStatusInfo: {
              description: '<div style="color:#FFB116;text-align:left">待审批</div>',
              colour: "#FFB116",
            },
            bodyTitle: "危险命令审批请求",
            bodyContent: `<div style="color:#000;font-size:13pt;text-align:left;text-indent:0em">会话 ID: ${sessionKey.slice(0, 32)}\n命令:\n${commandPreview}</div>`,
            signature: "OpenClaw 安全审批",
            fields: [
              { key: "执行一次", value: "/approve" },
              { key: "本会话有效", value: "/approve session" },
              { key: "拒绝执行", value: "/deny" },
            ],
            cardLink: "",
            pcCardLink: "",
          };
          const enCard: AppCardData = {
            headTitle: "⚠️ Command Approval",
            isDynamic: true,
            headStatusInfo: {
              description: '<div style="color:#FFB116;text-align:left">Pending</div>',
              colour: "#FFB116",
            },
            bodyTitle: "Dangerous Command Approval Request",
            bodyContent: `<div style="color:#000;font-size:13pt;text-align:left;text-indent:0em">Session: ${sessionKey.slice(0, 32)}\nCommand:\n${commandPreview}</div>`,
            signature: "OpenClaw Security",
            fields: [
              { key: "Approve Once", value: "/approve" },
              { key: "This Session", value: "/approve session" },
              { key: "Deny", value: "/deny" },
            ],
            cardLink: "",
            pcCardLink: "",
          };
          return { type: "appCard", zh: zhCard, en: enCard };
        },
        buildResolvedPayload: ({ cfg, resolved, target }: any) => {
          if (resolved?.kind === "approved") {
            return { type: "text", text: `✅ 命令已批准 — ${resolved?.actorLabel ?? "approver"}` };
          }
          return { type: "text", text: "❌ 命令已拒绝" };
        },
      } as any,
      transport: {
        prepareTarget: ({ cfg, accountId, request }: any) => {
          const to = request?.turnSource?.target?.to ?? request?.sessionTarget?.to;
          if (!to) return null;
          return { to, threadId: null, accountId: accountId ?? null };
        },
        send: async ({ cfg, accountId, target, payload }: any) => {
          const account = resolveAccount(cfg, accountId);
          const client = makeClient(account);
          if (payload?.type === "appCard") {
            const lang = client.getUserLang(target.to);
            const appCard = (lang === "zh" ? payload.zh : payload.en) ?? payload.en;
            const result = await client.sendAppCard(target.to, appCard as AppCardData);
            return { delivered: result.success, messageId: result.messageId ?? null };
          }
          if (payload?.type === "text" && payload?.text) {
            const result = await client.sendFormatText(target.to, payload.text);
            return { delivered: result.success, messageId: result.messageId ?? null };
          }
          return { delivered: false, messageId: null };
        },
        update: async ({ cfg, accountId, target, messageId, payload }: any) => {
          const account = resolveAccount(cfg, accountId);
          const client = makeClient(account);
          const status = payload?.status ?? "pending";
          const lang = client.getUserLang(target.to);
          const result = await client.updateCardStatus(messageId ?? "", status as "pending" | "approved" | "denied", lang);
          return { updated: result.success };
        },
        delete: async ({ cfg, accountId, target, messageId }: any) => {
          if (!messageId) return { deleted: false };
          const account = resolveAccount(cfg, accountId);
          const client = makeClient(account);
          const result = await client.revokeMessage([messageId], "bot");
          return { deleted: result.success };
        },
      } as any,
    } as any,
  }),

  actions: {
    describeMessageTool: ({ cfg, accountId, senderIsOwner }: any) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled) return null;
      return {
        actions: ["send", "delete", "sendAttachment"],
        capabilities: ["presentation"],
        schema: {
          properties: {
            action: { const: "sendAttachment", description: "Send a local file as an attachment. The file must be in the workspace directory (~/.openclaw/workspace/). If the file is elsewhere, copy it to workspace first using bash, then sendAttachment the workspace copy. Do NOT use MEDIA: tags for files outside workspace — they are silently dropped by OpenClaw." },
            filePath: { type: "string", description: "Absolute path to the file inside ~/.openclaw/workspace/." },
            caption: { type: "string", description: "Optional plain-text caption (Markdown will NOT render)." },
            to: { type: "string", description: "Lansenger user ID or chat ID to send the file to." },
          },
          actions: ["sendAttachment"],
          visibility: "current-channel",
        },
        mediaSourceParams: { sendAttachment: ["filePath"] },
      };
    },
    handleAction: async (ctx: any) => {
      const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
      const client = makeClient(account);

      if (ctx.action === "sendAttachment") {
        const filePath = ctx.args?.filePath ?? "";
        const caption = ctx.args?.caption ?? ctx.args?.text ?? "";
        const to = ctx.args?.to ?? "";
        if (!filePath || !to) return { success: false, error: "filePath and to are required" };
        const roots = ctx.mediaLocalRoots ?? [path.join(os.homedir(), ".openclaw", "workspace")];
        const resolved = path.resolve(filePath);
        const inRoot = roots.some((r: string) => resolved.startsWith(path.resolve(r) + path.sep) || resolved === path.resolve(r));
        if (!inRoot) {
          return {
            success: false,
            error: `File "${filePath}" is outside the workspace directory. Files must be inside one of: ${roots.join(", ")}. Copy the file to the workspace first (e.g. cp "${filePath}" ~/.openclaw/workspace/), then use sendAttachment with the workspace path.`,
          };
        }
        const result = await client.sendFile(to, filePath, caption);
        return { success: result.success, data: { messageId: result.messageId } };
      }

      if (ctx.action === "send") {
        const result = await client.sendFormatText(ctx.args?.to ?? "", ctx.args?.text ?? "");
        return { success: result.success, data: { messageId: result.messageId } };
      }

      if (ctx.action === "delete") {
        const messageId = ctx.args?.messageId ?? "";
        const result = await client.revokeMessage([messageId], "bot");
        return { success: result.success };
      }

      return { success: false, error: `Unknown action: ${ctx.action}` };
    },
  },
};

export { resolveAccount, makeClient };
export type { ResolvedAccount };