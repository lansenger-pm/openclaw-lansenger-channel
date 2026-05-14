import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import WebSocket from "ws";

export type ClientLogger = {
  info: (message: string) => void;
  error: (message: string) => void;
};

const silentLogger: ClientLogger = { info: () => {}, error: () => {} };

const DEFAULT_API_GATEWAY_URL = "https://open.e.lanxin.cn/open/apigw";
const MAX_MESSAGE_LENGTH = 4000;
const RECONNECT_BACKOFF = [2, 5, 10, 30, 60];
const HEARTBEAT_INTERVAL_MS = 30_000;
const LANG_DETECT_THRESHOLD = 0.6;

const API_ENDPOINTS = {
  appToken: "/v1/apptoken/create",
  wsEndpoint: "/v1/ws/endpoint/create",
  privateMessage: "/v1/bot/messages/create",
  groupMessage: "/v1/messages/group/create",
  uploadMedia: "/v1/medias/create",
  fetchMedia: "/v1/medias",
  revokeMessage: "/v1/messages/revoke",
  dynamicUpdate: "/v1/messages/dynamic/update",
};

export type ApiResult = {
  success: boolean;
  messageId?: string | undefined;
  error?: string | undefined;
  rawResponse?: unknown;
};

export function mediaTypeFromPath(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return 2;
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp"].includes(ext)) return 1;
  return 3;
}

function detectImageExt(bytes: Buffer): string {
  if (bytes.length < 2) return ".jpg";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].some((s) => bytes.subarray(0, 6).toString("ascii") === s)) return ".gif";
  return ".jpg";
}

