import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext, ChannelAccountSnapshot } from "openclaw/plugin-sdk";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY, resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-handler-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { createChannelInboundDebouncer, shouldDebounceTextInbound, resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound";
import { LansengerClient } from "./client.js";
import type { InboundEvent, ClientLogger, ApiResult, ApproveCardData, LansengerCommand, ReminderParams, GroupSessionMeta } from "./client.js";
import { resolveAccount, makeClient, isPathAllowed } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import { errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { listNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/native-command-registry";
import { resolveNativeCommandsEnabled } from "openclaw/plugin-sdk/native-command-config-runtime";
import { normalizeCommandBody } from "openclaw/plugin-sdk/command-auth";
import { pendingApprovalCards, pendingApprovalCallbacks } from "./channel.js";
import { BUILTIN_COMMAND_I18N } from "./command-i18n.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";

const log = createSubsystemLogger("lansenger");

function sdkLogger(): ClientLogger {
  return {
    info: (msg: string) => log.info(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
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
    eventType: last.eventType,
    referenceMsg: last.referenceMsg,
    isAtMe: last.isAtMe,
    isAtAll: last.isAtAll,
    fromType: last.fromType,
    groupName: last.groupName,
    botCreator: last.botCreator,
    botId: last.botId,
  };
}

const ACK_MESSAGE_ID_KEY = "__lansenger_ack_msg_id";

const runningAccounts = new Map<string, RunningAccount>();
const accountStatusSinks = new Map<string, (patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
const lastInboundChatIds = new Map<string, string>();
const lastInboundTimes = new Map<string, number>();
const sessionDeliveryTracker = new Map<string, Set<string>>();

// Exported for unit tests
export function _clearTestState(): void {
  sessionDeliveryTracker.clear();
  lastInboundChatIds.clear();
  lastInboundTimes.clear();
  sessionAccountTracker.clear();
  runningAccounts.clear();
}
const sessionAccountTracker = new Map<string, string>();

let pluginApi: OpenClawPluginApi | null = null;

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
    debounceMs;
    debouncer = { debounceMs: resolvedMs, enqueue: created.enqueue, flushKey: created.flushKey };
    log.info(`debounce enabled: debounceMs=${resolvedMs} key=${key}`);
  }

  client.setMessageHandler(async (event: InboundEvent) => {
    // Callback events must bypass the debouncer — they have no text to debounce
    if (event.approveCardCallback) {
      await handleInbound(api, event, account, key);
      return;
    }
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

  // Sync native slash commands to Lansenger (fire-and-forget — don't block connection)
  syncLansengerNativeCommands(client, api, key, account).catch((e) =>
    log.error(`syncCommands: unhandled error — ${e instanceof Error ? e.message : String(e)} (key=${key})`),
  );

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

export function getRunningClientByAccountId(accountId?: string | null): LansengerClient | null {
  if (!accountId) return getRunningClient();
  for (const [key, entry] of runningAccounts) {
    if (entry.accountId === accountId || entry.account.appId === accountId) {
      return entry.client;
    }
  }
  for (const [key, entry] of runningAccounts) {
    if (key === accountId) return entry.client;
  }
  return null;
}

export function getRunningAccountByAccountId(accountId?: string | null): ResolvedAccount | null {
  if (!accountId) return getRunningAccount();
  for (const [key, entry] of runningAccounts) {
    if (entry.accountId === accountId || entry.account.appId === accountId) {
      return entry.account;
    }
  }
  for (const [key, entry] of runningAccounts) {
    if (key === accountId) return entry.account;
  }
  return null;
}

export function getLastInboundTimeByAccountId(accountId?: string | null): number | null {
  if (!accountId) return getLastInboundTime();
  for (const [key, entry] of runningAccounts) {
    if (entry.accountId === accountId || entry.account.appId === accountId) {
      return lastInboundTimes.get(key) ?? null;
    }
  }
  for (const [key] of runningAccounts) {
    if (key === accountId) return lastInboundTimes.get(key) ?? null;
  }
  return null;
}

export function setSessionAccountId(sessionKey: string, accountId: string): void {
  sessionAccountTracker.set(sessionKey, accountId);
}

export function getSessionAccountId(sessionKey: string): string | undefined {
  return sessionAccountTracker.get(sessionKey);
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

        return void 0;
      }
    });
  }

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

  // When a restrictive tool profile or allow list is configured, plugin tools
  // may be excluded unless "group:plugins" is in alsoAllow (or allow).
  // Profile "full" has allow: ["*"] — all tools available, no warning needed.
  const toolsConfig = api.config.tools as Record<string, any> | undefined;
  const profile = toolsConfig?.profile as string | undefined;
  const hasProfile = !!profile;
  const hasAllow = !!(toolsConfig?.allow && toolsConfig.allow.length > 0);
  const isRestrictive = hasProfile && profile !== "full" || hasAllow && !hasProfile;
  if (isRestrictive) {
    const allowList = (toolsConfig?.allow ?? []) as string[];
    const alsoAllow = (toolsConfig?.alsoAllow ?? []) as string[];
    const combined = [...allowList, ...alsoAllow];
    if (!combined.some((e: string) => e === "group:plugins" || e === "__openclaw_default_plugin_tools__" || e === "*")) {
      log.warn(
        `Agent tools (lansenger_send_file, etc.) are registered by this channel plugin but may be INVISIBLE under the current tool profile (profile="${toolsConfig?.profile ?? "custom"}").` +
        ` Add to openclaw.json: "tools": { "alsoAllow": ["group:plugins"] }` +
        ` — see https://openclaw.ai/docs/tool-policy for details.`
      );
    }
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

      const url = new URL(req.url ?? "/", "http://localhost");
      const accountId = url.searchParams.get("accountId") ?? undefined;

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf-8");

      const account = resolveAccount(api.config, accountId);
      const key = account.appId || account.accountId || "__default__";
      const entry = runningAccounts.get(key);
      const client = entry?.client ?? makeClient(account, sdkLogger());
      const events = await client.processRawMessage(body);

      log.debug(`inbound: webhook received ${events.length} event(s)`);
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

    const zhCard: ApproveCardData = {
      head: {
        title: "⚠️ 危险命令审批",
        headStatus: {
          describe: "待审批",
          colour: "#FFB116",
        },
      },
      body: {
        title: "危险命令审批请求",
        content: {
          formatType: 1,
          text: `会话 ID: ${sessText}\n命令:\n${cmdText}`,
        },
      },
      buttons: [
        { text: "执行一次", buttonTheme: 1 },
        { text: "本会话有效", buttonTheme: 2 },
        { text: "拒绝执行", buttonTheme: 4 },
      ],
    };

    const enCard: ApproveCardData = {
      head: {
        title: "⚠️ Dangerous Command Approval",
        headStatus: {
          describe: "Pending",
          colour: "#FFB116",
        },
      },
      body: {
        title: "Dangerous Command Approval Request",
        content: {
          formatType: 1,
          text: `Session: ${sessText}\nCommand:\n${cmdText}`,
        },
      },
      buttons: [
        { text: "Approve Once", buttonTheme: 1 },
        { text: "This Session", buttonTheme: 2 },
        { text: "Deny", buttonTheme: 4 },
      ],
    };

    const card = detectedLang === "zh" ? zhCard : enCard;
    log.debug(`sendCard: chatId=${chatId} command=${cmdText.slice(0, 60)} lang=${detectedLang}`);
    const result = await client.sendApproveCard(chatId, card);
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
    log.debug(`updateCard: messageId=${messageId} status=${status} lang=${detectedLang} success=${result.success}`);
    if (!result.success) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", result.error ?? "Failed to update card"));
      return;
    }
    opts.respond(true, { messageId, status, lang: detectedLang, rawResponse: result.rawResponse });
  });

  autoStart(api, accounts);
}

