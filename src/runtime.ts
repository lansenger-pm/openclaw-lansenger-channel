import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { LansengerClient } from "./client.js";
import type { InboundEvent, ClientLogger, ApiResult, AppCardData } from "./client.js";
import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import { errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { IncomingMessage, ServerResponse } from "node:http";

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

export function startLansengerGateway(api: OpenClawPluginApi): void {
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
        await handleInbound(api, event, account, key);
      }

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });

  api.registerGatewayMethod("lansenger.sendCard", async (opts) => {
    const { chatId, lang } = opts.params as { chatId?: string; lang?: string };
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

    const zhCard: AppCardData = {
      headTitle: "⚠️ 命令审批",
      isDynamic: true,
      headStatusInfo: {
        description: '<div style="color:#FFB116;text-align:left">待审批</div>',
        colour: "#FFB116",
      },
      bodyTitle: "危险命令审批请求",
      bodyContent: '<div style="color:#000;font-size:13pt;text-align:left;text-indent:0em">会话 ID: test-session-001\n命令:\nrm -rf /tmp/old-data</div>',
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
      bodyContent: '<div style="color:#000;font-size:13pt;text-align:left;text-indent:0em">Session: test-session-001\nCommand:\nrm -rf /tmp/old-data</div>',
      signature: "OpenClaw Security",
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
    const validStatus = ["pending", "approved", "denied"].includes(status ?? "") ? status as "pending" | "approved" | "denied" : "pending";
    const result = await client.updateCardStatus(messageId, validStatus, detectedLang);
    if (!result.success) {
      opts.respond(false, undefined, errorShape("UNAVAILABLE", result.error ?? "Failed to update card"));
      return;
    }
    opts.respond(true, { messageId, status: validStatus, lang: detectedLang, rawResponse: result.rawResponse });
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
  const agentId = account.agentId ?? "default";
  const sessionKey = `lansenger:${event.chatId}:${chatType}`;
  const replyTo = event.chatId;

  log.info(`inbound: ${chatType} from=${event.senderId} bot=${account.appId.slice(0, 20)}... agent=${agentId}`);

  let agentText = event.text;
  if (event.mediaPaths?.length) {
    agentText = `${event.text}\n\nAttached files saved locally — use the read tool to view:\n${event.mediaPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
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
    log.info(`turn.run completed: sessionKey=${sessionKey}`);
  } catch (e: unknown) {
    log.error(`turn.run failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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