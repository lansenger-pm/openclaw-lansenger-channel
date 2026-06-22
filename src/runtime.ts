import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext, ChannelAccountSnapshot } from "openclaw/plugin-sdk";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { createChannelInboundDebouncer, shouldDebounceTextInbound, resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound";
import { LansengerClient } from "./client.js";
import type { InboundEvent, ClientLogger, ApiResult, AppCardData } from "./client.js";
import { resolveAccount, makeClient, isPathAllowed } from "./channel.js";
import { PersistentStore } from "./persistent-store.js";
import type { ResolvedAccount } from "./channel.js";
import { errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { pendingApprovalCards } from "./channel.js";
import { defineStableChannelIngressIdentity, createChannelIngressResolver, resolveChannelMessageIngress, type ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

const log = createSubsystemLogger("lansenger");

const lansengerIngressIdentity = defineStableChannelIngressIdentity({
  key: "senderId",
  normalize: (v: string) => v.replace(/^lansenger:/, ""),
  sensitivity: "normal",
  entryIdPrefix: "lx",
});

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
  debouncer?: { debounceMs: number; enqueue: (item: InboundEvent) => Promise<void>; flushKey: (key: string) => Promise<void> };
};

export function mergeInboundEvents(events: InboundEvent[]): InboundEvent {
  if (events.length === 0) {
    throw new Error("mergeInboundEvents: events array is empty");
  }
  if (events.length === 1) return events[0]!;
  const last = events[events.length - 1]!;
  const texts = events.map((e) => e.text).filter(Boolean);
  const mergedText = texts.join("\n");
  const mergedMediaPaths = events.flatMap((e) => e.mediaPaths ?? []);
  const mergedRawMessage = { mergedFrom: events.map((e) => e.messageId), events: events.map((e) => e.rawMessage), lastRawMessage: last.rawMessage };
  return {
    messageId: last.messageId,
    text: mergedText,
    chatId: last.chatId,
    chatName: last.chatName,
    isGroup: last.isGroup,
    senderId: last.senderId,
    userName: last.userName,
    rawMessage: mergedRawMessage,
    msgType: last.msgType,
    mediaPaths: mergedMediaPaths.length > 0 ? mergedMediaPaths : undefined,
    isAtMe: last.isAtMe,
    isAtAll: last.isAtAll,
    mentionedStaffs: last.mentionedStaffs,
    mentionedBots: last.mentionedBots,
    referenceMsg: last.referenceMsg,
  };
}

const ACK_MESSAGE_ID_KEY = "__lansenger_ack_msg_id";

const runningAccounts = new Map<string, RunningAccount>();
const pendingConnections = new Set<string>(); // prevents concurrent startAccount for same key
const accountStatusSinks = new Map<string, (patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
const lastInboundChatIds = new Map<string, string>();
const lastInboundTimes = new Map<string, number>();
const sessionAccountMap = new Map<string, string>(); // sessionKey -> runningKey
const sessionDeliveryTracker = new Map<string, Set<string>>();
const activeDeliverySessions = new Set<string>();

const INBOUND_CONTEXT_FILE = path.join(os.homedir(), ".openclaw", "lansenger-inbound-contexts.json");

interface InboundDeliveryContext {
  chatId: string;
  sessionKey: string;
  agentId: string;
  accountId: string | null;
  runningKey: string;
  ackMessageId?: string;
  timestamp: number;
}

class PersistentInboundContextStore extends PersistentStore<InboundDeliveryContext> {
  constructor() {
    super(INBOUND_CONTEXT_FILE, "inbound contexts");
  }

  entries() { return this.data.entries(); }

  size() { return this.data.size; }
}

const inboundContextStore = new PersistentInboundContextStore();

let recoveryGuard = false;

let pluginApi: OpenClawPluginApi | null = null;

function extractChatIdFromSessionKey(sessionKey: string): string | undefined {
  if (!sessionKey || !sessionKey.includes("lansenger")) return undefined;
  const parts = sessionKey.split(":");
  const last = parts[parts.length - 1];
  if (last && last !== "main" && last !== "lansenger" && last.length > 1) return last;
  return undefined;
}

export function stripOpenClawUuidSuffix(name: string): string {
  return name.replace(/---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "");
}

async function startAccount(api: OpenClawPluginApi, accountId?: string | null): Promise<boolean> {
  const account = resolveAccount(api.config, accountId);
  if (!account.enabled) {
    log.info(`skip auto-start: account not enabled (accountId=${accountId ?? "default"})`);
    return false;
  }

  const key = account.appId || account.accountId || "__default__";
  if (pendingConnections.has(key)) {
    log.info(`skip auto-start: connection already in progress (key=${key})`);
    return true;
  }
  if (runningAccounts.has(key)) {
    const entry = runningAccounts.get(key)!;
    if (entry.client.isWsAlive()) {
      log.info(`skip auto-start: WS alive (key=${key} wsState=${entry.client.wsState()})`);
      return true;
    }
    log.info(`auto-reconnect: WS dead (wsState=${entry.client.wsState()}), cleaning and reconnecting (key=${key})`);
    try { await entry.client.disconnect(); } catch {}
    runningAccounts.delete(key);
  }

  pendingConnections.add(key);
  try {
    const client = makeClient(account, sdkLogger());

  const debounceApi = (api.runtime as any)?.channel?.debounce;
  const debounceMs = debounceApi ? resolveInboundDebounceMs({ cfg: api.config, channel: "lansenger" }) : 0;
  let debouncer: RunningAccount["debouncer"] = undefined;

  if (debounceApi && debounceMs > 0) {
    const { debounceMs: resolvedMs, debouncer: created } = createChannelInboundDebouncer({
      cfg: api.config,
      channel: "lansenger",
      buildKey: (event: InboundEvent) => `${event.chatId}:${event.senderId}`,
      shouldDebounce: (event: InboundEvent) =>
        shouldDebounceTextInbound({ text: event.text, cfg: api.config, hasMedia: !!event.mediaPaths?.length }),
      onFlush: async (events: InboundEvent[]) => {
        const merged = mergeInboundEvents(events);
        await handleInbound(api, merged, account, key);
      },
    });
    debouncer = { debounceMs: resolvedMs, enqueue: created.enqueue, flushKey: created.flushKey };
    log.info(`debounce enabled: debounceMs=${resolvedMs} key=${key}`);
  }

  client.setMessageHandler(async (event: InboundEvent) => {
    if (debouncer) {
      await debouncer.enqueue(event);
    } else {
      await handleInbound(api, event, account, key);
    }
  });

  const existingSink = accountStatusSinks.get(key);
  if (existingSink) {
    client.setWsLifecycleCallbacks({
      onOpen: () => {
        existingSink({ connected: true, lastConnectedAt: Date.now(), lastError: null });
      },
      onClose: () => {
        existingSink({ connected: false });
      },
    });
  }

  const connected = await client.connect();
  if (!connected) {
    log.error(`auto-start failed: could not connect (key=${key})`);
    return false;
  }

  runningAccounts.set(key, { accountId: account.accountId, account, client, debouncer });
  log.info(`auto-started: key=${key} (accountId=${account.accountId})`);
  return true;
  } finally {
    pendingConnections.delete(key);
  }
}

export function getLastInboundChatId(): string {
  for (const [, chatId] of lastInboundChatIds) return chatId;
  return "";
}

export function getLastInboundTime(): number | null {
  for (const [, ts] of lastInboundTimes) return ts;
  return null;
}

export function getLastInboundTimeByAccount(accountId: string): number | null {
  for (const [key, ts] of lastInboundTimes) {
    if (key === accountId) return ts;
  }
  // check by matching accountId within the entry key
  for (const [key, ts] of lastInboundTimes) {
    const entry = runningAccounts.get(key);
    if (entry && (entry.accountId === accountId || entry.account.accountId === accountId || entry.account.appId === accountId)) return ts;
  }
  // single-account fallback
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

export function getRunningEntryBySessionKey(sessionKey: string): { client: LansengerClient; account: ResolvedAccount } | null {
  const runningKey = sessionAccountMap.get(sessionKey);
  if (runningKey) {
    const entry = runningAccounts.get(runningKey);
    if (entry) return { client: entry.client, account: entry.account };
  }
  return null;
}

export function getRunningEntryByAccount(accountId: string): { client: LansengerClient; account: ResolvedAccount } | null {
  for (const [key, entry] of runningAccounts) {
    if (key === accountId || entry.accountId === accountId || entry.account.accountId === accountId || entry.account.appId === accountId) {
      return { client: entry.client, account: entry.account };
    }
  }
  // single-account fallback: if only one account is running, use it
  const entries = Array.from(runningAccounts.values());
  if (entries.length === 1 && entries[0]) {
    return { client: entries[0].client, account: entries[0].account };
  }
  return null;
}

async function recoverPendingInboundContexts(api: OpenClawPluginApi): Promise<void> {
  if (recoveryGuard) {
    log.info("recovery: already performed in this process lifetime — skipping");
    return;
  }
  recoveryGuard = true;

  const pendingCount = inboundContextStore.size();
  if (pendingCount === 0) return;

  log.info(`recovery: found ${pendingCount} pending inbound context(s) — checking for interrupted sessions`);

  const RECOVERY_NOTICE_ZH = "系统重启，正在重新处理您的请求，请稍候...";
  const RECOVERY_NOTICE_EN = "System restarted. Your request is being reprocessed, please wait...";
  const MAX_CONTEXT_AGE_MS = 5 * 60 * 1000;

  const toDelete: string[] = [];
  const notifiedChats = new Set<string>();

  for (const [sessionKey, ctx] of inboundContextStore.entries()) {
    const age = Date.now() - ctx.timestamp;
    if (age > MAX_CONTEXT_AGE_MS) {
      log.info(`recovery: context expired (age=${age}ms) for session=${sessionKey.slice(0, 32)} — discarding`);
      toDelete.push(sessionKey);
      continue;
    }

    log.info(`recovery: pending context session=${sessionKey.slice(0, 32)} chatId=${ctx.chatId} age=${age}ms ackMessageId=${ctx.ackMessageId ?? "none"}`);

    // Send only one restart notice per chat to avoid duplicate messages
    if (!notifiedChats.has(ctx.chatId)) {
      notifiedChats.add(ctx.chatId);
      try {
        const account = resolveAccount(api.config, ctx.accountId ?? undefined);
        const client = makeClient(account, sdkLogger());
        const lang = client.getUserLang(ctx.chatId);
        const noticeText = lang === "en" ? RECOVERY_NOTICE_EN : RECOVERY_NOTICE_ZH;

        if (ctx.ackMessageId) {
          try {
            await client.revokeMessage([ctx.ackMessageId], "bot");
            log.info(`recovery: revoked stale ack messageId=${ctx.ackMessageId}`);
          } catch (e: unknown) {
            log.warn(`recovery: failed to revoke ack messageId=${ctx.ackMessageId} — ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        await client.sendFormatText(ctx.chatId, noticeText);
        log.info(`recovery: sent restart notice to chatId=${ctx.chatId}`);
      } catch (e: unknown) {
        log.error(`recovery: failed to send notice for session=${sessionKey.slice(0, 32)} — ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      log.info(`recovery: already notified chatId=${ctx.chatId}, skipping duplicate notice for session=${sessionKey.slice(0, 32)}`);
    }

    toDelete.push(sessionKey);
  }

  for (const key of toDelete) {
    inboundContextStore.delete(key);
  }
}

export function startLansengerGateway(api: OpenClawPluginApi): void {
  pluginApi = api;
  (globalThis as any).__lansenger_channel = {
    getRunningClient,
    getRunningAccount,
    getLastInboundChatId,
  };

  if (api.on) {
    api.on("message_sending", (event: any) => {
      const sessionKey = event?.sessionKey ?? "";
      if (sessionKey && sessionKey.includes("lansenger")) {
        log.info(`message_sending hook: sessionKey=${sessionKey.slice(0, 32)} type=${event?.type} action=${event?.action}`);
      }
    });
    api.on("reply_payload_sending", (event: any, ctx: any) => {
      if (ctx?.channelId === "lansenger" || event?.channel === "lansenger") {
        const payload = event?.payload;
        const sessionKey = ctx?.sessionKey ?? "";
        const kind = event?.kind ?? "unknown";
        log.info(`reply_payload_sending hook: channel=lansenger sessionKey=${sessionKey.slice(0, 32)} kind=${kind} hasText=${Boolean(payload?.text)} hasMedia=${Boolean(payload?.mediaUrl)} hasPresentation=${Boolean(payload?.presentation)}`);

        if (payload?.channelData?.execApproval) {
          const chatId = payload?.channelData?.__lansenger_target ?? "";
          log.info(`reply_payload_sending: approval payload detected — execApproval=${payload.channelData.execApproval}`);
        }

        if (sessionKey && !activeDeliverySessions.has(sessionKey) && payload?.text?.trim()) {
          const runningEntry = getRunningEntryByAccount("");
          const client = runningEntry?.client ?? getRunningClient();
          if (client) {
            const to = payload.to ?? payload.chatId ?? extractChatIdFromSessionKey(sessionKey) ?? "";
            if (to) {
              log.info(`reply_payload_sending: fallback delivery for session=${sessionKey.slice(0, 32)} (no active inbound.run) — sending directly to=${to}`);
              try {
                deliverReply(client, to, payload.text);
              } catch (e: unknown) {
                log.error(`reply_payload_sending fallback delivery failed — ${e instanceof Error ? e.message : String(e)}`);
              }
            } else {
              log.warn(`reply_payload_sending: fallback delivery skipped — cannot resolve target for session=${sessionKey.slice(0, 32)}`);
            }
          } else {
            log.warn(`reply_payload_sending: fallback delivery skipped — no running client available`);
          }
        }

        return void 0;
      }
    });
  }

  recoverPendingInboundContexts(api);

  const rt = api.runtime as any;
  const rtKeys = rt ? Object.keys(rt) : [];
  const channelKeys = rt?.channel ? Object.keys(rt.channel) : [];
  log.info(`plugin startup: runtime available=${!!rt} runtimeKeys=${rtKeys.join(",")} channelKeys=${channelKeys.join(",")}`);
  if (!rt?.channel?.inbound) {
    log.error(`plugin startup: api.runtime.channel.inbound is UNDEFINED — inbound messages will fail! OpenClaw version may be too old (need 2026.5.27+)`);
  }
  if (!rt?.channel?.pairing) {
    log.warn(`plugin startup: api.runtime.channel.pairing is UNDEFINED — DM pairing will be disabled`);
  }

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

export async function gatewayStartAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<unknown> {
  const statusSink = createAccountStatusSink({ accountId: ctx.accountId, setStatus: ctx.setStatus });
  const account = ctx.account;
  const key = account.appId || ctx.accountId || "__default__";

  accountStatusSinks.set(key, statusSink);

  if (pendingConnections.has(key)) {
    log.info(`gateway: skipping start — connection already in progress (key=${key})`);
    return { connected: true };
  }

  if (runningAccounts.has(key)) {
    const entry = runningAccounts.get(key)!;
    log.info(`gateway: disconnecting existing WS for reconnection with updated config (key=${key})`);
    try { await entry.client.disconnect(); } catch {}
    runningAccounts.delete(key);
  }

  pendingConnections.add(key);
  try {
    const api = pluginApi!;
    const client = makeClient(account, sdkLogger());

    const debounceApi = (api.runtime as any)?.channel?.debounce;
    const debounceMs = debounceApi ? resolveInboundDebounceMs({ cfg: api.config, channel: "lansenger" }) : 0;
    let debouncer: RunningAccount["debouncer"] = undefined;

    if (debounceApi && debounceMs > 0) {
      const { debounceMs: resolvedMs, debouncer: created } = createChannelInboundDebouncer({
        cfg: api.config,
        channel: "lansenger",
        buildKey: (event: InboundEvent) => `${event.chatId}:${event.senderId}`,
        shouldDebounce: (event: InboundEvent) =>
          shouldDebounceTextInbound({ text: event.text, cfg: api.config, hasMedia: !!event.mediaPaths?.length }),
        onFlush: async (events: InboundEvent[]) => {
          const merged = mergeInboundEvents(events);
          await handleInbound(api, merged, account, key);
        },
      });
      debouncer = { debounceMs: resolvedMs, enqueue: created.enqueue, flushKey: created.flushKey };
      log.info(`gateway debounce enabled: debounceMs=${resolvedMs} key=${key}`);
    }

    client.setMessageHandler(async (event: InboundEvent) => {
      if (debouncer) {
        await debouncer.enqueue(event);
      } else {
        await handleInbound(api, event, account, key);
      }
    });
    client.setWsLifecycleCallbacks({
      onOpen: () => {
        statusSink({ connected: true, lastConnectedAt: Date.now(), lastError: null });
        log.info(`gateway: WS connected (key=${key})`);
      },
      onClose: () => {
        statusSink({ connected: false });
        log.info(`gateway: WS disconnected (key=${key})`);
      },
    });

    const connected = await client.connect();
    if (!connected) {
      statusSink({ connected: false, lastError: "Failed to connect to Lansenger WebSocket" });
      throw new Error("Failed to connect to Lansenger WebSocket");
    }

    runningAccounts.set(key, { accountId: ctx.accountId, account, client, debouncer });
    statusSink({ connected: true, lastConnectedAt: Date.now(), lastError: null });
    log.info(`gateway: started (key=${key} accountId=${ctx.accountId})`);
  } finally {
    pendingConnections.delete(key);
  }

  return waitUntilAbort(ctx.abortSignal, async () => {
    const e = runningAccounts.get(key);
    if (e) {
      await e.client.disconnect();
      runningAccounts.delete(key);
    }
    accountStatusSinks.delete(key);
    log.info(`gateway: stopped on abort (key=${key})`);
  });
}

export async function gatewayStopAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<void> {
  const key = ctx.account.appId || ctx.accountId || "__default__";
  const entry = runningAccounts.get(key);
  if (entry) {
    await entry.client.disconnect();
    runningAccounts.delete(key);
  }
  accountStatusSinks.delete(key);
  log.info(`gateway: stopAccount (key=${key})`);
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
  const turnTextDelivered = new Set<string>();
  const turnMediaDelivered = new Set<string>();

  if (chatType === "dm") {
    const dmPolicy = (account.dmPolicy ?? "pairing") as "pairing" | "allowlist" | "open" | "disabled";
    const configAllowFrom = account.allowFrom ?? [];
    const pairing = (api.runtime as any)?.channel?.pairing;

    let ingress: any;
    try {
      ingress = await resolveChannelMessageIngress({
        channelId: "lansenger",
        accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        identity: lansengerIngressIdentity,
        subject: { stableId: event.senderId },
        conversation: { kind: "direct", id: event.chatId },
        event: { kind: "message", authMode: "inbound", mayPair: true, originSubject: { identifiers: [{ opaqueId: event.senderId, kind: "platform-id" as any, sensitivity: "normal", value: event.senderId }] } },
        policy: { dmPolicy, groupPolicy: "allowlist" },
        allowFrom: configAllowFrom,
        useDefaultPairingStore: true,
      });
    } catch (e: unknown) {
      log.error(`inbound: ingress resolution failed — ${e instanceof Error ? e.message : String(e)}, falling back to manual DM check`);
    }

let senderAllowed = ingress?.senderAccess?.allowed ?? false;
    if (!senderAllowed && !ingress) {
      let storeAllowFrom: string[] = [];
      try {
        if (pairing?.readAllowFromStore) {
          storeAllowFrom = await pairing.readAllowFromStore({ channel: "lansenger", accountId: account.accountId ?? undefined });
        }
      } catch (e: unknown) {
        log.error(`inbound: readAllowFromStore failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      const effectiveAllowFrom = [...new Set([...configAllowFrom, ...storeAllowFrom])];
      senderAllowed = effectiveAllowFrom.some((id: string) => {
        const bare = id.replace(/^lansenger:/, "");
        return bare === event.senderId || id === event.senderId;
      });
    }

    if (!senderAllowed) {
      if (dmPolicy === "pairing" && pairing?.upsertPairingRequest) {
        log.info(`inbound: dm pairing required — sender=${event.senderId} not in allowFrom`);
        try {
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
        } catch (e: unknown) {
          log.error(`inbound: pairing flow failed — ${e instanceof Error ? e.message : String(e)}, dropping message`);
        }
        return;
      }
      log.info(`inbound: dm dropped — sender=${event.senderId} not allowed (dmPolicy=${dmPolicy})`);
      return;
    }
  }

  if (event.isGroup) {
    let ingress: any;
    let requireMention = account.requireMention ?? true;
    try {
      ingress = await resolveChannelMessageIngress({
        channelId: "lansenger",
        accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        identity: lansengerIngressIdentity,
        subject: { stableId: event.senderId },
        conversation: { kind: "group", id: event.chatId },
        event: { kind: "message", authMode: "inbound", mayPair: false, originSubject: { identifiers: [{ opaqueId: event.senderId, kind: "platform-id" as any, sensitivity: "normal", value: event.senderId }] } },
        policy: { dmPolicy: "pairing", groupPolicy: (account.groupPolicy as "open" | "allowlist" | "disabled") ?? "open", activation: { requireMention, allowTextCommands: false } },
        groupAllowFrom: [],
        mentionFacts: { canDetectMention: true, wasMentioned: event.isAtMe ?? false, hasAnyMention: event.isAtAll ?? false },
      });
      if (!ingress?.senderAccess?.allowed) {
        log.info(`inbound: group dropped — sender not allowed for chatId=${event.chatId}`);
        return;
      }
      if (ingress?.activationAccess?.shouldSkip) {
        log.info(`inbound: group dropped — requireMention=${requireMention} but bot not @mentioned`);
        return;
      }
      log.info(`inbound: group allowed — chatId=${event.chatId} requireMention=${requireMention} senderAllowed=${ingress?.senderAccess?.allowed}`);
    } catch (e: unknown) {
      log.error(`inbound: group ingress resolution failed — ${e instanceof Error ? e.message : String(e)}, falling back to manual check`);
      try {
        let fallbackRequireMention = requireMention;
        try {
          fallbackRequireMention = api.runtime.channel.groups.resolveRequireMention({
            cfg: api.config,
            channel: "lansenger",
            groupId: event.chatId,
            accountId: account.accountId,
          });
        } catch {}
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
        if (fallbackRequireMention && !(event.isAtMe ?? false)) {
          log.info(`inbound: group dropped — fallback requireMention=${fallbackRequireMention} but bot not @mentioned for chatId=${event.chatId}`);
          return;
        }
      } catch (e2: unknown) {
        log.error(`inbound: group policy check also failed — ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
  }

  let agentId: string;
  let sessionKey: string;
  try {
    const route = api.runtime.channel.routing.resolveAgentRoute({
      cfg: api.config,
      channel: "lansenger",
      accountId: account.accountId,
      peer: { kind: chatType as "direct" | "group" | "channel", id: event.chatId },
    });
    agentId = route.agentId;
    sessionKey = route.sessionKey;
  } catch (e: unknown) {
    log.error(`inbound: route resolution failed — ${e instanceof Error ? e.message : String(e)}, using defaults`);
    agentId = "main";
    const accountIdPart = account.accountId ? `:${account.accountId.slice(0, 20)}` : "";
    sessionKey = `agent:main:lansenger${accountIdPart}:${chatType}:${event.chatId}`;
  }
  const replyTo = event.chatId;
  lastInboundChatIds.set(runningKey, event.chatId);
  lastInboundTimes.set(runningKey, Date.now());
  if (sessionKey) sessionAccountMap.set(sessionKey, runningKey);

  const sessionDeliveredSet = sessionDeliveryTracker.get(sessionKey) ?? new Set<string>();
  sessionDeliveryTracker.set(sessionKey, sessionDeliveredSet);
  activeDeliverySessions.add(sessionKey);

  log.info(`inbound: ${chatType} from=${event.senderId} bot=${account.appId.slice(0, 20)}... agent=${agentId} session=${sessionKey.slice(0, 32)}`);

  // Strip trailing @mention from group chat messages (e.g. "/models@bot" -> "/models").
  // Lansenger group chat text includes @botName when the bot is @mentioned,
  // which breaks slash command detection because isControlCommandMessage
  // requires text to start with a registered command alias.
  if (event.isGroup && event.isAtMe) {
    const ourBotId = event.rawMessage?.botId as string | undefined;
    const ourMention = ourBotId ? event.mentionedBots?.find(b => b.botId === ourBotId) : undefined;
    if (ourMention) {
      const atName = `@${ourMention.botName}`;
      if (event.text.endsWith(atName)) {
        event.text = event.text.slice(0, -atName.length).trimEnd();
      }
    }
  }

  let agentText = event.text;

  // Prepend referenced/quoted message as context
  if (event.referenceMsg) {
    log.info(`inbound: referenceMsg in handleInbound — content="${event.referenceMsg.content.slice(0, 60)}"`);
    const refLabel = event.referenceMsg.fromType === 1 ? `用户(${event.referenceMsg.from.slice(0, 20)})` : `机器人(${event.referenceMsg.from.slice(0, 20)})`;
    if (!agentText.trim()) {
      agentText = `[引用消息 — ${refLabel}]: "${event.referenceMsg.content}"`;
    } else {
      agentText = `[引用消息 — ${refLabel}]: "${event.referenceMsg.content}"\n---\n${agentText}`;
    }
  }

  if (event.mediaPaths?.length) {
    agentText = `${event.text}\n\nAttached files saved locally — use the read tool to view:\n${event.mediaPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  }

  const rawText = event.text;
  let allowTextCommands = false;
  let hasCommand = false;
  let cmdIngress: ResolvedChannelMessageIngress | undefined;
  try {
    allowTextCommands = api.runtime.channel.commands.shouldHandleTextCommands({
      cfg: api.config,
      surface: "lansenger",
    });
    hasCommand = api.runtime.channel.commands.isControlCommandMessage(rawText, api.config);
  } catch (e: unknown) {
    log.error(`inbound: command detection failed — ${e instanceof Error ? e.message : String(e)}, skipping command checks`);
  }

  if (allowTextCommands && hasCommand) {
    try {
      // merge global commands.ownerAllowFrom for "lansenger:"-prefixed entries
      const globalAllowFrom = (api.config as any)?.commands?.ownerAllowFrom as Array<string | number> | undefined;
      let commandOwnerAllowFrom: string[] | undefined;
      if (Array.isArray(globalAllowFrom) && globalAllowFrom.length > 0) {
        const entries: string[] = [];
        for (const entry of globalAllowFrom) {
          const trimmed = String(entry ?? "").trim();
          if (!trimmed) continue;
          const idx = trimmed.indexOf(":");
          if (idx > 0 && trimmed.slice(0, idx).toLowerCase() === "lansenger") {
            const remainder = trimmed.slice(idx + 1).trim();
            if (remainder) entries.push(remainder);
            continue;
          }
          entries.push(trimmed);
        }
        if (entries.length > 0) commandOwnerAllowFrom = entries;
      }
      cmdIngress = await resolveChannelMessageIngress({
        channelId: "lansenger",
        accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        identity: lansengerIngressIdentity,
        subject: { stableId: event.senderId },
        conversation: { kind: chatType as "direct" | "group", id: event.chatId },
        event: { kind: "slash-command", authMode: "command", mayPair: false },
        policy: {
          dmPolicy: (account.dmPolicy ?? "pairing") as "pairing" | "allowlist" | "open" | "disabled",
          groupPolicy: (account.groupPolicy ?? "open") as "allowlist" | "open" | "disabled",
          command: { useAccessGroups: true, allowTextCommands, hasControlCommand: true },
        },
        command: commandOwnerAllowFrom ? { allowTextCommands, hasControlCommand: true, commandOwnerAllowFrom } : undefined,
        allowFrom: account.allowFrom ?? [],
        useDefaultPairingStore: true,
      });
      if (!cmdIngress?.commandAccess?.authorized) {
        log.info(`inbound: command blocked — sender=${event.senderId} not authorized: ${rawText.slice(0, 60)}`);
        return;
      }
    } catch (e: unknown) {
      log.error(`inbound: command ingress resolution failed — ${e instanceof Error ? e.message : String(e)}, allowing by default`);
    }
  }

  let ackMessageId: string | undefined = undefined;
  if (account.ackMessage) {
    try {
      const entry = runningAccounts.get(runningKey);
      const ackClient = entry?.client ?? makeClient(account, sdkLogger());
      const lang = ackClient.getUserLang(event.senderId);
      const ackText = lang === "en" ? account.ackMessageTextEn : account.ackMessageTextZh;
      const ackResult = await ackClient.sendFormatText(event.chatId, ackText);
      if (ackResult.messageId) {
        ackMessageId = ackResult.messageId;
        log.info(`inbound: ack message sent: messageId=${ackMessageId} lang=${lang}`);
      }
    } catch (e: unknown) {
      log.error(`inbound: ack message send failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  inboundContextStore.set(sessionKey, {
    chatId: event.chatId,
    sessionKey,
    agentId,
    accountId: account.accountId,
    runningKey,
    ackMessageId,
    timestamp: Date.now(),
  });

  try {
    log.info(`inbound.run starting: sessionKey=${sessionKey} agentId=${agentId} accountId=${account.accountId}`);
    await api.runtime.channel.inbound.run({
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
          let storePath: string | undefined;
          try {
            storePath = api.runtime.channel.session.resolveStorePath(undefined, { agentId });
          } catch (e: unknown) {
            log.error(`resolveStorePath failed — ${e instanceof Error ? e.message : String(e)}`);
          }
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
              CommandAuthorized: cmdIngress?.commandAccess?.authorized,
              CommandSource: "text",
              From: event.senderId,
              FromName: event.userName,
              SessionKey: sessionKey,
              ChatType: chatType,
              Channel: "lansenger",
              Provider: "lansenger",
              Surface: "lansenger",
              To: replyTo,
              ReferenceMsg: event.referenceMsg ?? undefined,
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

                const messageIds: string[] = [];
                const turnTextKey = text?.trim() ? `${text.trim().slice(0, 80)}:${text.trim().length}` : "";
                const sessionTextKey = turnTextKey ? `t:${sessionKey}:${turnTextKey}` : "";

                if (text?.trim() && !turnTextDelivered.has(turnTextKey) && !sessionDeliveredSet.has(sessionTextKey)) {
                  turnTextDelivered.add(turnTextKey);
                  sessionDeliveredSet.add(sessionTextKey);
                  const result = await deliverReply(client, to, text);
                  if (result.messageId) messageIds.push(result.messageId);
                }

                for (const mediaUrl of mediaUrls) {
                  const mediaKey = mediaUrl.trim();
                  if (mediaKey && turnMediaDelivered.has(mediaKey)) {
                    log.info(`deliver media dedup skip: ${mediaKey}`);
                    continue;
                  }
                  if (mediaKey) turnMediaDelivered.add(mediaKey);
                  log.info(`deliver media: ${mediaUrl} (turnMediaDelivered size=${turnMediaDelivered.size})`);
                  const readFile = payload.mediaReadFile ?? payload.mediaAccess?.readFile;
                  const originalName = stripOpenClawUuidSuffix(path.basename(mediaUrl));
                  log.info(`deliver media path: ${mediaUrl} readFile=${readFile ? "yes" : "no"} originalName=${originalName}`);
                  if (/^https?:\/\//i.test(mediaUrl)) {
                    const r = await client.sendImageUrl(to, mediaUrl, "", account.dangerouslyAllowPrivateNetwork);
                    if (r.messageId) messageIds.push(r.messageId);
                  } else if (readFile) {
                    const buffer = await readFile(mediaUrl);
                    const ext = path.extname(mediaUrl).toLowerCase() || ".dat";
                    const tmpPath = path.join(os.tmpdir(), `lansenger_media_${crypto.randomUUID()}${ext}`);
                    await fs.writeFile(tmpPath, buffer);
                    try {
                      const r = await client.sendFile(to, tmpPath, "", undefined, originalName);
                      if (r.messageId) messageIds.push(r.messageId);
                    } finally {
                      try { await fs.unlink(tmpPath); } catch {}
                    }
                  } else {
                    const resolved = path.resolve(mediaUrl);
                    if (!isPathAllowed(resolved, account.mediaLocalRoots)) {
                      log.warn(`deliver: path '${resolved}' outside mediaLocalRoots — blocked`);
                      continue;
                    }
                    const r = await client.sendFile(to, resolved, "", undefined, originalName);
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
    log.info(`inbound.run completed: sessionKey=${sessionKey}`);
    activeDeliverySessions.delete(sessionKey);
    inboundContextStore.delete(sessionKey);
    if (ackMessageId && account.revokeAckMessage) {
      try {
        const entry = runningAccounts.get(runningKey);
        const revokeClient = entry?.client ?? makeClient(account, sdkLogger());
        const revokeResult = await revokeClient.revokeMessage([ackMessageId], "bot");
        log.info(`inbound: ack message revoked: messageId=${ackMessageId} success=${revokeResult.success}`);
      } catch (e: unknown) {
        log.error(`inbound: ack message revoke failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e: unknown) {
    log.error(`inbound.run failed: ${e instanceof Error ? e.message : String(e)}`);
    activeDeliverySessions.delete(sessionKey);
    inboundContextStore.delete(sessionKey);
    if (ackMessageId && account.revokeAckMessage) {
      try {
        const entry = runningAccounts.get(runningKey);
        const revokeClient = entry?.client ?? makeClient(account, sdkLogger());
        await revokeClient.revokeMessage([ackMessageId], "bot");
      } catch {}
    }
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