/**
 * Sync native slash commands built from OpenClaw's native command registry.
 * Respects `commands.native` config flag. Syncs to both private (scopeType=6)
 * and group (scopeType=5) scopes separately.
 */
const COMMAND_SCOPE_PRIVATE = 6; // all private chats
const COMMAND_SCOPE_GROUP = 5;     // all groups
const SYNC_RETRY_MAX = 3;
const SYNC_RETRY_DELAY_MS = 30_000;
const syncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ownerSyncDone = new Set<string>();

function buildLansengerCommands(api: OpenClawPluginApi): LansengerCommand[] {
  const nativeSpecs = listNativeCommandSpecsForConfig(api.config, { provider: "lansenger" });
  return nativeSpecs
    .filter((spec) => !spec.isAlias)
    .filter((spec) => {
      const name = spec.name.startsWith("/") ? spec.name.slice(1) : spec.name;
      // Lansenger slash command API only allows alphanumeric + underscores
      return /^[a-zA-Z0-9_]+$/.test(name);
    })
    .map((spec) => {
      const name = spec.name.startsWith("/") ? spec.name.slice(1) : spec.name;
      const cmd: LansengerCommand = {
        command: name,
        description: spec.description,
      };

      const i18n: NonNullable<LansengerCommand["i18nDescription"]> = {};
      const enDesc = spec.descriptionLocalizations?.["en"] ?? spec.description;
      if (enDesc) i18n.en = enDesc;

      const zhHansDesc = spec.descriptionLocalizations?.["zh-Hans"]
        ?? spec.descriptionLocalizations?.["zh"]
        ?? BUILTIN_COMMAND_I18N[name]?.zhHans;
      if (zhHansDesc) i18n.zhHans = zhHansDesc;

      const zhHantDesc = spec.descriptionLocalizations?.["zh-Hant"]
        ?? spec.descriptionLocalizations?.["zh-TW"]
        ?? BUILTIN_COMMAND_I18N[name]?.zhHant;
      if (zhHantDesc) i18n.zhHant = zhHantDesc;

      const zhHantHKDesc = spec.descriptionLocalizations?.["zh-Hant-HK"]
        ?? BUILTIN_COMMAND_I18N[name]?.zhHantHK
        ?? zhHantDesc;
      if (zhHantHKDesc) i18n.zhHantHK = zhHantHKDesc;

      const frDesc = spec.descriptionLocalizations?.["fr"]
        ?? BUILTIN_COMMAND_I18N[name]?.fr;
      if (frDesc) i18n.fr = frDesc;

      if (Object.keys(i18n).length > 0) cmd.i18nDescription = i18n;
      return cmd;
    });
}

function cancelSyncRetry(key: string): void {
  const timer = syncRetryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    syncRetryTimers.delete(key);
  }
}