function detectExtFromBytes(bytes: Buffer, mediaKind: string): string {
  if (mediaKind === "image") return detectImageExt(bytes);
  if (mediaKind === "video") return ".mp4";
  if (mediaKind === "voice") return ".amr";
  if (bytes.length < 4) return ".dat";
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return ".pdf";
  if (bytes.subarray(0, 4).toString("ascii") === "PK\x03\x04") return ".zip";
  if (bytes.length >= 8 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return ".wav";
  return ".dat";
}

export class LansengerClient {
  private appId: string;
  private appSecret: string;
  private apiGatewayUrl: string;
  private appToken: string | null = null;
  private tokenExpiry = 0;
  private ws: WebSocket | null = null;
  private wsTask: Promise<void> | null = null;
  private running = false;
  private backoffIdx = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: ((event: InboundEvent) => Promise<void>) | null = null;
  private log: ClientLogger;
  private chatTypeMap = new Map<string, "group" | "dm">();
  private userLangMap = new Map<string, "zh" | "en">();

  constructor(config: { appId: string; appSecret: string; apiGatewayUrl?: string; logger?: ClientLogger }) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.apiGatewayUrl = config.apiGatewayUrl ?? DEFAULT_API_GATEWAY_URL;
    this.log = config.logger ?? silentLogger;
  }

  setMessageHandler(handler: (event: InboundEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async getAppToken(): Promise<string | null> {
    if (this.appToken && Date.now() / 1000 < this.tokenExpiry) {
      return this.appToken;
    }
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.appToken}?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        this.log.error(`getAppToken: HTTP ${resp.status}`);
        return null;
      }
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) {
        this.log.error(`getAppToken: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"}`);
        return null;
      }
      this.appToken = data.data?.appToken ?? null;
      const expiresIn = data.data?.expiresIn ?? 7200;
      this.tokenExpiry = Date.now() / 1000 + expiresIn - 300;
      this.log.info(`getAppToken: refreshed (expires in ${expiresIn}s)`);
      return this.appToken;
    } catch (e: any) {
      this.log.error(`getAppToken: ${e.message}`);
      return null;
    }
  }

  async sendText(chatId: string, content: string, reminder?: ReminderParams): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const textData: Record<string, unknown> = { content };
      if (reminder) textData.reminder = reminder;
      const payload = { userIdList: [chatId], msgType: "text", msgData: { text: textData } };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) {
        this.log.error(`sendText: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"}`);
        return { success: false, error: data.errMsg ?? undefined };
      }
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      this.log.error(`sendText: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async sendFormatText(chatId: string, content: string): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const payload = {
        userIdList: [chatId],
        msgType: "formatText",
        msgData: { formatText: { formatType: 1, text: content } },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) {
        this.log.error(`sendFormatText: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"}`);
        return { success: false, error: data.errMsg ?? undefined };
      }
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      this.log.error(`sendFormatText: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async sendTextWithMedia(chatId: string, content: string, mediaType: number, mediaIds: string[], reminder?: ReminderParams): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const textData: Record<string, unknown> = { content, mediaType, mediaIds };
      if (reminder) textData.reminder = reminder;
      const payload = { userIdList: [chatId], msgType: "text", msgData: { text: textData } };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async uploadMedia(filePath: string, mediaType?: number): Promise<{ mediaId: string } | { error: string }> {
    const token = await this.getAppToken();
    if (!token) return { error: "No access token" };
    const mt = mediaType ?? mediaTypeFromPath(filePath);
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.uploadMedia}?type=${mt}&app_token=${token}`;
      const fileContent = await fs.readFile(filePath);
      const filename = path.basename(filePath);
      const form = new FormData();
      form.append("media", new Blob([fileContent]), filename);
      const resp = await fetch(url, { method: "POST", body: form });
      if (!resp.ok) return { error: `Upload HTTP error: ${resp.status}` };
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) return { error: data.errMsg ?? "Upload API error" };
      return { mediaId: data.data?.mediaId ?? "" };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string, mediaType?: number): Promise<ApiResult> {
    const mt = mediaType ?? mediaTypeFromPath(filePath);
    const uploadResult = await this.uploadMedia(filePath, mt);
    if ("error" in uploadResult) return { success: false, error: uploadResult.error };
    return this.sendTextWithMedia(chatId, caption ?? "", mt, [uploadResult.mediaId]);
  }

  async sendImageUrl(chatId: string, imageUrl: string, caption?: string): Promise<ApiResult> {
    try {
      const resp = await fetch(imageUrl);
      if (!resp.ok) return { success: false, error: `Download HTTP error: ${resp.status}` };
      const buffer = Buffer.from(await resp.arrayBuffer());
      const contentType = resp.headers.get("content-type") ?? "";
      const ext = contentType.includes("png") ? ".png" : contentType.includes("gif") ? ".gif" : contentType.includes("webp") ? ".webp" : ".jpg";
      const tmpPath = path.join(os.tmpdir(), `lansenger_url_image_${crypto.randomUUID()}${ext}`);
      await fs.writeFile(tmpPath, buffer);
      const result = await this.sendFile(chatId, tmpPath, caption, 2);
      try { await fs.unlink(tmpPath); } catch {}
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async revokeMessage(messageIds: string[], chatType: string = "bot", senderId?: string): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    if (["staff", "group"].includes(chatType) && !senderId) {
      return { success: false, error: `chat_type='${chatType}' requires sender_id` };
    }
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.revokeMessage}?app_token=${token}`;
      const payload: Record<string, unknown> = { chatType, messageIds };
      if (senderId) payload.senderId = senderId;
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async sendLinkCard(chatId: string, title: string, link: string, options?: LinkCardOptions): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const payload = {
        userIdList: [chatId],
        msgType: "linkCard",
        msgData: {
          linkCard: {
            title,
            link,
            description: options?.description ?? "",
            iconLink: options?.iconLink ?? "",
            pcLink: options?.pcLink ?? "",
            fromName: options?.fromName ?? "",
            fromIconLink: options?.fromIconLink ?? "",
          },
        },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async sendI18nAppCard(chatId: string, cardData: I18nAppCardData): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const payload = {
        userIdList: [chatId],
        msgType: "i18nAppCard",
        msgData: { i18nAppCard: cardData },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async sendAppCard(chatId: string, cardData: AppCardData): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const resolvedCard: AppCardData = { ...cardData };
      if (resolvedCard.isDynamic && !resolvedCard.headStatusInfo) {
        resolvedCard.headStatusInfo = {
          description: '<div style="color:rgba(0,0,0,.47);text-align:left">Active</div>',
          colour: "rgba(0,0,0,.47)",
        };
      }
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const payload = {
        userIdList: [chatId],
        msgType: "appCard",
        msgData: { appCard: resolvedCard },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async sendAppArticles(chatId: string, articles: AppArticle[], options?: ArticleCardOptions): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.privateMessage}?app_token=${token}`;
      const payload = {
        userIdList: [chatId],
        msgType: "appArticles",
        msgData: {
          appArticles: {
            articles: articles.map(a => ({
              title: a.title,
              description: a.description ?? "",
              imgUrl: a.imgUrl,
              url: a.url,
              pcUrl: a.pcUrl ?? "",
            })),
            sourceName: options?.sourceName ?? "",
            sourceIcon: options?.sourceIcon ?? "",
          },
        },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async updateCardStatus(messageId: string, status: "pending" | "approved" | "denied", lang?: "zh" | "en"): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    const detectedLang = lang ?? "zh";
    const statusConfig: Record<string, { zh: string; en: string; color: string }> = {
      pending: { zh: "待审批", en: "Pending", color: "#FFB116" },
      approved: { zh: "已批准", en: "Approved", color: "#198754" },
      denied: { zh: "已拒绝", en: "Denied", color: "#dc3545" },
    };
    const cfg = statusConfig[status] ?? statusConfig["pending"]!;
    const statusText = cfg[detectedLang] ?? cfg.en;
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.dynamicUpdate}?app_token=${token}`;
      const payload = {
        msgId: messageId,
        msgType: "appCard",
        msgData: {
          appCardUpdateMsg: {
            isLastUpdate: status !== "pending",
            headStatusInfo: {
              description: `<div style="color:${cfg.color};text-align:left">${statusText}</div>`,
              colour: cfg.color,
            },
          },
        },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async updateDynamicCard(msgId: string, headStatusInfo?: Record<string, string>, links?: Array<{ title: string; url: string }>, isLastUpdate?: boolean): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.dynamicUpdate}?app_token=${token}`;
      const appCardUpdateMsg: Record<string, unknown> = {};
      if (isLastUpdate) appCardUpdateMsg.isLastUpdate = true;
      if (headStatusInfo) appCardUpdateMsg.headStatusInfo = headStatusInfo;
      if (links) appCardUpdateMsg.links = links;
      const payload = {
        msgId,
        msgType: "appCard",
        msgData: { appCardUpdateMsg },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async queryGroups(pageOffset: number = 1, pageSize: number = 100): Promise<{ totalGroupIds: number; groupIds: string[] } | { error: string }> {
    const token = await this.getAppToken();
    if (!token) return { error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}/v2/groups/fetch?app_token=${token}&page_offset=${pageOffset}&page_size=${pageSize}`;
      const resp = await fetch(url);
      if (!resp.ok) return { error: `HTTP error: ${resp.status}` };
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) return { error: data.errMsg ?? "API error" };
      const result = data.data ?? {};
      return {
        totalGroupIds: (result as any).totalGroupIds ?? 0,
        groupIds: (result as any).groupIds ?? [],
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  async sendGroupText(groupId: string, content: string, reminder?: ReminderParams): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.groupMessage}?app_token=${token}`;
      const textData: Record<string, unknown> = { content };
      if (reminder) textData.reminder = reminder;
      const payload = { groupId, msgType: "text", msgData: { text: textData } };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async sendGroupFormatText(groupId: string, content: string): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.groupMessage}?app_token=${token}`;
      const payload = {
        groupId,
        msgType: "formatText",
        msgData: { formatText: { formatType: 1, text: content } },
      };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  detectLang(text: string): "zh" | "en" {
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
    const ratio = text.length > 0 ? cjkChars / text.length : 0;
    return ratio >= LANG_DETECT_THRESHOLD ? "zh" : "en";
  }

  cacheUserLang(userId: string, text: string): void {
    const lang = this.detectLang(text);
    this.userLangMap.set(userId, lang);
  }

  getUserLang(userId: string): "zh" | "en" {
    return this.userLangMap.get(userId) ?? "zh";
  }

  cacheChatType(chatId: string, chatType: "group" | "dm"): void {
    this.chatTypeMap.set(chatId, chatType);
  }

  getChatType(chatId: string): "group" | "dm" | undefined {
    return this.chatTypeMap.get(chatId);
  }

  isGroupChat(chatId: string): boolean {
    const type = this.chatTypeMap.get(chatId);
    return type === "group" || chatId.startsWith("group:");
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Buffer; ext?: string } | null> {
    const token = await this.getAppToken();
    if (!token) return null;
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.fetchMedia}/${mediaId}/fetch?app_token=${token}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = Buffer.from(await resp.arrayBuffer());
      let ext: string | undefined;
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("png")) ext = ".png";
      else if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = ".jpg";
      else if (contentType.includes("gif")) ext = ".gif";
      else if (contentType.includes("pdf")) ext = ".pdf";
      else if (contentType.includes("mp4")) ext = ".mp4";
      else if (contentType.includes("wav")) ext = ".wav";
      else if (contentType.includes("zip") || contentType.includes("xlsx") || contentType.includes("docx")) ext = ".zip";
      const disposition = resp.headers.get("content-disposition") ?? "";
      const fnameMatch = disposition.match(/filename[^;=\n]*=((['"])(.*?)['"]|([^;\n]*))/);
      if (fnameMatch) {
        const fname = (fnameMatch[3] ?? fnameMatch[4] ?? "").trim();
        if (fname) {
          const dotExt = path.extname(fname).toLowerCase();
          if (dotExt) ext = dotExt;
        }
      }
      return { bytes, ext };
    } catch {
      return null;
    }
  }

  async saveMediaToTemp(mediaBytes: Buffer, mediaKind: string = "file", suggestedExt?: string): Promise<string | null> {
    let ext = suggestedExt ?? detectExtFromBytes(mediaBytes, mediaKind);
    const tmpPath = path.join(os.tmpdir(), `lansenger_${mediaKind}_${crypto.randomUUID()}${ext}`);
    try {
      await fs.writeFile(tmpPath, mediaBytes);
      return tmpPath;
    } catch {
      return null;
    }
  }

  async processRawMessage(raw: string): Promise<InboundEvent[]> {
    let wsMsg: LansengerWsMessage;
    try {
      wsMsg = JSON.parse(raw);
    } catch {
      return [];
    }
    const events = wsMsg.events ?? [];
    const results: InboundEvent[] = [];
    for (const ev of events) {
      const msgData = ev.data ?? {};
      const extracted = await this.extractText(msgData);
      if (!extracted.text) continue;
      if (extracted.mediaPaths?.length) {
        this.log.info(`inbound media: msgType=${msgData.msgType ?? "n/a"} count=${extracted.mediaPaths.length} saved=${extracted.mediaPaths.join(",")}`);
      }
      const messageId = msgData.messageId ?? crypto.randomUUID();
      const chatType = msgData.chatType ?? "p2p";
      const isGroup = chatType === "group";
      const senderId = msgData.from ?? "";
      const chatId = msgData.conversationId ?? senderId;
      
      this.cacheChatType(chatId, isGroup ? "group" : "dm");
      if (extracted.text) this.cacheUserLang(senderId, extracted.text);
      
      results.push({
        messageId,
        text: extracted.text,
        chatId,
        chatName: msgData.conversationTitle ?? undefined,
        isGroup,
        senderId,
        userName: msgData.senderName ?? senderId,
        rawMessage: msgData,
        msgType: msgData.msgType ?? "text",
        mediaPaths: extracted.mediaPaths,
      });
    }
    return results;
  }

  async connect(): Promise<boolean> {
    if (!this.appId || !this.appSecret) {
      this.log.error("connect: missing appId or appSecret");
      return false;
    }
    this.running = true;
    try {
      const wsUrl = await this.getWsUrl();
      if (!wsUrl) {
        this.log.error("connect: failed to obtain WS URL");
        return false;
      }
      this.wsTask = this.runWs(wsUrl);
      return true;
    } catch (e: any) {
      this.log.error(`connect: ${e.message}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.log.info("disconnect: stopping");
    this.running = false;
    this.stopHeartbeat();
    if (this.ws) this.ws.close();
    this.ws = null;
    if (this.wsTask) {
      try { await this.wsTask; } catch {}
      this.wsTask = null;
    }
  }

  private async getWsUrl(): Promise<string | null> {
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.wsEndpoint}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: this.appId, secret: this.appSecret }),
      });
      if (!resp.ok) {
        this.log.error(`getWsUrl: HTTP ${resp.status}`);
        return null;
      }
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) {
        this.log.error(`getWsUrl: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"}`);
        return null;
      }
      return data.data?.wsEndpoint ?? null;
    } catch (e: any) {
      this.log.error(`getWsUrl: ${e.message}`);
      return null;
    }
  }

  private async runWs(wsUrl: string): Promise<void> {
    let currentUrl = wsUrl;
    while (this.running) {
      try {
        const ws = new WebSocket(currentUrl);
        this.ws = ws;
        this.backoffIdx = 0;

        ws.onopen = () => {
          this.log.info("WS connected");
          this.startHeartbeat(ws);
        };

        ws.onmessage = async (ev) => {
          if (typeof ev.data !== "string" || !this.messageHandler) return;
          const events = await this.processRawMessage(ev.data);
          for (const event of events) {
            try { await this.messageHandler(event); } catch (e: any) {
              this.log.error(`messageHandler: ${e.message}`);
            }
          }
        };

        ws.onclose = (ev) => {
          this.log.info(`WS closed (code=${ev.code} reason=${ev.reason})`);
          this.stopHeartbeat();
        };
        ws.onerror = () => {
          this.log.error("WS error");
        };

        await new Promise<void>((resolve) => {
          ws.onclose = () => resolve();
          ws.onerror = () => resolve();
        });

        if (!this.running) return;
      } catch (e: any) {
        this.log.error(`runWs: ${e.message}`);
        if (!this.running) return;
      }

      const delay: number = RECONNECT_BACKOFF[Math.min(this.backoffIdx, RECONNECT_BACKOFF.length - 1)] ?? 60;
      this.log.info(`WS reconnect in ${delay}s (attempt ${this.backoffIdx + 1})`);
      await new Promise((r) => setTimeout(r, delay * 1000));
      this.backoffIdx++;
      const newUrl = await this.getWsUrl();
      if (newUrl) currentUrl = newUrl;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { this.log.error("heartbeat ping failed"); }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async extractText(msgData: Record<string, any>): Promise<{ text: string | null; mediaPaths?: string[] }> {
    const msgType = msgData.msgType ?? "text";
    const payload = msgData.msgData ?? {};

    if (msgType === "text") return { text: payload.text?.content?.trim() ?? null };

    if (msgType === "image") {
      const ids: string[] = payload.image?.mediaIds ?? [];
      const label = ids.length > 1 ? `[Image: ${ids.length} files]` : "[Image]";
      const paths = await this.downloadAllMedia(ids, "image");
      return { text: paths.length > 0 ? label : "[Image]", mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "video") {
      const ids: string[] = payload.video?.mediaIds ?? [];
      const label = ids.length > 1 ? `[Video: ${ids.length} files]` : "[Video]";
      const paths = await this.downloadAllMedia(ids, "video");
      return { text: paths.length > 0 ? label : "[Video]", mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "file") {
      const ids: string[] = payload.file?.mediaIds ?? [];
      const label = ids.length > 1 ? `[File: ${ids.length} files]` : "[File]";
      const paths = await this.downloadAllMedia(ids, "file");
      return { text: paths.length > 0 ? label : "[File]", mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "voice") {
      const ids: string[] = payload.voice?.mediaIds ?? [];
      const paths = await this.downloadAllMedia(ids, "voice");
      return { text: paths.length > 0 ? "[Voice]" : "[Voice]", mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "formatText") return { text: payload.formatText?.text?.trim() ?? null };
    if (msgType === "position") {
      const pos = payload.position ?? {};
      const parts = [pos.name ?? "", pos.address ?? ""].filter(Boolean);
      if (pos.latitude && pos.longitude) parts.push(`${pos.latitude},${pos.longitude}`);
      if (pos.link) parts.push(pos.link);
      return { text: `[Location] ${parts.join(" ")}` };
    }
    if (msgType === "card") return { text: `[Contact Card] ${payload.card?.staffId ?? ""}` };
    if (msgType === "sticker") return { text: `[Sticker] ${payload.sticker?.stickerId ?? ""}` };
    return { text: null };
  }

  private async downloadAllMedia(ids: string[], mediaKind: string): Promise<string[]> {
    const paths: string[] = [];
    for (const id of ids) {
      const download = await this.downloadMedia(id);
      if (download) {
        const ext = download.ext ?? detectExtFromBytes(download.bytes, mediaKind);
        const p = await this.saveMediaToTemp(download.bytes, mediaKind, ext);
        if (p) paths.push(p);
      }
    }
    return paths;
  }

  private async postJson(url: string, payload: unknown): Promise<LansengerApiResponse> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const rawBody = await resp.text();
    if (!resp.ok) return { errCode: -1, errMsg: `HTTP ${resp.status}: ${rawBody.slice(0, 200)}` };
    if (!rawBody || rawBody.trim().length === 0) {
      this.log.error(`postJson: empty body (HTTP ${resp.status}) for ${url.slice(0, 80)}`);
      return { errCode: -1, errMsg: `Empty API response (HTTP ${resp.status})` };
    }
    try {
      return JSON.parse(rawBody) as LansengerApiResponse;
    } catch {
      this.log.error(`postJson: JSON parse error body=${rawBody.slice(0, 200)}`);
      return { errCode: -1, errMsg: `JSON parse error (HTTP ${resp.status}): ${rawBody.slice(0, 100)}` };
    }
  }
}

export type ReminderParams = { all?: boolean; userIds?: string[] };

export type LinkCardOptions = {
  description?: string;
  iconLink?: string;
  pcLink?: string;
  fromName?: string;
  fromIconLink?: string;
};

export type AppCardField = { key: string; value: string };
export type AppCardLink = { title: string; url: string };
export type AppCardButton = { title: string; action: string };
export type HeadStatusInfo = {
  iconLink?: string;
  description: string;
  colour?: string;
};

export type AppCardData = {
  headTitle?: string;
  headIconId?: string;
  headIconUrl?: string;
  isDynamic?: boolean;
  headStatusInfo?: HeadStatusInfo;
  bodyTitle: string;
  bodySubTitle?: string;
  bodyContent?: string;
  signature?: string;
  staffId?: string;
  fields?: AppCardField[];
  links?: AppCardLink[];
  buttons?: AppCardButton[];
  cardLink?: string;
  pcCardLink?: string;
  padCardLink?: string;
};

export type AppCardOptions = {
  isDynamic?: boolean;
  cover?: string;
  link?: string;
  pcLink?: string;
  actionLink?: string;
  actionText?: string;
};

export type AppArticle = {
  title: string;
  description?: string;
  imgUrl: string;
  url: string;
  pcUrl?: string;
};

export type ArticleCardOptions = {
  sourceName?: string;
  sourceIcon?: string;
};

export type InboundEvent = {
  messageId: string;
  text: string;
  chatId: string;
  chatName?: string;
  isGroup: boolean;
  senderId: string;
  userName: string;
  rawMessage: Record<string, any>;
  msgType: string;
  mediaPaths?: string[];
};

export type LansengerApiResponse = {
  errCode: number;
  errMsg?: string;
  data?: {
    appToken?: string;
    expiresIn?: number;
    wsEndpoint?: string;
    msgId?: string;
    mediaId?: string;
  };
};

export type LansengerWsMessage = {
  events?: Array<{ data: Record<string, any> }>;
};

export type I18nObj = { zhHans: string; zhHant: string; zhHantHK: string; en: string; fr: string };

export type I18nAppCardData = {
  i18nHeadTitle: I18nObj;
  headIconId?: string;
  i18nBodyTitle?: I18nObj;
  i18nBodySubTitle?: I18nObj;
  i18nBodyContent?: I18nObj;
  i18nSignature?: I18nObj;
  i18nFields?: Array<{ i18nKey: I18nObj; i18nValue: I18nObj; timestamp: number }>;
  i18nLinks?: Array<unknown>;
  cardLink?: string;
  pcCardLink?: string;
};

export function buildI18n(zhHans: string, zhHant: string, zhHantHK: string, en: string, fr: string): I18nObj {
  return { zhHans, zhHant, zhHantHK, en, fr };
}

export { DEFAULT_API_GATEWAY_URL, MAX_MESSAGE_LENGTH };