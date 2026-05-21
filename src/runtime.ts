import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext, ChannelAccountSnapshot } from "openclaw/plugin-sdk";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { createAccountStatusSink, waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { createChannelInboundDebouncer, shouldDebounceTextInbound, resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound";
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
  };
}

const ACK_MESSAGE_ID_KEY = "__lansenger_ack_msg_id";

const runningAccounts = new Map<string, RunningAccount>();
const accountStatusSinks = new Map<string, (patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
const lastInboundChatIds = new Map<string, string>();
const lastInboundTimes = new Map<string, number>();

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
  pluginApi = api;
  (globalThis as any).__lansenger_channel = {
    getRunningClient,
    getRunningAccount,
    getLastInboundChatId,
  };

  const rt = api.runtime as any;
  const rtKeys = rt ? Object.keys(rt) : [];
  const channelKeys = rt?.channel ? Object.keys(rt.channel) : [];
  log.info(`plugin startup: runtime available=${!!rt} runtimeKeys=${rtKeys.join(",")} channelKeys=${channelKeys.join(",")}`);
  if (!rt?.channel?.turn) {
    log.error(`plugin startup: api.runtime.channel.turn is UNDEFINED — inbound messages will fail! OpenClaw version may be too old (need 2026.5.x+)`);
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
    try {
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
    } catch (e: unknown) {
      log.error(`inbound: group policy check failed — ${e instanceof Error ? e.message : String(e)}`);
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
    sessionKey = `agent:main:lansenger:${chatType}:${event.chatId}`;
  }
  const replyTo = event.chatId;
  lastInboundChatIds.set(runningKey, event.chatId);
  lastInboundTimes.set(runningKey, Date.now());

  log.info(`inbound: ${chatType} from=${event.senderId} bot=${account.appId.slice(0, 20)}... agent=${agentId}`);

  let agentText = event.text;
  if (event.mediaPaths?.length) {
    agentText = `${event.text}\n\nAttached files saved locally — use the read tool to view:\n${event.mediaPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  }

  const rawText = event.text;
  let allowTextCommands = false;
  let shouldComputeAuth = false;
  let hasCommand = false;
  try {
    allowTextCommands = api.runtime.channel.commands.shouldHandleTextCommands({
      cfg: api.config,
      surface: "lansenger",
    });
    shouldComputeAuth = api.runtime.channel.commands.shouldComputeCommandAuthorized(rawText, api.config);
    hasCommand = api.runtime.channel.commands.isControlCommandMessage(rawText, api.config);
  } catch (e: unknown) {
    log.error(`inbound: command detection failed — ${e instanceof Error ? e.message : String(e)}, skipping command checks`);
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
  }

  if (allowTextCommands && hasCommand && commandAuthorized !== true) {
    log.info(`inbound: command blocked — sender=${event.senderId} not authorized: ${rawText.slice(0, 60)}`);
    return;
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

  try {
    log.info(`turn.run starting: sessionKey=${sessionKey} agentId=${agentId} accountId=${account.accountId}`);
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

                const messageIds: string[] = [];
                const textKey = text?.trim() ? `${text.trim().slice(0, 80)}:${text.trim().length}` : "";

                if (text?.trim() && !turnTextDelivered.has(textKey)) {
                  turnTextDelivered.add(textKey);
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
                    const r = await client.sendImageUrl(to, mediaUrl, "");
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
    log.info(`turn.run completed: sessionKey=${sessionKey}`);
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
    log.error(`turn.run failed: ${e instanceof Error ? e.message : String(e)}`);
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