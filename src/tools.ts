import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";

function resolveAccountFromApi(api: any): ResolvedAccount | null {
  if (!api.config) return null;
  const section = (api.config.channels as Record<string, any>)?.["lansenger"];
  if (!section) return null;
  const accounts = section.accounts as Record<string, any> | undefined;
  let account: ResolvedAccount;
  if (accounts && Object.keys(accounts).length > 0) {
    const firstKey = Object.keys(accounts)[0];
    account = resolveAccount(api.config, firstKey);
  } else {
    account = resolveAccount(api.config, undefined);
  }
  if (!account.enabled || !account.appId) return null;
  return account;
}

function resolveSessionTarget(ctx: any): string {
  if (ctx.to) return ctx.to;
  if (ctx.sessionKey) {
    const parts = String(ctx.sessionKey).split(":");
    if (parts.length >= 3 && parts[2]) return parts[2];
  }
  return String(ctx.requesterSenderId ?? "");
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const SendFileSchema = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Absolute local path to the file to send. Any path works — Documents, Desktop, workspace, /tmp, etc." },
    caption: { type: "string", description: "Plain-text caption for the file (Markdown will NOT render on Lansenger). Optional." },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, sent to current conversation." },
  },
  required: ["filePath"],
};

const SendTextSchema = {
  type: "object",
  properties: {
    content: { type: "string", description: "Plain text content. No Markdown support — use lansenger_send_file for file delivery, Markdown renders automatically in normal replies." },
    filePath: { type: "string", description: "Optional local file/image/video to attach. If provided, content becomes the caption." },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, sent to current conversation." },
    reminderAll: { type: "boolean", description: "@mention all members in a group (only works in group/staff chat, not DMs)." },
    reminderUserIds: { type: "array", items: { type: "string" }, description: "List of user IDs to @mention (only works in group/staff chat)." },
  },
  required: ["content"],
};

const SendImageUrlSchema = {
  type: "object",
  properties: {
    imageUrl: { type: "string", description: "URL of the image to download and send." },
    caption: { type: "string", description: "Optional plain-text caption (no Markdown)." },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, sent to current conversation." },
  },
  required: ["imageUrl"],
};

const RevokeMessageSchema = {
  type: "object",
  properties: {
    messageIds: { type: "array", items: { type: "string" }, description: "List of message IDs to revoke." },
    chatType: { type: "string", description: "Chat type: bot (default), staff, group. For staff/group, senderId is required.", default: "bot" },
    senderId: { type: "string", description: "Sender ID (required for staff/group chat types)." },
  },
  required: ["messageIds"],
};

const SendLinkCardSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Card title." },
    link: { type: "string", description: "Card click-through link URL." },
    description: { type: "string", description: "Card description text." },
    iconLink: { type: "string", description: "Card icon image URL." },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, sent to current conversation." },
  },
  required: ["title", "link"],
};

const SendAppArticlesSchema = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          imgUrl: { type: "string", description: "Article image URL." },
          title: { type: "string", description: "Article title." },
          url: { type: "string", description: "Article content link URL." },
          pcUrl: { type: "string", description: "PC client content link URL." },
          summary: { type: "string", description: "Optional article summary." },
        },
        required: ["imgUrl", "title", "url"],
      },
      description: "List of article entries. Each must have imgUrl, title, url.",
    },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, sent to current conversation." },
  },
  required: ["articles"],
};

const SendAppCardSchema = {
  type: "object",
  properties: {
    bodyTitle: { type: "string", description: "Card body title. Supports div-style: color, font-size, text-align." },
    headTitle: { type: "string", description: "Card header title." },
    bodySubTitle: { type: "string", description: "Card body subtitle. Supports div-style formatting." },
    bodyContent: { type: "string", description: "Card body content. Supports div-style formatting. Always use text-indent:0em to avoid unwanted indentation." },
    signature: { type: "string", description: "Card signature line. Supports color." },
    isDynamic: { type: "boolean", description: "Enable dynamic card updates (default: false). When true, card can be updated via lansenger_update_dynamic_card.", default: false },
    headStatusInfo: {
      type: "object",
      properties: {
        description: { type: "string", description: "Status description (max 30 bytes). Supports color div-style." },
        colour: { type: "string", description: "Status color (e.g. #FFB116 amber, #198754 green, #dc3545 red)." },
      },
      description: "Dynamic card status info. Required when isDynamic=true.",
    },
    fields: {
      type: "array",
      items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } },
      description: "Key-value pairs (max 10). Both support color div-style.",
    },
    links: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } },
      description: "Link entries (max 3). Title supports color and text-align.",
    },
    cardLink: { type: "string", description: "Card click-through link." },
    staffId: { type: "string", description: "Staff openId for showing sender avatar." },
    headIconUrl: { type: "string", description: "Header icon URL." },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, sent to current conversation." },
  },
  required: ["bodyTitle"],
};

