import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Fake Lansenger (蓝信开平) gateway for E2E functional tests.
 *
 * Implements the REAL protocol contract the plugin speaks:
 *  - HTTP: /v1/ws/endpoint/create, /v1/apptoken/create, /v1/bot/messages/create,
 *          /v1/messages/group/create, /v1/messages/revoke, /v1/messages/dynamic/update,
 *          /v1/app/medias/create, /v1/bot/commands/*, /v2/groups/*
 *  - WS:   /open/wss/v1?ticket=… — upgrade, reply pong to ping, push events as text frames
 *
 * Controllable fault injection (the knobs scenarios turn):
 *  - stopRespondingPongs()   → simulate a silent server (pong-timeout path)
 *  - killAllSockets()        → simulate server-side connection drop
 *  - rejectNextEndpoint()    → simulate credential failure (errCode 40018)
 *
 * Records every outbound API call for assertions (the plugin's visible behavior).
 */
export class FakeLansengerServer {
  private httpServer!: http.Server;
  private wss!: WebSocketServer;
  private port = 0;

  /** All outbound API calls the plugin made, in order: { method, path, query, body }. */
  readonly apiCalls: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];
  /** Currently connected WS sockets, per appId (ticket→appId mapping). */
  readonly socketsByAppId = new Map<string, Set<WebSocket>>();
  /** Per-appId connection count history (for orphan-connection regression checks). */
  readonly connectLog: Array<{ appId: string; at: number }> = [];

  // ── fault injection knobs ──
  private pongEnabled = true;
  private rejectEndpoint = false;
  /** Tickets issued by /v1/ws/endpoint/create (appId → ticket). */
  private tickets = new Map<string, string>();

  constructor(private readonly opts: { pingIntervalSec?: number; validSecret?: string } = {}) {}

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
      this.httpServer.listen(0, "127.0.0.1", () => {
        this.port = (this.httpServer.address() as any).port;
        resolve();
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      if (!url.pathname.startsWith("/open/wss")) {
        socket.destroy();
        return;
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      let appId = "";
      for (const [aid, t] of this.tickets) {
        if (t === ticket) appId = aid;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const set = this.socketsByAppId.get(appId) ?? new Set<WebSocket>();
        set.add(ws);
        this.socketsByAppId.set(appId, set);
        this.connectLog.push({ appId, at: Date.now() });
        ws.on("pong", () => { /* client pong — not used; server sends pongs in reply */ });
        ws.on("ping", () => {
          if (this.pongEnabled) {
            try { ws.pong(); } catch { /* closed */ }
          }
        });
        ws.on("close", () => {
          set.delete(ws);
          if (set.size === 0) this.socketsByAppId.delete(appId);
        });
        ws.on("error", () => { /* swallow */ });
      });
    });
  }

  async stop(): Promise<void> {
    for (const set of this.socketsByAppId.values()) {
      for (const ws of set) try { ws.terminate(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  // ── scenario controls ─────────────────────────────────────────

  /** Server goes silent: stops answering pings (client must pong-timeout + reconnect).
   *
   * NOTE: the ws library AUTO-PONGS every ping (RFC 6455, `websocket._autoPong`);
   * simply not calling pong() in a 'ping' handler does nothing. Silence is
   * simulated by flipping the private `_autoPong` flag off on live sockets. */
  stopRespondingPongs(): void {
    this.pongEnabled = false;
    for (const set of this.socketsByAppId.values()) {
      for (const ws of set) (ws as any)._autoPong = false;
    }
  }

  resumeRespondingPongs(): void {
    this.pongEnabled = true;
    for (const set of this.socketsByAppId.values()) {
      for (const ws of set) (ws as any)._autoPong = true;
    }
  }

  /** Server drops every connection (client must reconnect with backoff). */
  killAllSockets(): void {
    for (const set of this.socketsByAppId.values()) {
      for (const ws of set) try { ws.terminate(); } catch { /* ignore */ }
    }
  }

  /** Next /v1/ws/endpoint/create fails with 40018 (bad secret). */
  rejectNextEndpoint(): void {
    this.rejectEndpoint = true;
  }

  /** Push a bot_private_message / bot_group_message event to every socket of an appId. */
  pushEvent(appId: string, data: Record<string, unknown>, type = "bot_private_message"): void {
    const payload = JSON.stringify({
      orgIdV1: "2285568",
      appIdV1: appId,
      random: "r".repeat(43),
      length: 1,
      events: [{
        id: `evt-${Math.random().toString(36).slice(2)}`,
        type,
        eventType: type,
        data,
      }],
    });
    this.sendToApp(appId, payload);
  }

  /** Push an arbitrary top-level JSON message (e.g. approve_card_callback). */
  pushRaw(appId: string, obj: unknown): void {
    this.sendToApp(appId, JSON.stringify(obj));
  }

  private sendToApp(appId: string, payload: string): void {
    const set = this.socketsByAppId.get(appId);
    if (!set) throw new Error(`fake server: no live socket for appId=${appId}`);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Number of live server-side connections for an appId (orphan-connection check). */
  connectionCount(appId: string): number {
    return this.socketsByAppId.get(appId)?.size ?? 0;
  }

  /** Outbound API calls filtered by path fragment. */
  calls(pathFragment: string): Array<{ method: string; path: string; query: URLSearchParams; body: any }> {
    return this.apiCalls.filter((c) => c.path.includes(pathFragment));
  }

  // ── HTTP contract ──────────────────────────────────────────────

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      let body: any = {};
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }
      this.apiCalls.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
      const respond = (data: unknown, errCode = 0, errMsg = "") => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errCode, errMsg, data }));
      };

      const p = url.pathname;

      if (p === "/v1/ws/endpoint/create") {
        if (this.rejectEndpoint) {
          this.rejectEndpoint = false;
          respond(null, 40018, "APP Secret错误(fake)");
          return;
        }
        const appId = String(body.appId ?? "");
        const secret = String(body.secret ?? "");
        const expected = this.opts.validSecret ?? "test-secret";
        if (secret !== expected) {
          respond(null, 40018, "APP Secret错误(fake)");
          return;
        }
        const ticket = `tkt-${appId}-${Math.random().toString(36).slice(2)}`;
        this.tickets.set(appId, ticket);
        respond({
          wsEndpoint: `ws://127.0.0.1:${this.port}/open/wss/v1?ticket=${encodeURIComponent(ticket)}`,
          pingInterval: this.opts.pingIntervalSec ?? 1,
          expiresIn: 7200,
        });
        return;
      }

      if (p === "/v1/apptoken/create") {
        const secret = url.searchParams.get("secret") ?? "";
        if (secret !== (this.opts.validSecret ?? "test-secret")) {
          respond(null, 40018, "APP Secret错误(fake)");
          return;
        }
        respond({ appToken: `tok-${Math.random().toString(36).slice(2)}`, expiresIn: 7200 });
        return;
      }

      if (p === "/v1/bot/messages/create" || p === "/v1/messages/group/create") {
        respond({ msgId: `mid-${Math.random().toString(36).slice(2)}` });
        return;
      }

      // Reminder-failure simulation: formatText WITH reminder fails once (plugin must retry without).
      if (p === "/v1/messages/revoke" || p === "/v1/messages/dynamic/update") {
        respond({ success: true });
        return;
      }

      if (p === "/v1/app/medias/create") {
        respond({ mediaId: `media-${Math.random().toString(36).slice(2)}` });
        return;
      }

      if (p.startsWith("/v1/medias/") && p.endsWith("/fetch")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from("fake-media-bytes"));
        return;
      }

      if (p.startsWith("/v1/bot/commands/")) {
        respond({ commands: [] });
        return;
      }

      if (p === "/v2/groups/fetch") {
        respond({ totalGroupIds: 1, groupIds: ["g-1"] });
        return;
      }

      if (p.endsWith("/info/fetch")) {
        respond({ groupId: "g-1", name: "Test Group", memberCount: 2 });
        return;
      }

      if (p.endsWith("/members/fetch") || p.endsWith("/members/is_in_group")) {
        respond({ members: [{ staffId: "user-1" }, { staffId: "user-2" }], inGroup: true });
        return;
      }

      respond({});
    });
  }
}

/** Standard inbound DM event payload (mirror of the real server's shape). */
export function dmEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgType: "text",
    msgData: { text: { content: "hello bot" } },
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    chatType: "p2p",
    from: "user-1",
    senderName: "Alice",
    conversationId: "user-1",
    reminder: { isAtMe: false, isAtAll: false },
    ...overrides,
  };
}

/** Standard inbound group event payload. */
export function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgType: "text",
    msgData: { text: { content: "hi @bot" } },
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    chatType: "group",
    from: "user-1",
    senderName: "Alice",
    groupId: "g-1",
    groupName: "Test Group",
    reminder: { isAtMe: true, isAtAll: false, bots: [{ botId: "bot-1", botName: "Bot" }] },
    ...overrides,
  };
}