function scheduleSyncRetry(
  api: OpenClawPluginApi,
  key: string,
  account: ResolvedAccount,
  attempt: number,
): void {
  const timer = setTimeout(() => {
    syncRetryTimers.delete(key);
    const entry = runningAccounts.get(key);
    const retryClient = entry?.client ?? makeClient(account, sdkLogger());
    syncLansengerNativeCommands(retryClient, api, key, account, attempt + 1).catch((e) =>
      log.error(`syncCommands: retry error — ${e instanceof Error ? e.message : String(e)} (key=${key})`),
    );
  }, SYNC_RETRY_DELAY_MS);
  syncRetryTimers.set(key, timer);
}

async function syncLansengerNativeCommands(
  client: LansengerClient,
  api: OpenClawPluginApi,
  key: string,
  account: ResolvedAccount,
  attempt: number = 1,
): Promise<void> {
  try {
    const nativeEnabled = resolveNativeCommandsEnabled({
      providerId: "lansenger",
      config: api.config,
      autoDefault: true,
    });
    if (!nativeEnabled) {
      log.info(`syncCommands: native commands disabled (key=${key}), skipping`);
      cancelSyncRetry(key);
      return;
    }

    const commands = buildLansengerCommands(api);
    if (commands.length === 0) {
      log.info(`syncCommands: no native commands to register (key=${key}), skipping`);
      cancelSyncRetry(key);
      return;
    }
    log.debug(`syncCommands: built ${commands.length} native command(s) (key=${key} attempt=${attempt}/${SYNC_RETRY_MAX})`);

    let hasFailure = false;

    await client.deleteCommands(COMMAND_SCOPE_PRIVATE);
    const privResult = await client.createCommands(COMMAND_SCOPE_PRIVATE, commands);
    if (!privResult.success) {
      log.error(`syncCommands: private scope registration failed — ${privResult.error} (key=${key})`);
      hasFailure = true;
    }

    await client.deleteCommands(COMMAND_SCOPE_GROUP);
    const groupResult = await client.createCommands(COMMAND_SCOPE_GROUP, commands);
    if (!groupResult.success) {
      log.error(`syncCommands: group scope registration failed — ${groupResult.error} (key=${key})`);
      hasFailure = true;
    }

    if (hasFailure && attempt < SYNC_RETRY_MAX) {
      log.debug(`syncCommands: scheduling retry ${attempt + 1}/${SYNC_RETRY_MAX} in ${SYNC_RETRY_DELAY_MS / 1000}s (key=${key})`);
      scheduleSyncRetry(api, key, account, attempt);
    } else if (hasFailure) {
      log.error(`syncCommands: all ${SYNC_RETRY_MAX} attempts exhausted (key=${key})`);
      cancelSyncRetry(key);
    } else {
      cancelSyncRetry(key);
      log.info(`syncCommands: done — ${commands.length} command(s) → private + groups (key=${key})`);
    }
  } catch (e: unknown) {
    log.error(`syncCommands: failed — ${e instanceof Error ? e.message : String(e)} (key=${key} attempt=${attempt}/${SYNC_RETRY_MAX})`);
    if (attempt < SYNC_RETRY_MAX) {
      log.debug(`syncCommands: scheduling retry ${attempt + 1}/${SYNC_RETRY_MAX} after error in ${SYNC_RETRY_DELAY_MS / 1000}s (key=${key})`);
      scheduleSyncRetry(api, key, account, attempt);
    } else {
      cancelSyncRetry(key);
    }
  }
}

