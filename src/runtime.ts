import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { LansengerClient } from "./client.js";
import type { InboundEvent, ClientLogger, ApiResult, AppCardData } from "./client.js";
import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import { errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

const log = createSubsystemLogger("lansenger");

function sdkLogger(): ClientLogger {
  return {
    info: (msg: string) => log.info(msg),
    error: (msg: string) => log.error(msg),
  };
}

type RunningAccount = {
  accountId: string | null;
  account: ResolvedAccount;
  client: LansengerClient;
};

const runningAccounts = new Map<string, RunningAccount>();
const lastInboundChatIds = new Map<string, string>();
const lastInboundTimes = new Map<string, number>();
const deliveredTextHashes = new Map<string, Set<string>>();

async function startAccount(api: OpenClawPluginApi, accountId?: string | null): Promise<boolean> {
  const account = resolveAccount(api.config, accountId);
  if (!account.enabled) {
    log.info(`skip auto-start: account not enabled (accountId=${accountId ?? "default"})`);
    return false;
  }

  const key = account.appId || account.accountId || "__default__";
  if (runningAccounts.has(key)) {
    const entry = runningAccounts.get(key)!;
    if (entry.client.isWsAlive()) {
      log.info(`skip auto-start: WS alive (key=${key})`);
      return true;
    }
    log.info(`auto-reconnect: WS dead, cleaning and reconnecting (key=${key})`);
    try { await entry.client.disconnect(); } catch {}
    runningAccounts.delete(key);
  }

  const client = makeClient(account, sdkLogger());
  client.setMessageHandler(async (event: InboundEvent) => {
    await handleInbound(api, event, account, key);
  });

  const connected = await client.connect();
  if (!connected) {
    log.error(`auto-start failed: could not connect (key=${key})`);
    return false;
  }

  runningAccounts.set(key, { accountId: account.accountId, account, client });
  log.info(`auto-started: key=${key} (accountId=${account.accountId})`);
  return true;
}

export function getLastInboundChatId(): string {
  for (const [, chatId] of lastInboundChatIds) return chatId;
  return "";
}

export function getLastInboundTime(): number | null {
  for (const [, ts] of lastInboundTimes) return ts;
  return null;
}

export function getRunningClient(): LansengerClient | null {
  for (const [, entry] of runningAccounts) return entry.client;
  return null;
}

export function getRunningAccount(): ResolvedAccount | null {
  for (const [, entry] of runningAccounts) return entry.account;
  return null;
}

export function startLansengerGateway(api: OpenClawPluginApi): void {
  (globalThis as any).__lansenger_channel = {
    getRunningClient,
    getRunningAccount,
    getLastInboundChatId,
  };

  const toolsConfig = api.config.tools as Record<string, any> | undefined;
  const alsoAllow = (toolsConfig?.alsoAllow ?? []) as string[];
  if (!alsoAllow.some((e: string) => e === "group:plugins" || e === "__openclaw_default_plugin_tools__")) {
    log.warn(
      `Agent tools (lansenger_send_file, etc.) are registered by this channel plugin but may be INVISIBLE under the current tool profile.` +
      ` Add to openclaw.json: "tools": { "alsoAllow": ["group:plugins"] }` +
      ` — see https://openclaw.ai/docs/tool-policy for details.`
    );
  }

  const section = (api.config.channels as Record<string, any>)?.["lansenger"];
  const accounts = section?.accounts as Record<string, any> | undefined;

  api.registerGatewayMethod("lansenger.start", async (opts) => {
    log.info("lansenger.start called");
    const accountId = opts.params?.accountId as string | undefined;
    const ok = await startAccount(api, accountId);
    if (!ok) {
      const account = resolveAccount(api.config, accountId);
      if (!account.enabled) {
        opts.respond(false, undefined, errorShape("NOT_LINKED", "Lansenger not configured — missing appId/appSecret"));
      } else {
        opts.respond(false, undefined, errorShape("UNAVAILABLE", "Failed to connect to Lansenger WebSocket"));
      }
      return;
    }
    opts.respond(true, { message: "Lansenger gateway started" });
  });

  api.registerGatewayMethod("lansenger.stop", async (opts) => {
    log.info("lansenger.stop called");
    const accountId = opts.params?.accountId as string | undefined;
    const account = resolveAccount(api.config, accountId);
    const key = account.appId || account.accountId || "__default__";
    const entry = runningAccounts.get(key);
    if (!entry) {
      opts.respond(false, undefined, errorShape("NOT_LINKED", "Lansenger not running"));
      return;
    }
    await entry.client.disconnect();
    runningAccounts.delete(key);
    opts.respond(true, { message: "Lansenger gateway stopped" });
  });

  api.registerGatewayMethod("lansenger.status", async (opts) => {
    const entries = Array.from(runningAccounts.entries()).map(([key, entry]) => ({
      appId: key,
      accountId: entry.account?.accountId,
      running: true,
    }));
    opts.respond(true, { running: entries.length > 0, accounts: entries });
  });

  api.registerHttpRoute({
    path: "/lansenger/webhook",
    auth: "plugin",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET") {
        res.statusCode = 200;
        res.end("lansenger webhook endpoint");
        return true;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf-8");

      const account = resolveAccount(api.config);
      const key = account.accountId ?? "__default__";
      const entry = runningAccounts.get(key);
      const client = entry?.client ?? makeClient(account, sdkLogger());
      const events = await client.processRawMessage(body);

      for (const event of events) {
        await handleInbound(api, event, account, key);
      }

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });

  api.registerGatewayMethod("lansenger.sendCard", async (opts) => {
    const { chatId, lang, command, sessionId, signature } = opts.params as { chatId?: string; lang?: string; command?: string; sessionId?: string; signature?: string };
    if (!chatId) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", "chatId required (Lansenger user ID)"));
      return;
    }
    const account = resolveAccount(api.config);
    const key = account.appId || "__default__";
    const entry = runningAccounts.get(key);
    if (!entry) {
      opts.respond(false, undefined, errorShape("NOT_LINKED", "Lansenger gateway not running"));
      return;
    }
    const client = entry.client;
    const detectedLang = (lang === "en" ? "en" : "zh") as "zh" | "en";
    const cmdText = command ?? "unspecified command";
    const sessText = sessionId ?? "unknown";
    const sigText = signature ?? (detectedLang === "zh" ? "OpenClaw 安全审批" : "OpenClaw Security");

    const zhCard: AppCardData = {
      headTitle: "⚠️ 危险命令审批",
      isDynamic: true,
      headStatusInfo: {
        description: '<div style="color:#FFB116;text-align:left">待审批</div>',
        colour: "#FFB116",
      },
      bodyTitle: "危险命令审批请求",
      bodyContent: `<div style="color:#000;font-size:13pt;text-align:left;text-indent:0em">会话 ID: ${sessText}\n命令:\n${cmdText}</div>`,
      signature: sigText,
      fields: [
        { key: "执行一次", value: "/approve" },
        { key: "本会话有效", value: "/approve session" },
        { key: "拒绝执行", value: "/deny" },
      ],
      cardLink: "",
      pcCardLink: "",
    };

    const enCard: AppCardData = {
      headTitle: "⚠️ Dangerous Command Approval",
      isDynamic: true,
      headStatusInfo: {
        description: '<div style="color:#FFB116;text-align:left">Pending</div>',
        colour: "#FFB116",
      },
      bodyTitle: "Dangerous Command Approval Request",
      bodyContent: `<div style="color:#000;font-size:13pt;text-align:left;text-indent:0em">Session: ${sessText}\nCommand:\n${cmdText}</div>`,
      signature: sigText,
      fields: [
        { key: "Approve Once", value: "/approve" },
        { key: "This Session", value: "/approve session" },
        { key: "Deny", value: "/deny" },
      ],
      cardLink: "",
      pcCardLink: "",
    };

    const card = detectedLang === "zh" ? zhCard : enCard;
    const result = await client.sendAppCard(chatId, card);
    if (!result.success) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", result.error ?? "Failed to send card"));
      return;
    }
    opts.respond(true, { messageId: result.messageId, lang: detectedLang });
  });

  api.registerGatewayMethod("lansenger.updateCard", async (opts) => {
    const { messageId, status, lang } = opts.params as { messageId?: string; status?: string; lang?: string };
    if (!messageId || !status) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", "messageId and status required"));
      return;
    }
    const account = resolveAccount(api.config);
    const key = account.appId || "__default__";
    const entry = runningAccounts.get(key);
    if (!entry) {
      opts.respond(false, undefined, errorShape("NOT_LINKED", "Lansenger gateway not running"));
      return;
    }
    const client = entry.client;
    const detectedLang = (lang === "en" ? "en" : "zh") as "zh" | "en";
    const validStatuses = ["pending", "approved", "denied"];
    if (!validStatuses.includes(status ?? "")) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", `Invalid status: ${status}. Must be one of: pending, approved, denied`));
      return;
    }
    const result = await client.updateCardStatus(messageId, status as "pending" | "approved" | "denied", detectedLang);
    if (!result.success) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", result.error ?? "Failed to update card"));
      return;
    }
    opts.respond(true, { messageId, status, lang: detectedLang, rawResponse: result.rawResponse });
  });

  autoStart(api, accounts);
}