const UpdateDynamicCardSchema = {
  type: "object",
  properties: {
    msgId: { type: "string", description: "Message ID from original lansenger_send_app_card response (required)." },
    headStatusInfo: {
      type: "object",
      properties: {
        description: { type: "string", description: "Updated status description. Supports color div-style." },
        colour: { type: "string", description: "Updated status color (e.g. #198754 green, #dc3545 red)." },
      },
      description: "Updated status info for the card header.",
    },
    links: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } },
      description: "Updated link entries (max 3).",
    },
    isLastUpdate: { type: "boolean", description: "True = final state, card becomes static (default: false).", default: false },
  },
  required: ["msgId"],
};

const QueryGroupsSchema = {
  type: "object",
  properties: {
    pageOffset: { type: "integer", description: "Page number (default: 1).", default: 1 },
    pageSize: { type: "integer", description: "Groups per page (max 100, default: 100).", default: 100 },
  },
};

export function registerLansengerTools(api: any) {
  const account = resolveAccountFromApi(api);
  if (!account) return;

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_file",
    label: "Lansenger Send File",
    description: "Send a local file as an attachment on Lansenger (蓝信). PDF, image, document, video — any local file works. Do NOT use MEDIA: tags for file delivery — they silently fail for files outside the workspace; always use this tool instead.",
    parameters: SendFileSchema,
    async execute(_toolCallId: string, params: any) {
      const filePath = params.filePath;
      const caption = params.caption ?? "";
      const to = resolveSessionTarget({ ...ctx, to: params.to });
      if (!filePath) return jsonResult({ error: "filePath is required" });
      if (!to) return jsonResult({ error: "No target specified and no active session context. Provide a 'to' parameter." });
      const resolved = path.resolve(filePath);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) return jsonResult({ error: `Not a file: ${filePath}` });
      } catch {
        return jsonResult({ error: `File not found: ${filePath}` });
      }
      const client = makeClient(account);
      const result = await client.sendFile(to, resolved, caption);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  }), { name: "lansenger_send_file" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_text",
    label: "Lansenger Send Text",
    description: "Send a plain text message on Lansenger (蓝信) with optional file attachment and @mentions. Uses msgType=text: plain text only (NO Markdown). Supports attachments and @mentions in group/staff chat. For Markdown, just write normally — it renders automatically in replies. If you need both Markdown AND a file, send Markdown first, then call this tool for the file.",
    parameters: SendTextSchema,
    async execute(_toolCallId: string, params: any) {
      const content = params.content ?? "";
      const filePath = params.filePath ?? "";
      const to = resolveSessionTarget({ ...ctx, to: params.to });
      if (!to) return jsonResult({ error: "No target specified and no active session context." });
      const client = makeClient(account);
      if (filePath) {
        const resolved = path.resolve(filePath);
        try {
          const stat = await fs.stat(resolved);
          if (!stat.isFile()) return jsonResult({ error: `Not a file: ${filePath}` });
        } catch {
          return jsonResult({ error: `File not found: ${filePath}` });
        }
        const uploadResult = await client.uploadMedia(resolved);
        if ("error" in uploadResult) return jsonResult({ error: uploadResult.error });
        const reminder = (params.reminderAll || (params.reminderUserIds && params.reminderUserIds.length > 0))
          ? { all: Boolean(params.reminderAll), userIds: params.reminderUserIds ?? [] }
          : undefined;
        const result = await client.sendTextWithMedia(to, content, 3, [uploadResult.mediaId], reminder);
        return jsonResult({ success: result.success, messageId: result.messageId ?? null });
      }
      const reminder = (params.reminderAll || (params.reminderUserIds && params.reminderUserIds.length > 0))
        ? { all: Boolean(params.reminderAll), userIds: params.reminderUserIds ?? [] }
        : undefined;
      const result = await client.sendText(to, content, reminder);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  }), { name: "lansenger_send_text" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_image_url",
    label: "Lansenger Send Image URL",
    description: "Send an image from a URL to a Lansenger (蓝信) user or group. Downloads the image first, then uploads and sends. For local files, use lansenger_send_file instead.",
    parameters: SendImageUrlSchema,
    async execute(_toolCallId: string, params: any) {
      const imageUrl = params.imageUrl;
      const caption = params.caption ?? "";
      const to = resolveSessionTarget({ ...ctx, to: params.to });
      if (!imageUrl) return jsonResult({ error: "imageUrl is required" });
      if (!to) return jsonResult({ error: "No target specified and no active session context." });
      const client = makeClient(account);
      const result = await client.sendImageUrl(to, imageUrl, caption);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  }), { name: "lansenger_send_image_url" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_revoke_message",
    label: "Lansenger Revoke Message",
    description: "Revoke previously sent Lansenger (蓝信) messages. You need the message IDs to revoke. For staff/group chat, senderId is required.",
    parameters: RevokeMessageSchema,
    async execute(_toolCallId: string, params: any) {
      const messageIds = params.messageIds;
      if (!messageIds || messageIds.length === 0) return jsonResult({ error: "messageIds is required" });
      const chatType = params.chatType ?? "bot";
      const senderId = params.senderId;
      if (["staff", "group"].includes(chatType) && !senderId) {
        return jsonResult({ error: `chatType='${chatType}' requires senderId` });
      }
      const client = makeClient(account);
      const result = await client.revokeMessage(messageIds, chatType, senderId);
      return jsonResult({ success: result.success });
    },
  }), { name: "lansenger_revoke_message" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_link_card",
    label: "Lansenger Send Link Card",
    description: "Send a link preview card on Lansenger (蓝信). Displays title, description, icon, and clickable link.",
    parameters: SendLinkCardSchema,
    async execute(_toolCallId: string, params: any) {
      const title = params.title;
      const link = params.link;
      const to = resolveSessionTarget({ ...ctx, to: params.to });
      if (!title || !link) return jsonResult({ error: "title and link are required" });
      if (!to) return jsonResult({ error: "No target specified and no active session context." });
      const client = makeClient(account);
      const result = await client.sendLinkCard(to, title, link, {
        description: params.description ?? "",
        iconLink: params.iconLink ?? "",
      });
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  }), { name: "lansenger_send_link_card" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_app_articles",
    label: "Lansenger Send App Articles",
    description: "Send a multi-article card (图文卡片) on Lansenger (蓝信). Each article has an image, title, and link. For a single link card, use lansenger_send_link_card instead.",
    parameters: SendAppArticlesSchema,
    async execute(_toolCallId: string, params: any) {
      const articles = params.articles;
      const to = resolveSessionTarget({ ...ctx, to: params.to });
      if (!articles || articles.length === 0) return jsonResult({ error: "articles is required" });
      if (!to) return jsonResult({ error: "No target specified and no active session context." });
      const client = makeClient(account);
      const result = await client.sendAppArticles(to, articles);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  }), { name: "lansenger_send_app_articles" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_app_card",
    label: "Lansenger Send App Card",
    description: "Send a rich formatted card (应用卡片) on Lansenger (蓝信). Supports div-style formatting (color, font-size, text-align, text-indent). Set isDynamic=true for approval workflows — card can then be updated via lansenger_update_dynamic_card. bodyContent text-indent MUST have units — bare 0 causes API failure; always use 0em.",
    parameters: SendAppCardSchema,
    async execute(_toolCallId: string, params: any) {
      const bodyTitle = params.bodyTitle;
      const to = resolveSessionTarget({ ...ctx, to: params.to });
      if (!bodyTitle) return jsonResult({ error: "bodyTitle is required" });
      if (!to) return jsonResult({ error: "No target specified and no active session context." });
      const client = makeClient(account);
      const cardData: Record<string, unknown> = {
        bodyTitle,
        headTitle: params.headTitle ?? "",
        bodySubTitle: params.bodySubTitle ?? "",
        bodyContent: params.bodyContent ?? "",
        signature: params.signature ?? "",
        isDynamic: params.isDynamic ?? false,
        cardLink: params.cardLink ?? "",
        staffId: params.staffId ?? "",
        headIconUrl: params.headIconUrl ?? "",
      };
      if (params.fields) cardData.fields = params.fields;
      if (params.links) cardData.links = params.links;
      if (params.headStatusInfo) cardData.headStatusInfo = params.headStatusInfo;
      if (params.isDynamic && !params.headStatusInfo) {
        cardData.headStatusInfo = {
          description: '<div style="color:rgba(0,0,0,.47);text-align:left">Active</div>',
          colour: "rgba(0,0,0,.47)",
        };
      }
      const result = await client.sendAppCard(to, cardData as any);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  }), { name: "lansenger_send_app_card" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_update_dynamic_card",
    label: "Lansenger Update Dynamic Card",
    description: "Update a dynamic appCard's status in-place on Lansenger (蓝信). The card must have been sent with isDynamic=true via lansenger_send_app_card. Use this for approval workflows: pending → approved/rejected.",
    parameters: UpdateDynamicCardSchema,
    async execute(_toolCallId: string, params: any) {
      const msgId = params.msgId;
      if (!msgId) return jsonResult({ error: "msgId is required" });
      const client = makeClient(account);
      const result = await client.updateDynamicCard(
        msgId,
        params.headStatusInfo,
        params.links,
        params.isLastUpdate ?? false,
      );
      return jsonResult({ success: result.success });
    },
  }), { name: "lansenger_update_dynamic_card" });

  api.registerTool((ctx: any) => ({
    name: "lansenger_query_groups",
    label: "Lansenger Query Groups",
    description: "Query the bot's group list on Lansenger (蓝信). Returns total count and group IDs. Use this to discover available group chat IDs.",
    parameters: QueryGroupsSchema,
    async execute(_toolCallId: string, params: any) {
      const client = makeClient(account);
      const result = await client.queryGroups(params.pageOffset ?? 1, params.pageSize ?? 100);
      if ("error" in result) return jsonResult({ error: result.error });
      return jsonResult({ success: true, totalGroupIds: result.totalGroupIds, groupIds: result.groupIds });
    },
  }), { name: "lansenger_query_groups" });
}