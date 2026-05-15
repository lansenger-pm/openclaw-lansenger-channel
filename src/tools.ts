import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import { getLastInboundChatId, getRunningClient, getRunningAccount } from "./runtime.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";

function resolveTarget(to?: string): string {
  if (to) return to;
  return getLastInboundChatId();
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const SendFileSchema = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Absolute local path to the file to send. Any path works — Documents, Desktop, workspace, /tmp, etc." },
    caption: { type: "string", description: "Plain-text caption for the file (Markdown will NOT render on Lansenger). Optional." },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
  },
  required: ["filePath"],
};

const SendTextSchema = {
  type: "object",
  properties: {
    content: { type: "string", description: "Plain text content. No Markdown support — Markdown renders automatically in normal replies. Use this for text + file attachment or text + @mentions." },
    filePath: { type: "string", description: "Optional local file/image/video to attach. If provided, content becomes the caption." },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
    reminderAll: { type: "boolean", description: "@mention all members in a group (only works in group chat, not DMs)." },
    reminderUserIds: { type: "array", items: { type: "string" }, description: "List of user IDs to @mention (group chat only). Include '@姓名' in the message text so users can see who was mentioned." },
  },
  required: ["content"],
};

const SendFormatTextSchema = {
  type: "object",
  properties: {
    content: { type: "string", description: "Markdown-formatted text. Renders as rich text on Lansenger. Use this when you need Markdown + @mention. Does NOT support file attachments." },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
    reminderAll: { type: "boolean", description: "@mention all members in a group (group chat only)." },
    reminderUserIds: { type: "array", items: { type: "string" }, description: "List of user IDs to @mention (group chat only). Include '@姓名' in text so the mention is visible." },
  },
  required: ["content"],
};

const SendImageUrlSchema = {
  type: "object",
  properties: {
    imageUrl: { type: "string", description: "URL of the image to download and send. Must be directly reachable from the gateway host." },
    caption: { type: "string", description: "Optional plain-text caption (no Markdown)." },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
  },
  required: ["imageUrl"],
};

const RevokeMessageSchema = {
  type: "object",
  properties: {
    messageIds: { type: "array", items: { type: "string" }, description: "List of message IDs to revoke." },
    chatType: { type: "string", description: "Chat type: bot (default) or group. For group, senderId is required.", default: "bot" },
    senderId: { type: "string", description: "Sender ID (required for group chat type)." },
  },
  required: ["messageIds"],
};

const SendLinkCardSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Card title." },
    link: { type: "string", description: "Card click-through link URL." },
    description: { type: "string", description: "Card description text (API-required, defaults to empty)." },
    iconLink: { type: "string", description: "Card icon image URL (API-required, defaults to empty)." },
    pcLink: { type: "string", description: "PC client link URL." },
    fromName: { type: "string", description: "Card source name (API-required, defaults to empty)." },
    fromIconLink: { type: "string", description: "Card source icon URL (API-required, defaults to empty)." },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
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
          summary: { type: "string", description: "Optional article summary (摘要). NOT 'description' — that field is ignored by the API." },
        },
        required: ["imgUrl", "title", "url"],
      },
      description: "List of article entries. Each must have imgUrl, title, url.",
    },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
  },
  required: ["articles"],
};