function autoStart(api: OpenClawPluginApi, accounts?: Record<string, any>): void {
  const section = (api.config.channels as Record<string, any>)?.["lansenger"];

  const accountIds = new Set<string>();
  if (accounts && Object.keys(accounts).length > 0) {
    for (const [accountId] of Object.entries(accounts)) {
      accountIds.add(accountId);
      startAccount(api, accountId).catch((e) => log.error(`auto-start error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  if (section?.appId && section?.appSecret && !accountIds.has(section.appId)) {
    startAccount(api).catch((e) => log.error(`auto-start error: ${e instanceof Error ? e.message : String(e)}`));
  }

  if (accountIds.size === 0 && !(section?.appId && section?.appSecret)) {
    log.info("auto-start: no configured accounts, skipping");
  }
}

async function handleInbound(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  runningKey: string,
): Promise<void> {
  const chatType = event.isGroup ? "group" : "dm";

  if (chatType === "dm") {
    const dmPolicy = account.dmPolicy ?? "pairing";
    const configAllowFrom = account.allowFrom ?? [];
    const pairing = (api.runtime as any).channel.pairing;
    const storeAllowFrom: string[] = pairing?.readAllowFromStore ? await pairing.readAllowFromStore({ channel: "lansenger", accountId: account.accountId ?? undefined }) : [];
    const effectiveAllowFrom = [...new Set([...configAllowFrom, ...storeAllowFrom])];
    const senderAllowed = effectiveAllowFrom.some((id: string) => {
      const bare = id.replace(/^lansenger:/, "");
      return bare === event.senderId || id === event.senderId;
    });

    if (!senderAllowed) {
      if (dmPolicy === "pairing") {
        log.info(`inbound: dm pairing required — sender=${event.senderId} not in allowFrom`);
        const { code } = await pairing.upsertPairingRequest({
          channel: "lansenger",
          id: event.senderId,
          accountId: account.accountId ?? undefined,
          meta: { name: event.userName },
        });
        const reply = pairing.buildPairingReply({
          channel: "lansenger",
          idLine: `Your Lansenger user ID: ${event.senderId} / 你的蓝信用户 ID：${event.senderId}`,
          code,
        });
        const entry = runningAccounts.get(runningKey);
        const client = entry?.client ?? makeClient(account, sdkLogger());
        await client.sendFormatText(event.senderId, reply);
        log.info(`inbound: pairing code sent to sender=${event.senderId}`);
        return;
      }
      if (dmPolicy === "disabled") {
        log.info(`inbound: dm dropped — dmPolicy=disabled sender=${event.senderId}`);
        return;
      }
      if (dmPolicy === "allowlist") {
        log.info(`inbound: dm dropped — sender=${event.senderId} not in allowFrom (dmPolicy=allowlist)`);
        return;
      }
    }
  }

  if (event.isGroup) {
    const groupPolicy = api.runtime.channel.groups.resolveGroupPolicy({
      cfg: api.config,
      channel: "lansenger",
      groupId: event.chatId,
      accountId: account.accountId,
    });
    if (!groupPolicy.allowed) {
      log.info(`inbound: group dropped — groupPolicy not allowed for chatId=${event.chatId}`);
      return;
    }
    const requireMention = api.runtime.channel.groups.resolveRequireMention({
      cfg: api.config,
      channel: "lansenger",
      groupId: event.chatId,
      accountId: account.accountId,
    });
    log.info(`inbound: group allowed — chatId=${event.chatId} requireMention=${requireMention}`);
  }

  const route = api.runtime.channel.routing.resolveAgentRoute({
    cfg: api.config,
    channel: "lansenger",
    accountId: account.accountId,
    peer: { kind: chatType as "direct" | "group" | "channel", id: event.chatId },
  });
  const agentId = route.agentId;
  const sessionKey = route.sessionKey;
  const replyTo = event.chatId;
  lastInboundChatIds.set(runningKey, event.chatId);
  lastInboundTimes.set(runningKey, Date.now());

  log.info(`inbound: ${chatType} from=${event.senderId} bot=${account.appId.slice(0, 20)}... agent=${agentId} matchedBy=${route.matchedBy}`);

  let agentText = event.text;
  if (event.mediaPaths?.length) {
    agentText = `${event.text}\n\nAttached files saved locally — use the read tool to view:\n${event.mediaPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  }

  const rawText = event.text;
  const allowTextCommands = api.runtime.channel.commands.shouldHandleTextCommands({
    cfg: api.config,
    surface: "lansenger",
  });
  const shouldComputeAuth = api.runtime.channel.commands.shouldComputeCommandAuthorized(rawText, api.config);
  const hasCommand = api.runtime.channel.commands.isControlCommandMessage(rawText, api.config);

  let commandAuthorized: boolean | undefined = undefined;

  if (shouldComputeAuth) {
    const commandsCfg = (api.config as any).commands ?? {};
    const useAccessGroups = commandsCfg.useAccessGroups !== false;

    const explicitAllowFrom: string[] | undefined = (() => {
      const af = commandsCfg.allowFrom;
      if (!af || typeof af !== "object") return undefined;
      return af["lansenger"] ?? af["*"] ?? undefined;
    })();

    const ownerAllowFrom: string[] = commandsCfg.ownerAllowFrom ?? [];
    const senderId = event.senderId;

    const senderMatches = (id: string) => {
      const bare = id.replace(/^lansenger:/, "");
      return bare === senderId || id === senderId;
    };

    if (explicitAllowFrom) {
      commandAuthorized = explicitAllowFrom.some(senderMatches);
    } else {
      const channelAllowFrom = account.allowFrom;
      const noAuthorizersConfigured = ownerAllowFrom.length === 0 && channelAllowFrom.length === 0;
      const dmPolicyIsPairing = (account.dmPolicy ?? "pairing") === "pairing";
      if (noAuthorizersConfigured && dmPolicyIsPairing) {
        commandAuthorized = undefined;
      } else {
        commandAuthorized = api.runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            { configured: ownerAllowFrom.length > 0, allowed: ownerAllowFrom.some(senderMatches) },
            { configured: channelAllowFrom.length > 0, allowed: channelAllowFrom.some(senderMatches) },
          ],
        });
      }
    }
  }

  if (allowTextCommands && hasCommand && commandAuthorized !== true) {
    log.info(`inbound: command blocked — sender=${event.senderId} not authorized: ${rawText.slice(0, 60)}`);
    return;
  }

  try {
    log.info(`turn.run starting: sessionKey=${sessionKey} agentId=${agentId} accountId=${account.accountId} matchedBy=${route.matchedBy}`);
    await api.runtime.channel.turn.run({
      channel: "lansenger",
      accountId: account.accountId ?? undefined,
      raw: event,
      adapter: {
        ingest: () => {
          return {
            id: event.messageId,
            rawText: event.text,
            textForAgent: agentText,
            textForCommands: event.text,
            raw: event.rawMessage,
          };
        },
        resolveTurn: () => {
          const storePath = api.runtime.channel.session.resolveStorePath(undefined, { agentId });
          return {
            cfg: api.config,
            channel: "lansenger",
            accountId: account.accountId ?? undefined,
            agentId,
            routeSessionKey: sessionKey,
            storePath,
            ctxPayload: {
              Body: event.text,
              BodyForAgent: agentText,
              CommandBody: rawText,
              CommandAuthorized: commandAuthorized,
              CommandSource: "text",
              From: event.senderId,
              FromName: event.userName,
              SessionKey: sessionKey,
              ChatType: chatType,
              Channel: "lansenger",
              Provider: "lansenger",
              Surface: "lansenger",
              To: replyTo,
            },
            recordInboundSession: api.runtime.channel.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher: api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
            delivery: {
              deliver: async (payload: any, info: any) => {
                const text: string | undefined = payload.text;
                const to: string = payload.to ?? replyTo;
                const mediaUrls: string[] = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
                const entry = runningAccounts.get(runningKey);
                const client = entry?.client ?? makeClient(account, sdkLogger());

                const dedupSet = deliveredTextHashes.get(runningKey) ?? new Set<string>();
                deliveredTextHashes.set(runningKey, dedupSet);

                const messageIds: string[] = [];
                const textKey = text?.trim() ? `${text.trim().slice(0, 80)}:${text.trim().length}` : "";

                if (text?.trim() && !dedupSet.has(textKey)) {
                  dedupSet.add(textKey);
                  const result = await deliverReply(client, to, text);
                  if (result.messageId) messageIds.push(result.messageId);
                }

                for (const mediaUrl of mediaUrls) {
                  log.info(`deliver media: ${mediaUrl}`);
                  const readFile = payload.mediaReadFile ?? payload.mediaAccess?.readFile;
                  if (/^https?:\/\//i.test(mediaUrl)) {
                    const r = await client.sendImageUrl(to, mediaUrl, "");
                    if (r.messageId) messageIds.push(r.messageId);
                  } else if (readFile) {
                    const buffer = await readFile(mediaUrl);
                    const ext = path.extname(mediaUrl).toLowerCase() || ".dat";
                    const tmpPath = path.join(os.tmpdir(), `lansenger_media_${crypto.randomUUID()}${ext}`);
                    await fs.writeFile(tmpPath, buffer);
                    try {
                      const r = await client.sendFile(to, tmpPath, "");
                      if (r.messageId) messageIds.push(r.messageId);
                    } finally {
                      try { await fs.unlink(tmpPath); } catch {}
                    }
                  } else {
                    const resolved = path.resolve(mediaUrl);
                    const r = await client.sendFile(to, resolved, "");
                    if (r.messageId) messageIds.push(r.messageId);
                  }
                }

                const visible = messageIds.length > 0 || (text?.trim() && !mediaUrls.length);
                return { messageIds, visibleReplySent: visible };
              },
              onError: (err: unknown, info: { kind: string }) => {
                log.error(`delivery error: ${err instanceof Error ? err.message : String(err)} kind=${info.kind}`);
              },
            },
            record: { onRecordError: (err: unknown) => log.error(`record error: ${err instanceof Error ? err.message : String(err)}`) },
          };
        },
      },
    } as any);
    log.info(`turn.run completed: sessionKey=${sessionKey}`);
  } catch (e: unknown) {
    log.error(`turn.run failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function deliverReply(client: LansengerClient, to: string, text: string): Promise<ApiResult> {
  log.info(`deliverReply: to=${to} textLen=${text.length} preview="${text.slice(0, 100)}"`);
  if (!text.trim()) {
    log.warn(`deliverReply: empty text after OpenClaw MEDIA processing, skipping delivery`);
    return { success: true, messageId: undefined };
  }
  const fmtResult = await client.sendFormatText(to, text);
  if (fmtResult.success) return fmtResult;
  log.info(`formatText failed (${fmtResult.error ?? "unknown"}), falling back to text`);
  return client.sendText(to, text);
}