export async function gatewayStartAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<unknown> {
  const statusSink = createAccountStatusSink({ accountId: ctx.accountId, setStatus: ctx.setStatus });
  const account = ctx.account;
  const key = account.appId || ctx.accountId || "__default__";

  accountStatusSinks.set(key, statusSink);

  if (runningAccounts.has(key)) {
    const entry = runningAccounts.get(key)!;
    log.info(`gateway: disconnecting existing WS for reconnection with updated config (key=${key})`);
    try { await entry.client.disconnect(); } catch {}
    runningAccounts.delete(key);
  }

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
    // Callback events must bypass the debouncer — they have no text to debounce
    if (event.approveCardCallback) {
      await handleInbound(api, event, account, key);
      return;
    }
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

  // Register native approval runtime context so the framework can route
  // approval cards through our nativeRuntime.deliverPending path.
  if (ctx.channelRuntime) {
    registerChannelRuntimeContext({
      channelRuntime: ctx.channelRuntime,
      channelId: "lansenger",
      accountId: ctx.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: { appId: account.appId },
      abortSignal: ctx.abortSignal,
    });
    // Sync native slash commands (fire-and-forget — don't block gateway startup)
    if (pluginApi) {
      syncLansengerNativeCommands(client, pluginApi, key, account).catch((e) =>
        log.error(`syncCommands: unhandled error — ${e instanceof Error ? e.message : String(e)} (key=${key})`),
      );
    }
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

async function handleApproveCardCallback(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  runningKey: string,
): Promise<void> {
  const callback = event.approveCardCallback!;
  const { eventData: callbackInfo, staffId } = callback;

  // Parse callbackInfo: "{choice}:{requestId}"
  const colonIdx = callbackInfo.indexOf(":");
  if (colonIdx <= 0) {
    log.warn(`approveCard callback: invalid callbackInfo format: "${callbackInfo}"`);
    return;
  }
  const choice = callbackInfo.slice(0, colonIdx);
  const requestId = callbackInfo.slice(colonIdx + 1);

  if (!["once", "session", "always", "deny"].includes(choice)) {
    log.warn(`approveCard callback: unknown choice "${choice}" in callbackInfo: "${callbackInfo}"`);
    return;
  }

  log.info(`approveCard callback: choice=${choice} requestId=${requestId} staffId=${staffId}`);

  // Look up pending approval mapping
  const mapping = pendingApprovalCallbacks.get(requestId);
  if (!mapping) {
    log.warn(`approveCard callback: no pending approval found for requestId=${requestId}`);
    return;
  }

  const { messageId, lang, chatId } = mapping;

  // Get client for card update
  const entry = runningAccounts.get(runningKey);
  const client = entry?.client ?? makeClient(account, sdkLogger());

  // Map choice to approval decision
  const decisionMap: Record<string, "allow-once" | "allow-always" | "deny"> = {
    once: "allow-once",
    session: "allow-once",
    always: "allow-always",
    deny: "deny",
  };
  const decision = decisionMap[choice]!;
  const strategyKind = choice as "allow-once" | "allow-session" | "allow-always" | "deny";
  const displayStrategyKind = choice === "session" ? "allow-session" : (choice === "always" ? "allow-always" : (choice === "once" ? "allow-once" : "deny"));

  // Button theme matches the original button: 1=primary, 2=secondary, 3=secondary-black, 4=warning
  const buttonThemeMap: Record<string, number> = { once: 1, session: 2, always: 3, deny: 4 };

  // Update card status
  const status: "approved" | "denied" = choice === "deny" ? "denied" : "approved";
  const cardResult = await client.updateCardStatus(messageId, status, lang, displayStrategyKind, buttonThemeMap[choice]);
  log.info(`approveCard callback: card update — status=${status} lang=${lang} success=${cardResult.success}`);

  // Resolve approval via framework
  try {
    await resolveApprovalOverGateway({
      cfg: api.config,
      approvalId: requestId,
      decision,
      senderId: staffId,
    });
    log.info(`approveCard callback: approval resolved — requestId=${requestId} decision=${decision}`);
  } catch (e: unknown) {
    log.error(`approveCard callback: resolveApprovalOverGateway failed — ${e instanceof Error ? e.message : String(e)}`);
    // Card is already updated, so don't re-throw
  }

  // Clean up
  pendingApprovalCallbacks.delete(requestId);
  const cardKey = account.accountId ? `${account.accountId}:${chatId}` : chatId;
  pendingApprovalCards.delete(cardKey);
  log.info(`approveCard callback: cleaned up — requestId=${requestId} chatId=${chatId}`);
}
interface PolicyResult {
  allowed: boolean;
  reminder?: ReminderParams;
  refMsgId?: string;
}

async function handleDmPolicy(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  runningKey: string,
): Promise<PolicyResult> {
  const dmPolicy = account.dmPolicy ?? "pairing";
  const configAllowFrom = account.allowFrom ?? [];
  const pairing = (api.runtime as any)?.channel?.pairing;
  let storeAllowFrom: string[] = [];
  try {
    if (pairing?.readAllowFromStore) {
      storeAllowFrom = await pairing.readAllowFromStore({ channel: "lansenger", accountId: account.accountId ?? undefined });
    }
  } catch (e: unknown) {
    log.error(`inbound: readAllowFromStore failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  const effectiveAllowFrom = [...new Set([...configAllowFrom, ...storeAllowFrom])];
  log.debug(
    `inbound: dm config — dmPolicy=${dmPolicy} ` +
    `configAllowFrom=[${configAllowFrom.join(",")}] ` +
    `storeAllowFrom=[${storeAllowFrom.join(",")}] ` +
    `senderAllowed=${effectiveAllowFrom.some((id: string) => {
      const bare = id.replace(/^lansenger:/, "");
      return bare === event.senderId || id === event.senderId;
    })}`
  );
  const senderAllowed = effectiveAllowFrom.some((id: string) => {
    const bare = id.replace(/^lansenger:/, "");
    return bare === event.senderId || id === event.senderId;
  });

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
      return { allowed: false };
    }
    if (dmPolicy === "disabled") {
      log.info(`inbound: dm dropped — dmPolicy=disabled sender=${event.senderId}`);
      return { allowed: false };
    }
    if (dmPolicy === "allowlist") {
      log.info(`inbound: dm dropped — sender=${event.senderId} not in allowFrom (dmPolicy=allowlist)`);
      return { allowed: false };
    }
  }

  // personal bot: the DM sender IS the owner — only one person can DM a personal bot
  const entry = runningAccounts.get(runningKey);
  if (entry) entry.client.ownerId = event.senderId;

  // Auto-configure homeChannel on the first DM so tools/apps can resolve the owner ID
  // without needing a DM to come in first (survives gateway restart).
  if (event.senderId && account.appId) {
    const section = (api.config.channels as any)?.["lansenger"];
    if (section?.configWrites !== false) {
      const isMultiAccount = !!section?.accounts;
      const accountKey = account.accountId || account.appId;
      const rawHomeChannel: string | undefined = isMultiAccount
        ? section?.accounts?.[accountKey]?.homeChannel
        : section?.homeChannel;
      if (!rawHomeChannel) {
        const configPath = isMultiAccount
          ? `channels.lansenger.accounts.${accountKey}.homeChannel`
          : "channels.lansenger.homeChannel";
        try {
          execSync(
            `openclaw config set ${configPath} "${event.senderId}"`,
            { stdio: "pipe", timeout: 5000 },
          );
          log.info(`autoConfigureHomeChannel: set ${configPath} = "${event.senderId}"`);
        } catch (e: any) {
          log.warn(`autoConfigureHomeChannel: ${e.message}`);
        }
      }
    }
  }

  // Auto-configure commands.ownerAllowFrom on first DM so the owner can use
  // slash commands without manually adding themselves to the allow list.
  if (account.appId) {
    try {
      const commandsCfg = (api.config as any)?.commands ?? {};
      const existing: string[] = commandsCfg?.ownerAllowFrom ?? [];
      const id = `lansenger:${event.senderId}`;
      const bare = event.senderId;
      const alreadyExists = existing.some(
        (e: string) => e === id || e === bare || e.replace(/^lansenger:/, "") === bare,
      );
      if (!alreadyExists) {
        const updated = [...existing, id];
        execSync(
          `openclaw config set commands.ownerAllowFrom '${JSON.stringify(updated)}'`,
          { stdio: "pipe", timeout: 5000 },
        );
        log.info(`autoConfigureCommandOwner: set commands.ownerAllowFrom = ${JSON.stringify(updated)}`);
      }
    } catch (e: any) {
      log.warn(`autoConfigureCommandOwner: ${e.message}`);
    }
  }

  // autoMentionReply / autoQuoteReply for DMs: account > section
  let reminder: ReminderParams | undefined;
  let refMsgId: string | undefined;
  if (account.autoMentionReply && event.senderId) {
    reminder = { userIds: [event.senderId] };
    log.info(`inbound: autoMentionReply enabled (DM), reminder set for sender=${event.senderId}`);
  }
  if (account.autoQuoteReply && event.messageId) {
    refMsgId = event.messageId;
    log.info(`inbound: autoQuoteReply enabled (DM), refMsgId=${event.messageId}`);
  }

  return { allowed: true, reminder, refMsgId };
}

async function handleGroupPolicy(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  runningKey: string,
): Promise<PolicyResult> {
  try {
    const channelCfg = (api.config as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
    const lansengerCfg = channelCfg?.lansenger as Record<string, unknown> | undefined;
    const accountCfg = (lansengerCfg?.accounts as Record<string, Record<string, unknown>> | undefined)?.[account.accountId ?? "default"];
    const channelGroupAllowFrom = (lansengerCfg?.groupAllowFrom as unknown[]) ?? [];
    const accountGroupAllowFrom = (accountCfg?.groupAllowFrom as unknown[]) ?? [];
    const hasGroupAllowFrom = channelGroupAllowFrom.length > 0 || accountGroupAllowFrom.length > 0;
    // Resolve effective groupPolicy mode: account > section > default "open".
    const effectiveGroupPolicyMode = (accountCfg?.groupPolicy as string | undefined)
      ?? (lansengerCfg?.groupPolicy as string | undefined)
      ?? "open";

    const groupPolicy = api.runtime.channel.groups.resolveGroupPolicy({
      cfg: api.config,
      channel: "lansenger",
      groupId: event.chatId,
      accountId: account.accountId,
      hasGroupAllowFrom,
    });
    log.debug(
      `inbound: groupPolicy resolved — chatId=${event.chatId} ` +
      `mode=${effectiveGroupPolicyMode ?? "default"} ` +
      `allowlistEnabled=${groupPolicy.allowlistEnabled} ` +
      `allowed=${groupPolicy.allowed} ` +
      `hasGroupConfig=${Boolean(groupPolicy.groupConfig)} ` +
      `hasDefaultConfig=${Boolean(groupPolicy.defaultConfig)} ` +
      `hasGroupAllowFrom=${hasGroupAllowFrom} ` +
      `accountId=${account.accountId}`
    );
    if (!groupPolicy.allowed) {
      // Workaround SDK bug: when open mode has groups entries, the SDK
      // incorrectly sets allowlistEnabled=true and blocks unlisted groups.
      if (effectiveGroupPolicyMode === "open" && !groupPolicy.groupConfig) {
        // pass through — open mode allows unlisted groups
      } else {
        log.info(`inbound: group dropped — groupPolicy not allowed for chatId=${event.chatId}`);
        return { allowed: false };
      }
    }
    const groupConfig = groupPolicy.groupConfig as Record<string, unknown> | undefined;
    const perGroupAllowFrom = groupConfig?.allowFrom as string[] | undefined;
    const effectiveGroupAllowFrom = perGroupAllowFrom && perGroupAllowFrom.length > 0
      ? perGroupAllowFrom
      : (accountGroupAllowFrom.length > 0 ? accountGroupAllowFrom : channelGroupAllowFrom);
    if (effectiveGroupAllowFrom.length > 0 && !effectiveGroupAllowFrom.includes(event.senderId)) {
      log.info(`inbound: group dropped — sender=${event.senderId} not in allowFrom for chatId=${event.chatId}`);
      return { allowed: false };
    }
    if (groupConfig?.enabled === false) {
      log.info(`inbound: group dropped — enabled=false for chatId=${event.chatId}`);
      return { allowed: false };
    }

    // autoMentionReply / autoQuoteReply: per-group > account > section
    let reminder: ReminderParams | undefined;
    let refMsgId: string | undefined;
    const autoMentionReply = groupConfig?.autoMentionReply as boolean | undefined
      ?? account.autoMentionReply ?? false;
    const autoQuoteReply = groupConfig?.autoQuoteReply as boolean | undefined
      ?? account.autoQuoteReply ?? false;
    const respondToAtAll = groupConfig?.respondToAtAll as boolean | undefined
      ?? account.respondToAtAll ?? false;
    if (autoMentionReply && event.senderId) {
      reminder = { userIds: [event.senderId] };
      log.info(`inbound: autoMentionReply enabled (group), reminder set for sender=${event.senderId}`);
    }
    if (autoQuoteReply && event.messageId) {
      refMsgId = event.messageId;
      log.info(`inbound: autoQuoteReply enabled (group), refMsgId=${event.messageId}`);
    }

    // Resolve requireMention: account-level requireMention overrides SDK default.
    const configRequireMention = accountCfg?.requireMention as boolean | undefined
      ?? lansengerCfg?.requireMention as boolean | undefined;
    const requireMention = api.runtime.channel.groups.resolveRequireMention({
      cfg: api.config,
      channel: "lansenger",
      groupId: event.chatId,
      accountId: account.accountId,
      ...(configRequireMention !== undefined ? { requireMentionOverride: configRequireMention } : {}),
    });
    const atMe = event.isAtMe ?? false;
    const atAll = event.isAtAll ?? false;
    log.info(`inbound: group allowed — chatId=${event.chatId} requireMention=${requireMention} isAtMe=${atMe} isAtAll=${atAll}`);
    // @all is only a valid mention when respondToAtAll is enabled.
    const effectiveAt = atMe || (atAll && respondToAtAll);
    if (requireMention && !effectiveAt) {
      log.info(`inbound: group dropped — requireMention but bot not @mentioned`);
      return { allowed: false };
    }
    return { allowed: true, reminder, refMsgId };
  } catch (e: unknown) {
    log.error(`inbound: group policy check failed — ${e instanceof Error ? e.message : String(e)}`);
    return { allowed: true };
  }
}

interface CommandAuthResult {
  allowTextCommands: boolean;
  shouldComputeAuth: boolean;
  hasCommand: boolean;
  commandAuthorized: boolean | undefined;
}

function checkCommandAuth(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  textForCommands: string,
): CommandAuthResult {
  let allowTextCommands = false;
  let shouldComputeAuth = false;
  let hasCommand = false;
  try {
    allowTextCommands = api.runtime.channel.commands.shouldHandleTextCommands({
      cfg: api.config,
      surface: "lansenger",
    });
    shouldComputeAuth = api.runtime.channel.commands.shouldComputeCommandAuthorized(textForCommands, api.config);
    hasCommand = api.runtime.channel.commands.isControlCommandMessage(textForCommands, api.config);
    log.debug(
      `inbound: command detection — allowTextCommands=${allowTextCommands} ` +
      `shouldComputeAuth=${shouldComputeAuth} hasCommand=${hasCommand} ` +
      `textForCommands="${textForCommands.slice(0, 60)}"`
    );
  } catch (e: unknown) {
    log.error(`inbound: command detection failed — ${e instanceof Error ? e.message : String(e)}, skipping command checks`);
    return { allowTextCommands: false, shouldComputeAuth: false, hasCommand: false, commandAuthorized: undefined };
  }

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
        try {
          commandAuthorized = api.runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers({
            useAccessGroups,
            authorizers: [
              { configured: ownerAllowFrom.length > 0, allowed: ownerAllowFrom.some(senderMatches) },
              { configured: channelAllowFrom.length > 0, allowed: channelAllowFrom.some(senderMatches) },
            ],
          });
        } catch (e: unknown) {
          log.error(`inbound: resolveCommandAuthorizedFromAuthorizers failed — ${e instanceof Error ? e.message : String(e)}`);
          commandAuthorized = undefined;
        }
      }
    }
    log.debug(
      `inbound: command auth — commandAuthorized=${commandAuthorized} ` +
      `explicitAllowFrom_configured=${Boolean(explicitAllowFrom)} ` +
      `ownerAllowFrom_count=${ownerAllowFrom.length} ` +
      `channelAllowFrom_count=${(account.allowFrom ?? []).length} ` +
      `senderId=${event.senderId}`
    );
  }

  return { allowTextCommands, shouldComputeAuth, hasCommand, commandAuthorized };
}

async function handleInbound(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  runningKey: string,
): Promise<void> {
  const chatType = event.isGroup ? "group" : "dm";
  log.debug(
    `inbound: raw event — chatType=${chatType} chatId=${event.chatId} ` +
    `senderId=${event.senderId} msgType=${event.msgType ?? "text"} eventType=${event.eventType ?? "n/a"} ` +
    `isAtMe=${event.isAtMe ?? false} isAtAll=${event.isAtAll ?? false} ` +
    `mediaCount=${event.mediaPaths?.length ?? 0} ` +
    `text=${(event.text ?? "").slice(0, 80)}`
  );

  // Handle approveCard button click callbacks
  if (event.approveCardCallback) {
    await handleApproveCardCallback(api, event, account, runningKey);
    return;
  }
  const turnTextDelivered = new Set<string>();
  const turnMediaDelivered = new Set<string>();

  // ── DM POLICY ──
  let reminder: ReminderParams | undefined;
  let refMsgId: string | undefined;
  if (chatType === "dm") {
    const dmResult = await handleDmPolicy(api, event, account, runningKey);
    if (!dmResult.allowed) return;
    reminder = dmResult.reminder;
    refMsgId = dmResult.refMsgId;
  }

  // ── SYNC COMMANDS ON FIRST OWNER DM ──
  if (!ownerSyncDone.has(runningKey)) {
    ownerSyncDone.add(runningKey);
    const entry = runningAccounts.get(runningKey);
    if (entry) {
      log.info(`syncCommands: triggered by first owner DM (key=${runningKey})`);
      cancelSyncRetry(runningKey);
      syncLansengerNativeCommands(entry.client, api, runningKey, account).catch((e) =>
        log.error(`syncCommands: owner-triggered sync error — ${e instanceof Error ? e.message : String(e)} (key=${runningKey})`),
      );
    }
  }

  // ── GROUP POLICY ──
  if (event.isGroup) {
    const grpResult = await handleGroupPolicy(api, event, account, runningKey);
    if (!grpResult.allowed) return;
    reminder = grpResult.reminder;
    refMsgId = grpResult.refMsgId;
  }

  // ── AGENT ROUTING ──
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
  if (account.accountId) {
    setSessionAccountId(sessionKey, account.accountId);
  }

  const sessionDeliveredSet = sessionDeliveryTracker.get(sessionKey) ?? new Set<string>();
  sessionDeliveryTracker.set(sessionKey, sessionDeliveredSet);

  log.info(`inbound: ${chatType} from=${event.senderId} bot=${account.appId.slice(0, 20)}... agent=${agentId} session=${sessionKey.slice(0, 32)}`);

  // ── TEXT ASSEMBLY ──
  let agentText = event.text;
  if (event.mediaPaths?.length) {
    agentText = `${event.text}\n\nAttached files saved locally — use the read tool to view:\n${event.mediaPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  }
  if (event.referenceMsg) {
    try {
      const refEntry = runningAccounts.get(runningKey);
      const refClient = refEntry?.client ?? makeClient(account, sdkLogger());
      const refText = await refClient.extractReferenceText(event.referenceMsg);
      if (refText) {
        agentText = `${agentText}\n\n${refText}`;
      }
    } catch (e: unknown) {
      log.error(`inbound: reference message extraction failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── COMMAND NORMALIZATION ──
  const rawText = event.text;

  // Resolve botUsername from event for command normalization.
  // The SDK's normalizeCommandBody() strips @botName from slash commands
  // (e.g. "/reset@OpenClawBot" → "/reset") when botUsername matches.
  let botUsername: string | undefined;
  {
    const ourBotId = event.rawMessage?.botId as string | undefined;
    const ourMention = ourBotId ? event.mentionedBots?.find(b => b.botId === ourBotId) : undefined;
    botUsername = ourMention?.botName;
  }

  // Normalize command text via the SDK — handles @botName suffix on slash commands,
  // colon variants, and text alias resolution (same pattern used by Telegram channel plugin).
  const textForCommands = normalizeCommandBody(event.text, { botUsername });
  if (textForCommands !== event.text) {
    log.debug(`inbound: normalized command body — "${event.text.slice(0, 60)}" → "${textForCommands.slice(0, 60)}"`);
  }

  // ── COMMAND AUTH ──
  const auth = checkCommandAuth(api, event, account, textForCommands);
  const { allowTextCommands, shouldComputeAuth, hasCommand, commandAuthorized } = auth;

  // ── COMMAND BLOCK CHECK ──
  if (allowTextCommands && hasCommand && commandAuthorized !== true) {
    log.info(`inbound: command blocked — sender=${event.senderId} not authorized`);
    // Reply with an unauthorized message instead of silently dropping
    const replyClient = runningAccounts.get(runningKey)?.client ?? makeClient(account, sdkLogger());
    const lang = replyClient.getUserLang(event.senderId);
    const denyText = lang === "en"
      ? "This command requires authorization."
      : "此命令需要授权。";
    replyClient.sendFormatText(event.chatId, denyText).catch(() => {});
    return;
  }

  // ── ACK MESSAGE ──
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
        log.debug(`inbound: ack message sent: messageId=${ackMessageId} lang=${lang} text="${ackText}"`);
      }
    } catch (e: unknown) {
      log.error(`inbound: ack message send failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── GROUP METADATA ──
  let groupMeta: GroupSessionMeta | null = null;
  if (event.isGroup) {
    try {
      const metaClient = runningAccounts.get(runningKey)?.client ?? makeClient(account, sdkLogger());
      groupMeta = await metaClient.getGroupSessionMeta(event.chatId);
      log.info(`inbound: groupMeta fetched — chatId=${event.chatId} groupName=${groupMeta?.groupInfo?.name ?? "n/a"} memberCount=${groupMeta?.memberCount ?? 0} hasMembers=${groupMeta?.members !== null}`);
    } catch (e: unknown) {
      log.error(`inbound: getGroupSessionMeta failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── INBOUND CORE ──
  try {
    log.debug(
      `inbound: pre-run ctxPayload — ` +
      `Body="${(event.text as string).slice(0, 80)}" ` +
      `BodyForAgent="${agentText.slice(0, 80)}" ` +
      `CommandBody="${textForCommands.slice(0, 80)}" ` +
      `hasCommand=${hasCommand} commandAuthorized=${commandAuthorized} ` +
      `allowTextCommands=${allowTextCommands} shouldComputeAuth=${shouldComputeAuth} ` +
      `chatType=${chatType} isGroup=${event.isGroup} isAtMe=${event.isAtMe}`
    );
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
            textForCommands: textForCommands,
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
              CommandBody: textForCommands,
              BodyForCommands: textForCommands,
              CommandAuthorized: commandAuthorized,
              CommandSource: "text",
              ...(botUsername ? { BotUsername: botUsername } : {}),
              From: event.senderId,
              SenderName: event.userName,
              FromName: event.userName,
              FromType: event.fromType,
              SessionKey: sessionKey,
              AccountId: account.accountId ?? account.appId,
              ChatType: chatType,
              ChatName: event.chatName,
              MessageSid: event.messageId,
              GroupName: event.groupName,
              IsGroup: event.isGroup,
              IsAtMe: event.isAtMe,
              IsAtAll: event.isAtAll,
              Channel: "lansenger",
              Provider: "lansenger",
              Surface: "lansenger",
              To: replyTo,
              AppId: account.appId,
              ...(event.isGroup ? { 
                GroupId: event.chatId,
                GroupInfo: JSON.stringify({ groupId: event.chatId, ...(groupMeta?.groupInfo ?? {}) }),
              } : {}),
              ...(groupMeta?.members ? { GroupMembers: JSON.stringify(groupMeta.members) } : {}),
              ...(groupMeta ? { GroupMemberCount: groupMeta.memberCount } : {}),
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
                  const result = await deliverReply(client, to, text, { reminder, refMsgId });
                  if (result.messageId) messageIds.push(result.messageId);
                }

                for (const mediaUrl of mediaUrls) {
                  const mediaKey = mediaUrl.trim();
                  if (mediaKey && turnMediaDelivered.has(mediaKey)) {
                    log.debug(`deliver media dedup skip: ${mediaKey}`);
                    continue;
                  }
                  if (mediaKey) turnMediaDelivered.add(mediaKey);
                  log.debug(`deliver media: ${mediaUrl} (turnMediaDelivered size=${turnMediaDelivered.size})`);
                  const readFile = payload.mediaReadFile ?? payload.mediaAccess?.readFile;
                  const originalName = stripOpenClawUuidSuffix(path.basename(mediaUrl));
                  log.debug(`deliver media path: ${mediaUrl} readFile=${readFile ? "yes" : "no"} originalName=${originalName}`);
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
    log.info(`inbound.run completed: sessionKey=${sessionKey.slice(0, 32)}`);
    if (ackMessageId && account.revokeAckMessage) {
      try {
        const entry = runningAccounts.get(runningKey);
        const revokeClient = entry?.client ?? makeClient(account, sdkLogger());
        const revokeChatType = event.isGroup ? "group" : "bot";
        const revokeResult = await revokeClient.revokeMessage([ackMessageId], revokeChatType);
        log.info(`inbound: ack message revoked: messageId=${ackMessageId} success=${revokeResult.success}`);
      } catch (e: unknown) {
        log.error(`inbound: ack message revoke failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e: unknown) {
    log.error(`inbound.run failed: ${e instanceof Error ? e.message : String(e)}`);
    if (ackMessageId && account.revokeAckMessage) {
      try {
        const entry = runningAccounts.get(runningKey);
        const revokeClient = entry?.client ?? makeClient(account, sdkLogger());
        const revokeChatType = event.isGroup ? "group" : "bot";
        await revokeClient.revokeMessage([ackMessageId], revokeChatType);
      } catch {}
    }
  }
}

async function deliverReply(client: LansengerClient, to: string, text: string, opts?: { reminder?: ReminderParams; refMsgId?: string }): Promise<ApiResult> {
  log.debug(`deliverReply: to=${to} textLen=${text.length} preview="${text.slice(0, 100)}"`);
  log.debug(`deliverReply: refMsgId=${opts?.refMsgId ?? "none"} reminderUserIds=[${(opts?.reminder?.userIds ?? []).join(",")}]`);
  if (!text.trim()) {
    log.warn(`deliverReply: empty text after OpenClaw MEDIA processing, skipping delivery`);
    return { success: true, messageId: undefined };
  }
  const fmtResult = await client.sendFormatText(to, text, opts?.reminder ? { reminder: opts.reminder, refMsgId: opts.refMsgId } : (opts?.refMsgId ? { refMsgId: opts.refMsgId } : undefined));
  if (fmtResult.success) return fmtResult;
  log.info(`formatText failed (${fmtResult.error ?? "unknown"}), falling back to text`);
  return client.sendText(to, text, opts?.reminder ? { reminder: opts.reminder, refMsgId: opts.refMsgId } : (opts?.refMsgId ? { refMsgId: opts.refMsgId } : undefined));
}