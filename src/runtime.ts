import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { LansengerClient } from "./client.js";
import type { InboundEvent, ClientLogger, ApiResult } from "./client.js";
import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getBindingManager } from "./bindings.js";

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

async function startAccount(api: OpenClawPluginApi, accountId?: string | null): Promise<boolean> {
  const bindingManager = getBindingManager();
  const account = resolveAccount(api.config, accountId);
  if (!account.enabled) {
    log.info(`skip auto-start: account not enabled (accountId=${accountId ?? "default"})`);
    return false;
  }

  const key = account.appId || account.accountId || "__default__";
  if (runningAccounts.has(key)) {
    log.info(`skip auto-start: already running (key=${key})`);
    return true;
  }

  const client = makeClient(account, sdkLogger());
  client.setMessageHandler(async (event: InboundEvent) => {
    await handleInbound(api, event, account, key, bindingManager);
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

export function startLansengerGateway(api: OpenClawPluginApi): void {
  const bindingManager = getBindingManager();

  const section = (api.config.channels as Record<string, any>)?.["lansenger"];
  const accounts = section?.accounts as Record<string, any> | undefined;
  bindingManager.initializeFromConfig(accounts ?? {}, (api.config as any).bindings);
  log.info(`Initialized ${bindingManager.getAllBindings().length} bot bindings`);

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

  api.registerGatewayMethod("lansenger.bind", async (opts) => {
    const { botId, agentId } = opts.params as { botId?: string; agentId?: string };
    if (!botId || !agentId) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", "botId and agentId required"));
      return;
    }
    bindingManager.bindBotToAgent(botId, agentId);
    log.info(`Bound bot ${botId} to agent ${agentId}`);
    opts.respond(true, { message: `Bound ${botId} → ${agentId}` });
  });

  api.registerGatewayMethod("lansenger.unbind", async (opts) => {
    const { botId } = opts.params as { botId?: string };
    if (!botId) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", "botId required"));
      return;
    }
    const removed = bindingManager.removeBinding(botId);
    if (removed) {
      log.info(`Unbound bot ${botId}`);
      opts.respond(true, { message: `Unbound ${botId}` });
    } else {
      opts.respond(false, undefined, errorShape("NOT_LINKED", `No binding for ${botId}`));
    }
  });

  api.registerGatewayMethod("lansenger.bindings", async (opts) => {
    const bindings = bindingManager.getAllBindings();
    opts.respond(true, { bindings });
  });

  api.registerGatewayMethod("lansenger.stop", async (opts) => {
    log.info("lansenger.stop called");
    const accountId = opts.params?.accountId as string | undefined;
    const key = accountId ?? "__default__";
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
        await handleInbound(api, event, account, key, bindingManager);
      }

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });

  autoStart(api, accounts);
}

function autoStart(api: OpenClawPluginApi, accounts?: Record<string, any>): void {
  const section = (api.config.channels as Record<string, any>)?.["lansenger"];

  if (accounts && Object.keys(accounts).length > 0) {
    for (const [accountId] of Object.entries(accounts)) {
      startAccount(api, accountId).catch((e) => log.error(`auto-start error: ${e instanceof Error ? e.message : String(e)}`));
    }
  } else if (section?.appId && section?.appSecret) {
    startAccount(api).catch((e) => log.error(`auto-start error: ${e instanceof Error ? e.message : String(e)}`));
  } else {
    log.info("auto-start: no configured accounts, skipping");
  }
}

async function handleInbound(
  api: OpenClawPluginApi,
  event: InboundEvent,
  account: ResolvedAccount,
  runningKey: string,
  bindingManager: ReturnType<typeof getBindingManager>,
): Promise<void> {
  const chatType = event.isGroup ? "group" : "dm";
  const botId = account.appId;
  
  const binding = bindingManager.getAgentId(botId);
  const agentId = binding ?? account.agentId ?? "default";
  
  log.info(`inbound: ${chatType} from=${event.senderId} bot=${botId.slice(0, 20)}... agent=${agentId}`);

  await runInboundReplyTurn({
    channel: "lansenger",
    accountId: account.accountId ?? undefined,
    raw: event,
    adapter: {
      ingest: () => {
        let agentText = event.text;
        if (event.mediaPaths?.length) {
          agentText = `${event.text}\n\nAttached files saved locally — use the read tool to view:\n${event.mediaPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
        }
        return {
          id: event.messageId,
          rawText: event.text,
          textForAgent: agentText,
          textForCommands: event.text,
          raw: event.rawMessage,
          mediaUrls: event.mediaPaths?.length ? event.mediaPaths : undefined,
        };
      },
      resolveTurn: (input: any, eventClass: any, preflight: any) => {
        const sessionKey = `lansenger:${event.chatId}:${chatType}`;
        const storePath = api.runtime.channel.session.resolveStorePath(undefined, { agentId });
        const replyTo = event.chatId;
        return {
          cfg: api.config,
          channel: "lansenger",
          accountId: account.accountId ?? undefined,
          agentId: "default",
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload: {
            Body: event.text,
            BodyForAgent: event.text,
            From: event.senderId,
            FromName: event.userName,
            SessionKey: sessionKey,
            ChatType: chatType,
            Channel: "lansenger",
            To: replyTo,
          },
          recordInboundSession: api.runtime.channel.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher: api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            deliver: async (payload: any, info: any) => {
              const text: string | undefined = payload.text;
              const to: string = payload.to ?? replyTo;
              if (!text) return { messageIds: [], visibleReplySent: false };

              const entry = runningAccounts.get(runningKey);
              const client = entry?.client ?? makeClient(account, sdkLogger());

              const result = await deliverReply(client, to, text, event.isGroup);
              return { messageIds: result.messageId ? [result.messageId] : [], visibleReplySent: result.success };
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
}

async function deliverReply(client: LansengerClient, to: string, text: string, isGroup?: boolean): Promise<ApiResult> {
  if (isGroup || client.isGroupChat(to)) {
    const fmtResult = await client.sendGroupFormatText(to, text);
    if (fmtResult.success) return fmtResult;
    log.info(`group formatText failed (${fmtResult.error ?? "unknown"}), falling back to text`);
    return client.sendGroupText(to, text);
  }
  const fmtResult = await client.sendFormatText(to, text);
  if (fmtResult.success) return fmtResult;
  log.info(`formatText failed (${fmtResult.error ?? "unknown"}), falling back to text`);
  return client.sendText(to, text);
}