const SendAppCardSchema = {
  type: "object",
  properties: {
    bodyTitle: { type: "string", description: "Card body title. Supports div-style: color, font-size, text-align." },
    headTitle: { type: "string", description: "Card header title." },
    bodySubTitle: { type: "string", description: "Card body subtitle. Supports div-style formatting." },
    bodyContent: { type: "string", description: "Card body content. Supports div-style formatting. Always use text-indent:0em — bare 0 causes API failure." },
    signature: { type: "string", description: "Card signature line. Supports color." },
    isDynamic: { type: "boolean", description: "Enable dynamic card updates (default: false). When true, card can be updated via lansenger_update_dynamic_card.", default: false },
    headStatusInfo: {
      type: "object",
      properties: {
        description: { type: "string", description: "Status text (max 30 bytes). Supports div-style for color: e.g. '<div style=\"color:#FFB116\">待审批</div>'. Plain text also works." },
        colour: { type: "string", description: "Status color (e.g. #FFB116 amber, #198754 green, #dc3545 red)." },
      },
      description: "Dynamic card status info. Required when isDynamic=true. description = text supporting div-style color (max 30 bytes). colour = status dot color (hex). These are TWO different things: description text color vs dot color.",
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
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
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
        description: { type: "string", description: "Updated status text. Supports div-style for color." },
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

function makeToolClient(): { client: LansengerClient; account: ResolvedAccount } | null {
  const account = getRunningAccount();
  if (!account) return null;
  const client = getRunningClient();
  if (!client) return null;
  return { client, account };
}

import { LansengerClient } from "./client.js";

export function registerLansengerTools(api: any) {
  api.registerTool({
    name: "lansenger_send_file",
    description: "Send a local file as an attachment on Lansenger (蓝信). Any local file works — workspace, Documents, /tmp, etc. Do NOT use MEDIA: tags for files outside the workspace; they silently fail. Always use this tool instead.",
    parameters: SendFileSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const filePath = params.filePath;
      const caption = params.caption ?? "";
      const to = resolveTarget(params.to);
      if (!filePath) return jsonResult({ error: "filePath is required" });
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
      const resolved = path.resolve(filePath);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) return jsonResult({ error: `Not a file: ${filePath}` });
      } catch {
        return jsonResult({ error: `File not found: ${filePath}` });
      }
      const result = await tc.client.sendFile(to, resolved, caption);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
});

  api.registerTool({
    name: "lansenger_send_text",
    description: "Send plain text on Lansenger (蓝信) with optional file attachment and @mentions. Uses msgType=text: plain text ONLY (NO Markdown). For Markdown, just write normally — it renders automatically in replies. If you need both Markdown AND a file, send Markdown first, then call this tool for the file.",
    parameters: SendTextSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const content = params.content ?? "";
      const filePath = params.filePath ?? "";
      const to = resolveTarget(params.to);
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
      const client = tc.client;
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
  });

  api.registerTool({
    name: "lansenger_send_format_text",
    description: "Send Markdown-formatted text on Lansenger (蓝信) with optional @mentions. Uses msgType=formatText: Markdown renders as rich text. Supports @mentions via reminder params. Does NOT support file attachments — for Markdown + file, write the Markdown reply normally first, then use lansenger_send_file separately.",
    parameters: SendFormatTextSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const content = params.content ?? "";
      const to = resolveTarget(params.to);
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
      const reminder = (params.reminderAll || (params.reminderUserIds && params.reminderUserIds.length > 0))
        ? { all: Boolean(params.reminderAll), userIds: params.reminderUserIds ?? [] }
        : undefined;
      const result = await tc.client.sendFormatText(to, content, reminder);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  });

  api.registerTool({
    name: "lansenger_send_image_url",
    description: "Send an image from a URL to a Lansenger (蓝信) user or group. Downloads the image first, then uploads and sends. URL must be directly reachable from the gateway host. For local files, use lansenger_send_file instead.",
    parameters: SendImageUrlSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const imageUrl = params.imageUrl;
      const caption = params.caption ?? "";
      const to = resolveTarget(params.to);
      if (!imageUrl) return jsonResult({ error: "imageUrl is required" });
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
      const result = await tc.client.sendImageUrl(to, imageUrl, caption);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  });

  api.registerTool({
    name: "lansenger_revoke_message",
    description: "Revoke previously sent Lansenger (蓝信) messages. The recipient sees a 'message revoked' notification. For group chat, senderId is required.",
    parameters: RevokeMessageSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const messageIds = params.messageIds;
      if (!messageIds || messageIds.length === 0) return jsonResult({ error: "messageIds is required" });
      const chatType = params.chatType ?? "bot";
      const senderId = params.senderId;
      if (chatType === "group" && !senderId) {
        return jsonResult({ error: "chatType='group' requires senderId" });
      }
      const result = await tc.client.revokeMessage(messageIds, chatType, senderId);
      return jsonResult({ success: result.success });
    },
  });

  api.registerTool({
    name: "lansenger_send_link_card",
    description: "Send a link preview card on Lansenger (蓝信). Displays title, description, icon, and clickable link. API requires description, iconLink, fromName, fromIconLink (defaults to empty string if omitted).",
    parameters: SendLinkCardSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const title = params.title;
      const link = params.link;
      const to = resolveTarget(params.to);
      if (!title || !link) return jsonResult({ error: "title and link are required" });
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
      const result = await tc.client.sendLinkCard(to, title, link, {
        description: params.description ?? "",
        iconLink: params.iconLink ?? "",
        pcLink: params.pcLink ?? "",
        fromName: params.fromName ?? "",
        fromIconLink: params.fromIconLink ?? "",
      });
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  });

  api.registerTool({
    name: "lansenger_send_app_articles",
    description: "Send a multi-article card (图文卡片) on Lansenger (蓝信). Each article has an image, title, and link. Article summary field is 'summary' (NOT 'description' — that field is silently ignored by the API). For a single link card, use lansenger_send_link_card instead.",
    parameters: SendAppArticlesSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const articles = params.articles;
      const to = resolveTarget(params.to);
      if (!articles || articles.length === 0) return jsonResult({ error: "articles is required" });
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
      const result = await tc.client.sendAppArticles(to, articles);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  });

  api.registerTool({
    name: "lansenger_send_app_card",
    description: "Send a rich formatted card (应用卡片) on Lansenger (蓝信). Supports div-style formatting (color, font-size, text-align, text-indent). Set isDynamic=true for approval workflows. ⚠️ font-size MUST use pt units (12pt–36pt) — px causes 'invalid bodyContent'. ⚠️ text-indent MUST have units — bare 0 causes silent failure, use 0em. ⚠️ headStatusInfo: description is status TEXT (supports div-style for color, max 30 bytes), colour is the DOT/圆点 color (hex like #FFB116). These are TWO different things — text color vs dot color. ⚠️ Group chat does NOT support appCard msgType — falls back to plain text.",
    parameters: SendAppCardSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const bodyTitle = params.bodyTitle;
      const to = resolveTarget(params.to);
      if (!bodyTitle) return jsonResult({ error: "bodyTitle is required" });
      if (!to) return jsonResult({ error: "No target specified. Provide a 'to' parameter (chat ID)." });
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
      const result = await tc.client.sendAppCard(to, cardData as any);
      return jsonResult({ success: result.success, messageId: result.messageId ?? null });
    },
  });

  api.registerTool({
    name: "lansenger_update_dynamic_card",
    description: "Update a dynamic appCard's status in-place on Lansenger (蓝信). The card must have been sent with isDynamic=true via lansenger_send_app_card. Use this for approval workflows: pending → approved/rejected. headStatusInfo: description supports div-style for color, colour is the status dot color.",
    parameters: UpdateDynamicCardSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const msgId = params.msgId;
      if (!msgId) return jsonResult({ error: "msgId is required" });
      const result = await tc.client.updateDynamicCard(
        msgId,
        params.headStatusInfo,
        params.links,
        params.isLastUpdate ?? false,
      );
      return jsonResult({ success: result.success });
    },
  });

  api.registerTool({
    name: "lansenger_query_groups",
    description: "Query the bot's group list on Lansenger (蓝信). Returns total count and group IDs. ⚠️ May return errCode=10005 'API服务无权限' on enterprise deployments where /v2/groups/fetch is not authorized. If permission denied, ask the user for group chatIds manually.",
    parameters: QueryGroupsSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const result = await tc.client.queryGroups(params.pageOffset ?? 1, params.pageSize ?? 100);
      if ("error" in result) return jsonResult({ error: result.error });
      return jsonResult({ success: true, totalGroupIds: result.totalGroupIds, groupIds: result.groupIds });
    },
  });
}