import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import WebSocket from "ws";
import { assertHttpUrlTargetsPrivateNetwork, isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-policy";

export type ClientLogger = {
  info: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

const silentLogger: ClientLogger = { info: () => {}, error: () => {}, debug: () => {} };

const DEFAULT_API_GATEWAY_URL = "https://open.e.lanxin.cn/open/apigw";

function convertPxToPt(str: string): string {
  return str.replace(/font-size:\s*(\d+(?:\.\d+)?)px/gi, (_match, num) => {
    const pt = Math.max(12, Math.min(36, Math.round(parseFloat(num) * 0.75)));
    return `font-size:${pt}pt`;
  });
}

const PX_TO_PT_FIELDS = new Set([
  "bodyTitle", "bodyContent", "bodySubTitle", "headTitle", "signature",
  "description", "value", "title",
]);

function convertPxToPtCard(card: AppCardData): AppCardData {
  const result = { ...card };
  for (const key of PX_TO_PT_FIELDS) {
    if (typeof result[key as keyof AppCardData] === "string") {
      (result as any)[key] = convertPxToPt(result[key as keyof AppCardData] as string);
    }
  }
  if (result.headStatusInfo?.description) {
    result.headStatusInfo = { ...result.headStatusInfo, description: convertPxToPt(result.headStatusInfo.description) };
  }
  if (result.fields?.length) {
    result.fields = result.fields.map((f) => ({ ...f, value: convertPxToPt(f.value) }));
  }
  if (result.buttons?.length) {
    result.buttons = result.buttons.map((b) => ({ ...b, title: convertPxToPt(b.title) }));
  }
  return result;
}
const RECONNECT_BACKOFF = [2, 5, 10, 30, 60];
/** Default heartbeat interval when API does not return pingInterval */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 15_000;
/** How long to wait for graceful close to complete before forcing terminate */
const CLOSE_FALLBACK_MS = 5_000;
const CHINESE_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

const API_ENDPOINTS = {
  appToken: "/v1/apptoken/create",
  wsEndpoint: "/v1/ws/endpoint/create",
  privateMessage: "/v1/bot/messages/create",
  groupMessage: "/v1/messages/group/create",
  uploadMedia: "/v1/app/medias/create",
  fetchMedia: "/v1/medias",
  revokeMessage: "/v1/messages/revoke",
  dynamicUpdate: "/v1/messages/dynamic/update",
  commandsCreate: "/v1/bot/commands/create",
  commandsFetch: "/v1/bot/commands/fetch",
  commandsDelete: "/v1/bot/commands/delete",
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

export function uploadMediaTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".amr"].includes(ext)) return "audio";
  return "file";
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
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongAt = 0;
  private messageHandler: ((event: InboundEvent) => Promise<void>) | null = null;
  private onWsOpen: (() => void) | null = null;
  private onWsClose: (() => void) | null = null;
  private log: ClientLogger;
  ownerId = "";
  private userLangMap = new Map<string, "zh" | "en">();
  private dangerouslyAllowPrivateNetwork: boolean = false;
  private groupInfoCache = new Map<string, { data: GroupInfoData; expiry: number }>();
  private groupMembersCache = new Map<string, { data: GroupMembersData; expiry: number }>();
  private readonly GROUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: { appId: string; appSecret: string; apiGatewayUrl?: string; logger?: ClientLogger; dangerouslyAllowPrivateNetwork?: boolean | null }) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.apiGatewayUrl = config.apiGatewayUrl ?? DEFAULT_API_GATEWAY_URL;
    this.log = config.logger ?? silentLogger;
    this.dangerouslyAllowPrivateNetwork = config.dangerouslyAllowPrivateNetwork ?? false;
  }

  setMessageHandler(handler: (event: InboundEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  setWsLifecycleCallbacks(callbacks: { onOpen?: () => void; onClose?: () => void }): void {
    this.onWsOpen = callbacks.onOpen ?? null;
    this.onWsClose = callbacks.onClose ?? null;
  }

  isWsAlive(): boolean {
    if (!this.ws) return false;
    if (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING) {
      return false;
    }
    // Detect zombie connections: if we haven't received a pong for too long
    // (e.g. after machine sleep), the TCP is dead even though readyState is OPEN.
    if (this.lastPongAt > 0) {
      const staleMs = Date.now() - this.lastPongAt;
      const threshold = 2 * this.heartbeatIntervalMs + PONG_TIMEOUT_MS;
      if (staleMs > threshold) {
        this.log.info(
          `isWsAlive: zombie detected — last pong ${Math.round(staleMs / 1000)}s ago (threshold=${threshold / 1000}s)`,
        );
        return false;
      }
    }
    return true;
  }

  wsState(): string {
    if (!this.ws) return "NULL";
    const states = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    return states[this.ws.readyState] ?? `UNKNOWN(${this.ws.readyState})`;
  }

  // ══════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════

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

  // ══════════════════════════════════════════════
  // TEXT MESSAGING
  // ══════════════════════════════════════════════

  async sendText(chatId: string, content: string, opts?: { reminder?: ReminderParams; refMsgId?: string }): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const { url, wrap } = this.msgTarget(chatId);
      const textData: Record<string, unknown> = { content };
      if (opts?.reminder) textData.reminder = opts.reminder;
      const payload = wrap({ text: textData, msgType: "text" });
      if (opts?.refMsgId) payload.refMsgId = opts.refMsgId;
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
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

  async sendFormatText(chatId: string, content: string, opts?: { reminder?: ReminderParams; refMsgId?: string }): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const { url, wrap } = this.msgTarget(chatId);
      const fmtData: Record<string, unknown> = { formatType: 1, text: content };
      if (opts?.reminder) fmtData.reminder = opts.reminder;
      const payload = wrap({ formatText: fmtData, msgType: "formatText" });
      if (opts?.refMsgId) payload.refMsgId = opts.refMsgId;
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
      if (data.errCode !== 0 && opts?.reminder) {
        this.log.info(`sendFormatText with reminder failed (${data.errMsg ?? "unknown"}), retrying without reminder`);
        const retryPayload = wrap({ formatText: { formatType: 1, text: content }, msgType: "formatText" });
        if (opts?.refMsgId) retryPayload.refMsgId = opts.refMsgId;
        const retryData = await this.postJson(`${url}?app_token=${token}`, retryPayload);
        if (retryData.errCode !== 0) {
          this.log.error(`sendFormatText: errCode=${retryData.errCode} errMsg=${retryData.errMsg ?? "n/a"}`);
          return { success: false, error: retryData.errMsg ?? undefined };
        }
        return { success: true, messageId: retryData.data?.msgId ?? undefined, rawResponse: retryData };
      }
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
      const { url, wrap } = this.msgTarget(chatId);
      const textData: Record<string, unknown> = { content, mediaType, mediaIds };
      if (reminder) textData.reminder = reminder;
      const payload = wrap({ text: textData, msgType: "text" });
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // ══════════════════════════════════════════════
  // MEDIA UPLOAD
  // ══════════════════════════════════════════════

  async uploadMedia(filePath: string, uploadType?: string, originalName?: string, videoWidth?: number, videoHeight?: number, videoDuration?: number): Promise<{ mediaId: string } | { error: string }> {
    const token = await this.getAppToken();
    if (!token) return { error: "No access token" };
    const typeStr = uploadType ?? uploadMediaTypeFromPath(filePath);
    try {
      let url = `${this.apiGatewayUrl}${API_ENDPOINTS.uploadMedia}?type=${typeStr}&app_token=${token}`;
      if (typeStr === "video") {
        if (videoWidth) url += `&width=${videoWidth}`;
        if (videoHeight) url += `&height=${videoHeight}`;
        if (videoDuration) url += `&duration=${videoDuration}`;
      }
      const fileContent = await fs.readFile(filePath);
      const filename = originalName ?? path.basename(filePath);
      this.log.debug(`uploadMedia: filePath=${filePath} uploadType=${typeStr} originalName=${originalName ?? "n/a"} filename=${filename}`);
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

  // ══════════════════════════════════════════════
  // FILE SENDING
  // ══════════════════════════════════════════════

  async sendFile(chatId: string, filePath: string, caption?: string, mediaType?: number, originalName?: string, coverImagePath?: string, videoWidth?: number, videoHeight?: number, videoDuration?: number): Promise<ApiResult> {
    const mt = mediaType ?? mediaTypeFromPath(filePath);
    const uploadType = uploadMediaTypeFromPath(filePath);

    if (mt === 1 && uploadType === "video") {
      if (!coverImagePath) return { success: false, error: "Video messages require a cover image (coverImagePath). Use ffmpeg or similar tool to extract a frame, then provide the image path." };
      if (!videoWidth || !videoHeight) return { success: false, error: "Video uploads require width and height (videoWidth, videoHeight). Use ffprobe or similar tool to obtain these values." };
    }

    const uploadResult = await this.uploadMedia(filePath, uploadType, originalName, mt === 1 ? videoWidth : undefined, mt === 1 ? videoHeight : undefined, mt === 1 ? videoDuration : undefined);
    if ("error" in uploadResult) return { success: false, error: uploadResult.error };

    if (mt === 1 && coverImagePath) {
      const coverResult = await this.uploadMedia(coverImagePath, "image");
      if ("error" in coverResult) {
        return { success: false, error: `Video cover image upload failed: ${coverResult.error}` };
      }
      return this.sendTextWithMedia(chatId, caption ?? "", mt, [uploadResult.mediaId, coverResult.mediaId]);
    }

    return this.sendTextWithMedia(chatId, caption ?? "", mt, [uploadResult.mediaId]);
  }

  async sendImageUrl(chatId: string, imageUrl: string, caption?: string, dangerouslyAllowPrivateNetwork?: boolean | null): Promise<ApiResult> {
    try {
      await assertHttpUrlTargetsPrivateNetwork(imageUrl, {
        dangerouslyAllowPrivateNetwork: dangerouslyAllowPrivateNetwork ?? false,
        errorMessage: `Image URL targets a private/internal network, which is blocked by SSRF protection. Set dangerouslyAllowPrivateNetwork: true in lansenger config to allow private network image URLs.`,
      });
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        const ct = resp.headers.get("content-type") ?? "";
        if (resp.status === 404) return { success: false, error: `Image URL not found (HTTP 404): ${imageUrl}` };
        if (resp.status >= 500) return { success: false, error: `Image server error (HTTP ${resp.status}): ${imageUrl}` };
        return { success: false, error: `Download HTTP error: ${resp.status} (content-type: ${ct}): ${imageUrl}` };
      }
      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/") && !contentType.includes("octet-stream")) {
        return { success: false, error: `URL returned non-image content (content-type: ${contentType}): ${imageUrl}` };
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const ext = contentType.includes("png") ? ".png" : contentType.includes("gif") ? ".gif" : contentType.includes("webp") ? ".webp" : ".jpg";
      const tmpPath = path.join(os.tmpdir(), `lansenger_url_image_${crypto.randomUUID()}${ext}`);
      await fs.writeFile(tmpPath, buffer);
      const result = await this.sendFile(chatId, tmpPath, caption, 2);
      try { await fs.unlink(tmpPath); } catch {}
      return result;
    } catch (e: any) {
      const msg = e.message ?? String(e);
      if (e.name === "AbortError" || msg.includes("timeout")) return { success: false, error: `Image URL unreachable (timeout after 15s): ${imageUrl}` };
      return { success: false, error: `Failed to fetch image URL: ${msg}` };
    }
  }

  // ══════════════════════════════════════════════
  // MESSAGE MANAGEMENT
  // ══════════════════════════════════════════════

  async revokeMessage(messageIds: string[], chatType: string = "bot", senderId?: string): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    if (!["bot", "group"].includes(chatType)) {
      return { success: false, error: `chatType must be 'bot' or 'group' (got '${chatType}')` };
    }
    // NOTE: senderId validation relaxed — the Lansenger API accepts group
    // revokes without senderId (defaults to the authenticated caller).
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

  // ══════════════════════════════════════════════
  // CARDS
  // ══════════════════════════════════════════════

  async sendLinkCard(chatId: string, title: string, link: string, options?: LinkCardOptions): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const { url, wrap } = this.msgTarget(chatId);
      const payload = wrap({
        linkCard: {
          title,
          link,
          description: options?.description ?? "",
          iconLink: options?.iconLink ?? "",
          pcLink: options?.pcLink ?? "",
          fromName: options?.fromName ?? "",
          fromIconLink: options?.fromIconLink ?? "",
        },
        msgType: "linkCard",
      });
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
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
      const { url, wrap } = this.msgTarget(chatId);
      const payload = wrap({ i18nAppCard: cardData, msgType: "i18nAppCard" });
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async sendApproveCard(chatId: string, cardData: ApproveCardData): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const { url, wrap } = this.msgTarget(chatId);
      const payload = wrap({ approveCard: cardData, msgType: "approveCard" });
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
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
      const resolvedCard: AppCardData = convertPxToPtCard(cardData);
      if (resolvedCard.isDynamic && !resolvedCard.headStatusInfo) {
        resolvedCard.headStatusInfo = {
          description: '<div style="color:rgba(0,0,0,.47);text-align:left">Active</div>',
          colour: "rgba(0,0,0,.47)",
        };
      }
      const { url, wrap } = this.msgTarget(chatId);
      const payload = wrap({ appCard: resolvedCard, msgType: "appCard" });
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
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
      const { url, wrap } = this.msgTarget(chatId);
      const payload = wrap({
        appArticles: articles.map(a => ({
          imgUrl: a.imgUrl,
          title: a.title,
          summary: a.summary ?? "",
          url: a.url,
          pcUrl: a.pcUrl ?? "",
          padUrl: a.padUrl ?? "",
        })),
        msgType: "appArticles",
      });
      const data = await this.postJson(`${url}?app_token=${token}`, payload);
      if (data.errCode !== 0) return { success: false, error: data.errMsg ?? undefined };
      return { success: true, messageId: data.data?.msgId ?? undefined, rawResponse: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async updateCardStatus(messageId: string, status: "pending" | "approved" | "denied", lang?: "zh" | "en", strategyKind?: "allow-once" | "allow-session" | "allow-always" | "deny" | "expired", resolvedButtonTheme?: number): Promise<ApiResult> {
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
    const isZh = detectedLang === "zh";
    const resolved = status === "approved" || status === "denied";

    const strategyLabels: Record<string, { zh: string; en: string }> = {
      "allow-once": { zh: "已允许执行一次", en: "Allow Once" },
      "allow-session": { zh: "已允许本会话有效", en: "Allow Session" },
      "allow-always": { zh: "已永久允许", en: "Always Allow" },
      "deny": { zh: "已拒绝执行", en: "Denied" },
      "expired": { zh: "已超时拒绝", en: "Expired" },
    };
    const strategyCfg = strategyLabels[strategyKind ?? "deny"] ?? strategyLabels["deny"]!;

    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.dynamicUpdate}?app_token=${token}`;
      const payload = {
        msgId: messageId,
        msgType: "approveCard",
        msgData: {
          approveCardUpdateMsg: {
            headStatus: {
              describe: statusText,
              colour: cfg.color,
              statusIcon: 1,
            },
            ...(resolved ? {
              buttons: [
                { text: isZh ? strategyCfg.zh : strategyCfg.en, buttonTheme: resolvedButtonTheme ?? 2, state: 1 },
              ],
            } : {}),
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

  // ══════════════════════════════════════════════
  // BOT COMMANDS
  // ══════════════════════════════════════════════

  /**
   * Create bot Commands on Lansenger.
   * scopeType: 4=all private chats, 5=all groups, 7=global default.
   */
  async createCommands(scopeType: number, commands: LansengerCommand[]): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.commandsCreate}?app_token=${token}`;
      const payload = { scopeType, commands };
      const data = await this.postJson(url, payload);
      if (data.errCode !== 0) {
        this.log.error(`createCommands: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"} scopeType=${scopeType}`);
        return { success: false, error: data.errMsg ?? undefined };
      }
      this.log.info(`createCommands: registered ${commands.length} command(s) scopeType=${scopeType}`);
      return { success: true };
    } catch (e: any) {
      this.log.error(`createCommands: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async deleteCommands(scopeType: number): Promise<ApiResult> {
    const token = await this.getAppToken();
    if (!token) return { success: false, error: "No access token" };
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.commandsDelete}?app_token=${token}`;
      const data = await this.postJson(url, { scopeType });
      if (data.errCode !== 0) {
        this.log.error(`deleteCommands: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"} scopeType=${scopeType}`);
        return { success: false, error: data.errMsg ?? undefined };
      }
      this.log.info(`deleteCommands: cleared commands scopeType=${scopeType}`);
      return { success: true };
    } catch (e: any) {
      this.log.error(`deleteCommands: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async fetchCommands(scopeType: number): Promise<LansengerCommand[] | null> {
    const token = await this.getAppToken();
    if (!token) return null;
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.commandsFetch}?app_token=${token}`;
      const data = await this.postJson(url, { scopeType });
      if (data.errCode !== 0) {
        this.log.error(`fetchCommands: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"} scopeType=${scopeType}`);
        return null;
      }
      const rawCommands: Array<Record<string, unknown>> = data.data?.commands ?? [];
      return rawCommands.map((cmd) => {
        const { description_i18n, ...rest } = cmd;
        return {
          ...rest,
          ...(description_i18n ? { i18nDescription: description_i18n } : {}),
        } as LansengerCommand;
      });
    } catch (e: any) {
      this.log.error(`fetchCommands: ${e.message}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════
  // DYNAMIC CARD
  // ══════════════════════════════════════════════

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

  async queryGroups(pageOffset: number = 0, pageSize: number = 100): Promise<{ totalGroupIds: number; groupIds: string[] } | { error: string }> {
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

  // ══════════════════════════════════════════════
  // GROUP QUERIES
  // ══════════════════════════════════════════════

  async getGroupInfo(groupId: string): Promise<GroupInfoData | null> {
    const cached = this.groupInfoCache.get(groupId);
    if (cached && Date.now() < cached.expiry) return cached.data;

    const token = await this.getAppToken();
    if (!token) return null;
    try {
      const url = `${this.apiGatewayUrl}/v2/groups/${encodeURIComponent(groupId)}/info/fetch?app_token=${token}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) {
        this.log.error(`getGroupInfo: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"} groupId=${groupId}`);
        return null;
      }
      const info = (data.data ?? {}) as unknown as GroupInfoData;
      this.groupInfoCache.set(groupId, { data: info, expiry: Date.now() + this.GROUP_CACHE_TTL_MS });
      return info;
    } catch (e: any) {
      this.log.error(`getGroupInfo: ${e.message}`);
      return null;
    }
  }

  async getGroupMembers(groupId: string, pageOffset: number = 0, pageSize?: number): Promise<GroupMembersData | null> {
    const token = await this.getAppToken();
    if (!token) return null;
    try {
      let url = `${this.apiGatewayUrl}/v2/groups/${encodeURIComponent(groupId)}/members/fetch?app_token=${token}&page_offset=${pageOffset}`;
      if (pageSize !== undefined) url += `&page_size=${pageSize}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) {
        this.log.error(`getGroupMembers: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"} groupId=${groupId}`);
        return null;
      }
      const membersData = (data.data ?? {}) as unknown as GroupMembersData;
      // Cache only when fetching full list (no pagination offset, no pageSize limit)
      if (pageOffset === 0 && pageSize === undefined && membersData.totalMembers <= 100) {
        this.groupMembersCache.set(groupId, { data: membersData, expiry: Date.now() + this.GROUP_CACHE_TTL_MS });
      }
      return membersData;
    } catch (e: any) {
      this.log.error(`getGroupMembers: ${e.message}`);
      return null;
    }
  }

  async checkMembership(groupId: string, staffId?: string): Promise<boolean | null> {
    const token = await this.getAppToken();
    if (!token) return null;
    try {
      let url = `${this.apiGatewayUrl}/v2/groups/${encodeURIComponent(groupId)}/members/is_in_group?app_token=${token}`;
      if (staffId) url += `&staff_id=${encodeURIComponent(staffId)}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = (await resp.json()) as LansengerApiResponse;
      if (data.errCode !== 0) {
        this.log.error(`checkMembership: errCode=${data.errCode} errMsg=${data.errMsg ?? "n/a"} groupId=${groupId}`);
        return null;
      }
      return (data.data as any)?.isInGroup === true;
    } catch (e: any) {
      this.log.error(`checkMembership: ${e.message}`);
      return null;
    }
  }

  /**
   * Get group info + members for session metadata injection.
   * Uses TTL cache. For groups with > 100 members, only returns info + count (no member list).
   */
  async getGroupSessionMeta(groupId: string): Promise<GroupSessionMeta> {
    const groupInfo = await this.getGroupInfo(groupId);

    // Check member cache first
    const memberCached = this.groupMembersCache.get(groupId);
    if (memberCached && Date.now() < memberCached.expiry) {
      return {
        groupInfo,
        members: memberCached.data.members,
        memberCount: memberCached.data.totalMembers,
      };
    }

    // If we have groupInfo, check member count to decide strategy
    if (groupInfo && groupInfo.totalMembers > 100) {
      return { groupInfo, members: null, memberCount: groupInfo.totalMembers };
    }

    // Fetch full member list (no pageSize = all)
    const membersData = await this.getGroupMembers(groupId);
    return {
      groupInfo,
      members: membersData?.members ?? null,
      memberCount: membersData?.totalMembers ?? groupInfo?.totalMembers ?? 0,
    };
  }

  // ══════════════════════════════════════════════
  // LANGUAGE
  // ══════════════════════════════════════════════

  detectLang(text: string): "zh" | "en" {
    return CHINESE_RE.test(text) ? "zh" : "en";
  }

  cacheUserLang(userId: string, text: string): void {
    const lang = this.detectLang(text);
    this.userLangMap.set(userId, lang);
  }

  getUserLang(userId: string): "zh" | "en" {
    return this.userLangMap.get(userId) ?? "zh";
  }

  isGroupChat(chatId: string): boolean {
    if (this.ownerId) return chatId !== this.ownerId;
    return chatId.startsWith("group:");
  }

  // ══════════════════════════════════════════════
  // MEDIA DOWNLOAD
  // ══════════════════════════════════════════════

  async downloadMedia(mediaId: string): Promise<{ bytes: Buffer; ext?: string; fname?: string } | null> {
    const token = await this.getAppToken();
    if (!token) return null;
    try {
      const url = `${this.apiGatewayUrl}${API_ENDPOINTS.fetchMedia}/${mediaId}/fetch?app_token=${token}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = Buffer.from(await resp.arrayBuffer());
      let ext: string | undefined;
      let fname: string | undefined;
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
        fname = (fnameMatch[3] ?? fnameMatch[4] ?? "").trim();
        if (fname) {
          // Fix UTF-8 bytes misinterpreted as latin1 by fetch header parser
          const reEncoded = Buffer.from(fname, "latin1").toString("utf-8");
          if (reEncoded !== fname) fname = reEncoded;
          const dotExt = path.extname(fname).toLowerCase();
          if (dotExt) ext = dotExt;
        }
      }
      return { bytes, ext, fname: fname || undefined };
    } catch {
      return null;
    }
  }

  async saveMediaToTemp(mediaBytes: Buffer, mediaKind: string = "file", suggestedExt?: string, origFname?: string): Promise<string | null> {
    let ext = suggestedExt ?? detectExtFromBytes(mediaBytes, mediaKind);
    const uuid = crypto.randomUUID().slice(0, 8);
    // Strip extension from origFname to avoid double suffix (fname already has ext, and we append it below)
    const namePart = origFname ? `_${path.parse(origFname).name}` : "";
    const tmpPath = path.join(os.tmpdir(), `lansenger_${mediaKind}_${uuid}${namePart}${ext}`);
    try {
      await fs.writeFile(tmpPath, mediaBytes);
      return tmpPath;
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════
  // MESSAGE PROCESSING
  // ══════════════════════════════════════════════

  async processRawMessage(raw: string): Promise<InboundEvent[]> {
    let wsMsg: LansengerWsMessage;
    try {
      wsMsg = JSON.parse(raw);
    } catch {
      return [];
    }
    this.log.debug(`processRawMessage: raw body — ${raw}`);

    const results: InboundEvent[] = [];

    // Handle approve_card_callback at top level (not inside events array)
    const rawObj = wsMsg as Record<string, any>;
    if (rawObj.type === "approve_card_callback") {
      const callbackData = rawObj.data as Record<string, any> | undefined;
      const callbackEventData = callbackData?.eventData as string | undefined;
      const callbackStaffId = callbackData?.staffId as string | undefined;
      this.log.info(`processRawMessage: approve_card_callback — eventData="${callbackEventData ?? "MISSING"}" staffId=${callbackStaffId ?? "MISSING"}`);
      if (callbackEventData) {
        results.push({
          messageId: crypto.randomUUID(),
          text: "",
          chatId: "",
          isGroup: false,
          senderId: callbackStaffId ?? "",
          userName: callbackStaffId ?? "",
          rawMessage: callbackData ?? {},
          msgType: "approve_card_callback",
          eventType: "approve_card_callback",
          approveCardCallback: {
            eventData: callbackEventData,
            staffId: callbackStaffId ?? "",
          },
        });
      }
      return results;
    }

    const events = wsMsg.events ?? [];
    for (const ev of events) {
      const eventData = ev.data ?? {};
      const eventType = ev.type ?? "";

      // Handle approve_card_callback events (button clicks)
      if (ev.type === "approve_card_callback" || eventType === "approve_card_callback") {
        const callbackEventData = eventData.eventData as string | undefined;
        const callbackStaffId = eventData.staffId as string | undefined;
        if (callbackEventData) {
          results.push({
            messageId: crypto.randomUUID(),
            text: "",
            chatId: "",
            isGroup: false,
            senderId: callbackStaffId ?? "",
            userName: callbackStaffId ?? "",
            rawMessage: eventData,
            msgType: "approve_card_callback",
            eventType: "approve_card_callback",
            approveCardCallback: {
              eventData: callbackEventData,
              staffId: callbackStaffId ?? "",
            },
          });
        }
        continue;
      }

      const extracted = await this.extractText(eventData);
      if (!extracted.text) {
        this.log.info(`inbound: unknown msgType skipped — msgType=${eventData.msgType ?? "n/a"} sender=${eventData.from ?? "n/a"} eventType=${eventType} rawKeys=${Object.keys(eventData).slice(0, 10).join(",")}`);
        continue;
      }
      if (extracted.mediaPaths?.length) {
        this.log.debug(`inbound media: msgType=${eventData.msgType ?? "n/a"} count=${extracted.mediaPaths.length}`);
      }
      const messageId = eventData.messageId ?? eventData.msgId ?? crypto.randomUUID();
      const chatType = eventData.chatType ?? "p2p";
      const isGroup = chatType === "group" || eventType === "bot_group_message";
      const senderId = eventData.from ?? "";
      const chatId = eventData.groupId ?? eventData.conversationId ?? senderId;
      
      if (extracted.text) this.cacheUserLang(senderId, extracted.text);

      const referenceMsg: ReferenceMsg | undefined = eventData.referenceMsg
        ? this.parseReferenceMsg(eventData.referenceMsg)
        : undefined;

      results.push({
        messageId,
        text: extracted.text,
        chatId,
        chatName: eventData.conversationTitle ?? eventData.groupName ?? undefined,
        isGroup,
        senderId,
        userName: eventData.senderName ?? senderId,
        rawMessage: eventData,
        msgType: eventData.msgType ?? "text",
        mediaPaths: extracted.mediaPaths,
        eventType,
        referenceMsg,
        isAtMe: eventData.reminder?.isAtMe ?? false,
        isAtAll: eventData.reminder?.isAtAll ?? false,
        mentionedBots: eventData.reminder?.bots as Array<{ botId: string; botName: string }> | undefined,
        mentionedStaffs: eventData.reminder?.staffs as Array<{ staffId?: string; staffName?: string }> | undefined,
        fromType: eventData.fromType ?? undefined,
        groupName: eventData.groupName ?? undefined,
        botCreator: eventData.botCreator ?? undefined,
        botId: eventData.botId ?? undefined,
      });
    }
    if (results.length === 0 && (rawObj.type || rawObj.eventType || (rawObj.events && rawObj.events.length > 0))) {
      this.log.info(`processRawMessage: no results — type=${rawObj.type ?? "n/a"} eventType=${rawObj.eventType ?? "n/a"} eventsCount=${rawObj.events?.length ?? 0}`);
    }
    return results;
  }

  // ══════════════════════════════════════════════
  // WEBSOCKET LIFECYCLE
  // ══════════════════════════════════════════════

  async connect(): Promise<boolean> {
    if (!this.appId || !this.appSecret) {
      this.log.error("connect: missing appId or appSecret");
      return false;
    }
    this.running = true;
    this.log.info("connect: obtaining WS endpoint URL...");
    try {
      const result = await this.getWsUrl();
      if (!result) {
        this.log.error("connect: failed to obtain WS URL");
        return false;
      }
      this.heartbeatIntervalMs = result.pingInterval;
      this.log.info(`connect: got WS URL, starting connection (pingInterval=${this.heartbeatIntervalMs}ms)...`);
      this.wsTask = this.runWs(result.wsEndpoint);
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

  private async getWsUrl(): Promise<{ wsEndpoint: string; pingInterval: number } | null> {
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
      const wsEndpoint = data.data?.wsEndpoint;
      if (!wsEndpoint) return null;
      // API returns pingInterval in seconds, convert to ms
      const pingInterval = data.data?.pingInterval != null
        ? data.data.pingInterval * 1000
        : DEFAULT_HEARTBEAT_INTERVAL_MS;
      return { wsEndpoint, pingInterval };
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

        ws.onopen = () => {
          this.backoffIdx = 0;
          this.log.info(`WS connected (url=${currentUrl.slice(0, 60)}...)`);
          this.startHeartbeat(ws);
          this.onWsOpen?.();
        };

        ws.onmessage = async (ev) => {
          const rawData: string = typeof ev.data === "string" ? ev.data : Buffer.isBuffer(ev.data) ? ev.data.toString("utf-8") : "";
          if (!rawData) {
            this.log.info(`WS onmessage: skipped non-text message (typeof=${typeof ev.data})`);
            return;
          }
          if (!this.messageHandler) return;
          const events = await this.processRawMessage(rawData);
          for (const event of events) {
            try { await this.messageHandler(event); } catch (e: any) {
              this.log.error(`messageHandler: ${e.message}`);
            }
          }
        };

        ws.on("pong", () => {
          this.lastPongAt = Date.now();
          this.clearPongTimeout();
        });

        let resolveClose: (() => void) | null = null;
        const closePromise = new Promise<void>((r) => { resolveClose = r; });

        ws.onclose = (ev) => {
          this.log.info(`WS closed (code=${ev.code} reason=${ev.reason || "none"} wasClean=${ev.wasClean})`);
          this.stopHeartbeat();
          this.clearPongTimeout();
          this.onWsClose?.();
          resolveClose?.();
        };
        ws.onerror = (ev) => {
          const errMsg = (ev as any)?.message ?? (ev as any)?.error?.message ?? "unknown";
          this.log.error(`WS error: ${errMsg}`);
          this.stopHeartbeat();
          this.clearPongTimeout();
          resolveClose?.();
        };

        await closePromise;

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
      if (newUrl) {
        currentUrl = newUrl.wsEndpoint;
        this.heartbeatIntervalMs = newUrl.pingInterval;
      }
    }
  }

  // ══════════════════════════════════════════════
  // HEARTBEAT
  // ══════════════════════════════════════════════

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.clearPongTimeout();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          this.pongTimeoutTimer = setTimeout(() => {
            if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS && ws.readyState === WebSocket.OPEN) {
              this.log.error("pong timeout — gracefully closing zombie connection");
              ws.close();
              // Fallback: force terminate if graceful close doesn't complete in time
              setTimeout(() => {
                if (ws.readyState !== WebSocket.CLOSED) {
                  this.log.error("graceful close timed out — forcing terminate");
                  try { ws.terminate(); } catch {}
                }
              }, CLOSE_FALLBACK_MS);
            }
          }, PONG_TIMEOUT_MS);
        } catch {
          this.log.error("heartbeat ping failed");
        }
      } else if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        this.log.error(`heartbeat: WS no longer open (state=${this.wsState()}) — forcing close to trigger reconnect`);
        this.stopHeartbeat();
        this.clearPongTimeout();
        try { ws.terminate(); } catch {}
      }
    }, this.heartbeatIntervalMs);
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimeout();
  }

  // ══════════════════════════════════════════════
  // MESSAGE ROUTING (private)
  // ══════════════════════════════════════════════

  private msgTarget(chatId: string): { url: string; wrap: (msgData: Record<string, unknown>) => Record<string, unknown> } {
    const isGroup = this.isGroupChat(chatId);
    const endpoint = isGroup ? API_ENDPOINTS.groupMessage : API_ENDPOINTS.privateMessage;
    const url = `${this.apiGatewayUrl}${endpoint}`;
    if (isGroup) {
      return { url, wrap: (msgData) => {
        const mt = msgData.msgType ?? "text";
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(msgData)) { if (k !== "msgType") data[k] = v; }
        return { groupId: chatId, msgType: mt, msgData: data };
      } };
    }
    return { url, wrap: (msgData) => {
      const mt = msgData.msgType ?? "text";
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(msgData)) { if (k !== "msgType") data[k] = v; }
      return { userIdList: [chatId], msgType: mt, msgData: data };
    } };
  }

  // ══════════════════════════════════════════════
  // TEXT EXTRACTION (private)
  // ══════════════════════════════════════════════

  private async extractText(eventData: Record<string, any>): Promise<{ text: string | null; mediaPaths?: string[] }> {
    const msgType = eventData.msgType ?? "text";
    const payload = eventData.msgData ?? {};

    if (msgType === "text") return { text: payload.text?.content?.trim() ?? null };

    if (msgType === "image") {
      const ids: string[] = payload.image?.mediaIds ?? [];
      const caption = payload.image?.content?.trim() ?? "";
      const idPart = ids.length > 0 ? `: ${ids.length === 1 ? ids[0]! : `${ids.length} files: ${ids.join(", ")}`}` : "";
      const label = `[Image${idPart}]${caption ? ` ${caption}` : ""}`;
      const paths = await this.downloadAllMedia(ids, "image");
      return { text: label, mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "video") {
      const ids: string[] = payload.video?.mediaIds ?? [];
      const caption = payload.video?.content?.trim() ?? "";
      const idPart = ids.length > 0 ? `: ${ids.length === 1 ? ids[0]! : ids.join(", ")}` : "";
      const videoPaths: string[] = [];
      if (ids.length >= 1) {
        const vPaths = await this.downloadAllMedia(ids.slice(0, 1), "video");
        videoPaths.push(...vPaths);
      }
      if (ids.length >= 2) {
        const cPaths = await this.downloadAllMedia(ids.slice(1), "image");
        videoPaths.push(...cPaths);
      }
      const label = `[Video${idPart}]${caption ? ` ${caption}` : ""}`;
      return { text: label, mediaPaths: videoPaths.length > 0 ? videoPaths : undefined };
    }
    if (msgType === "file") {
      const ids: string[] = payload.file?.mediaIds ?? [];
      const caption = payload.file?.content?.trim() ?? "";
      const idPart = ids.length > 0 ? `: ${ids.length === 1 ? ids[0]! : `${ids.length} files: ${ids.join(", ")}`}` : "";
      const label = `[File${idPart}]${caption ? ` ${caption}` : ""}`;
      const paths = await this.downloadAllMedia(ids, "file");
      return { text: label, mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "voice") {
      const ids: string[] = payload.voice?.mediaIds ?? [];
      const caption = payload.voice?.content?.trim() ?? "";
      const idPart = ids.length > 0 ? `: ${ids.length === 1 ? ids[0]! : `${ids.length} files: ${ids.join(", ")}`}` : "";
      const paths = await this.downloadAllMedia(ids, "voice");
      const label = `[Voice${idPart}]${caption ? ` ${caption}` : ""}`;
      return { text: label, mediaPaths: paths.length > 0 ? paths : undefined };
    }
    if (msgType === "formatText") return { text: payload.formatText?.text?.trim() ?? null };
    if (msgType === "format") return { text: payload.format?.text?.trim() ?? payload.format?.content?.trim() ?? null };
    if (msgType === "position") {
      const pos = payload.position ?? {};
      const parts = [pos.name ?? "", pos.address ?? ""].filter(Boolean);
      if (pos.latitude && pos.longitude) parts.push(`${pos.latitude},${pos.longitude}`);
      if (pos.link) parts.push(pos.link);
      return { text: `[Location] ${parts.join(" ")}` };
    }
    if (msgType === "card") return { text: `[Contact Card] ${payload.card?.staffId ?? ""}` };
    if (msgType === "sticker") return { text: `[Sticker] ${payload.sticker?.stickerId ?? ""}` };
    if (msgType === "approveCard") {
      const ac = payload.approveCard ?? {};
      // Nested body format (actual WS events)
      if (ac.body) {
        const content = ac.body.content?.text ?? ac.body.title ?? "";
        return { text: content ? `[Approval Card] ${content}` : "[Approval Card]" };
      }
      // Flat format: { title, formatType, text }
      const title = ac.title?.trim() ?? "";
      const text = ac.text?.trim() ?? "";
      const parts = [title, text].filter(Boolean);
      return { text: parts.length > 0 ? `[Approval Card] ${parts.join(" — ")}` : "[Approval Card]" };
    }
    if (msgType === "i18nAppCard") {
      const i18nBody = payload.i18nAppCard?.i18nBodyTitle ?? {};
      const text = i18nBody.zhHans ?? i18nBody.en ?? "";
      return { text: text ? `[i18n App Card] ${text}` : "[i18n App Card]" };
    }
    if (msgType === "systemAction") {
      const sa = payload.systemAction ?? {};
      return { text: `[System Action] ${sa.content ?? sa.extendContent?.selfContent ?? sa.extendContent?.otherContent ?? ""}` };
    }
    if (msgType === "linkCard") {
      const lc = payload.linkCard ?? {};
      const text = lc.title ?? lc.description ?? lc.linkUrl ?? "";
      return { text: text ? `[Link Card] ${text}` : "[Link Card]" };
    }
    if (msgType === "appCard") {
      const ac = payload.appCard ?? {};
      const text = ac.title ?? ac.body?.text ?? ac.appName ?? "";
      return { text: text ? `[App Card] ${text}` : "[App Card]" };
    }
    if (msgType === "appArticles") {
      const articles = payload.appArticles?.articles ?? [];
      const titles = articles.slice(0, 3).map((a: any) => a.title ?? "").filter(Boolean);
      return { text: titles.length > 0 ? `[Articles] ${titles.join("; ")}` : "[Articles]" };
    }
    if (msgType === "verifyCard") {
      const vc = payload.verifyCard ?? {};
      const text = vc.title ?? vc.body?.content?.text ?? vc.appName ?? "";
      return { text: text ? `[Verify Card] ${text}` : "[Verify Card]" };
    }
    if (msgType === "box") {
      const box = payload.box ?? {};
      const items: Array<Record<string, any>> = box.messageItems ?? [];
      const content = box.content?.trim() ?? "";
      const isQuote = box.msgBoxType === 2;
      const label = isQuote ? "Quoted Chat History" : "Chat History";
      if (items.length === 0) {
        return { text: content ? `[${label}] ${content}` : `[${label}]` };
      }
      const parts: string[] = [content ? `[${label}] ${content}` : `[${label}]`];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const from = item.from ?? "unknown";
        const timeStr = this.formatTimestamp(item.sendTime);
        const sub = await this.extractText({ msgType: item.msgType, msgData: item.msgData });
        const meta = `[${from}${timeStr ? ` @ ${timeStr}` : ""}]`;
        parts.push(`${i + 1}. ${meta} ${sub.text ?? `[${item.msgType ?? "unknown"}]`}`);
      }
      return { text: parts.join("\n") };
    }
    return { text: null };
  }

  // ══════════════════════════════════════════════
  // REFERENCE PARSING (private)
  // ══════════════════════════════════════════════

  /** Convert Lansenger microsecond timestamp to human-readable string (e.g. "2026-07-10 17:29") */
  private formatTimestamp(ts: string | undefined): string {
    if (!ts) return "";
    const ms = Number(ts);
    if (!Number.isFinite(ms)) return "";
    // Lansenger timestamps are microseconds; fall back to milliseconds if < 1e12
    const epochMs = ms > 1e12 ? Math.floor(ms / 1000) : ms;
    const d = new Date(epochMs);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private parseReferenceMsg(rawRef: Record<string, any>): ReferenceMsg {
    return {
      from: rawRef.from,
      senderName: rawRef.senderName,
      fromType: rawRef.fromType,
      sendTime: rawRef.sendTime,
      msgType: rawRef.msgType,
      msgData: rawRef.msgData,
      referenceMsg: rawRef.referenceMsg ? this.parseReferenceMsg(rawRef.referenceMsg) : undefined,
    };
  }

  async extractReferenceText(ref: ReferenceMsg): Promise<{ text: string; mediaPaths: string[] }> {
    if (!ref.msgData) return { text: "", mediaPaths: [] };
    const msgType = ref.msgType ?? "text";
    const senderLabel = ref.senderName ?? ref.from ?? "unknown";
    const timeLabel = ref.sendTime
      ? ` @ ${this.formatTimestamp(ref.sendTime)}`
      : (msgType && ref.msgData?.[msgType]?.sendTime ? ` @ ${this.formatTimestamp(ref.msgData[msgType].sendTime)}` : "");
    const typeLabel = msgType === "box" ? "[Quoted Chat History]" : `[Quoted ${msgType}]`;
    const extracted = await this.extractText({ msgType, msgData: ref.msgData });
    const content = extracted.text ?? "";
    let text = content ? `${typeLabel} from ${senderLabel}${timeLabel}: ${content}` : `${typeLabel} from ${senderLabel}${timeLabel}`;
    const mediaPaths: string[] = extracted.mediaPaths ? [...extracted.mediaPaths] : [];
    if (ref.referenceMsg) {
      const nested = await this.extractReferenceText(ref.referenceMsg);
      if (nested.text) text = `${text}\n${nested.text}`;
      if (nested.mediaPaths.length > 0) mediaPaths.push(...nested.mediaPaths);
    }
    return { text, mediaPaths };
  }

  // ══════════════════════════════════════════════
  // INTERNAL HELPERS (private)
  // ══════════════════════════════════════════════

  private async downloadAllMedia(ids: string[], mediaKind: string): Promise<string[]> {
    const paths: string[] = [];
    for (const id of ids) {
      const download = await this.downloadMedia(id);
      if (download) {
        const ext = download.ext ?? detectExtFromBytes(download.bytes, mediaKind);
        const p = await this.saveMediaToTemp(download.bytes, mediaKind, ext, download.fname);
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

// ══════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════

export type ReminderParams = { all?: boolean; userIds?: string[]; botIds?: string[] };

export type LinkCardOptions = {
  description?: string;
  iconLink?: string;
  pcLink?: string;
  fromName?: string;
  fromIconLink?: string;
};

export type AppCardField = { key: string; value: string };
export type AppCardLink = { title: string; url: string };
export type AppCardButton = { title: string; action: string; buttonTheme?: number; state?: number; callbackInfo?: string };
export type CardAction = { actionType: string; entryId?: string; args?: AppCardField[] };
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
  cardAction?: CardAction;
};

export type AppArticle = {
  title: string;
  summary?: string;
  imgUrl: string;
  url: string;
  pcUrl?: string;
  padUrl?: string;
};

export type ArticleCardOptions = {
  sourceName?: string;
  sourceIcon?: string;
};

export type ReferenceMsg = {
  from?: string;
  senderName?: string;
  fromType?: number;
  sendTime?: string;
  msgType?: string;
  msgData?: Record<string, any>;
  referenceMsg?: ReferenceMsg;
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
  eventType?: string;
  referenceMsg?: ReferenceMsg;
  isAtMe?: boolean;
  isAtAll?: boolean;
  fromType?: number;
  groupName?: string;
  botCreator?: string;
  botId?: string;
  /** Staffs @mentioned (from eventData.reminder.staffs) */
  mentionedStaffs?: Array<{ staffId?: string; staffName?: string }>;
  /** Bots @mentioned (from eventData.reminder.bots) */
  mentionedBots?: Array<{ botId: string; botName: string }>;
  /** approveCard button callback data */
  approveCardCallback?: {
    eventData: string;
    staffId: string;
  };
};

export type LansengerCommand = {
  command: string;
  description: string;
  icon?: string;
  i18nDescription?: {
    zhHans?: string;
    zhHant?: string;
    zhHantHK?: string;
    en?: string;
    fr?: string;
  };
};

export type LansengerApiResponse = {
  errCode: number;
  errMsg?: string;
  data?: {
    appToken?: string;
    expiresIn?: number;
    wsEndpoint?: string;
    pingInterval?: number;
    msgId?: string;
    mediaId?: string;
    commands?: LansengerCommand[];
  };
};

export type LansengerWsMessage = {
  events?: Array<{ type?: string; data: Record<string, any> }>;
};

export type ApproveCardHead = {
  title?: string;
  iconLink?: string;
  iconId?: string;
  headStatus?: {
    describe?: string;
    statusIcon?: number;
    iconLink?: string;
    colour?: string;
  };
};

export type ApproveCardBody = {
  title: string;
  content?: { formatType?: number; text?: string };
  fields?: AppCardField[];
};

export type ApproveCardButton = {
  text?: string;
  buttonTheme?: number;
  state?: number;
  link?: string;
  pcLink?: string;
  padLink?: string;
  callbackInfo?: string;
  permissionScope?: {
    permittedStaffs?: string[];
    prohibitedStaffs?: string[];
  };
  prohibitedState?: number;
};

export type ApproveCardData = {
  head?: ApproveCardHead;
  body?: ApproveCardBody;
  reminder?: ReminderParams;
  cardLink?: { cardLink?: string; cardLinkForPc?: string; cardLinkForPad?: string };
  buttons?: ApproveCardButton[];
  expireTime?: number;
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

// ---- Group API types ----

export type GroupInfoData = {
  name: string;
  avatarId?: string;
  avatarUrl?: string;
  description?: string;
  owner?: { staffId: string; name: string };
  state: number; // 0=normal, 1=disbanded
  creator?: { staffId: string; name: string };
  manageMode?: number;
  locationShare?: boolean;
  needsConfirm?: boolean;
  isPublic?: boolean;
  maxMembers?: number;
  maxHistoryMsgCount?: number;
  totalMembers: number;
  remindAll?: boolean;
  sendMsgStatus?: boolean;
};

export type GroupMember = {
  status: number; // 0=INACTIVE, 1=NORMAL, 2=FROZEN, 3=DELETED
  staffId: string;
  name: string;
  avatarUrl?: string;
  avatarId?: string;
  orgName?: string;
  role: number; // 0=member, 1=assistOwner, 2=owner
};

export type GroupMembersData = {
  totalMembers: number;
  members: GroupMember[];
};

export type GroupSessionMeta = {
  groupInfo: GroupInfoData | null;
  members: GroupMember[] | null; // null when > 100 members
  memberCount: number;
};

export { DEFAULT_API_GATEWAY_URL };