import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import { getLastInboundChatId, getRunningClient, getRunningAccount } from "./runtime.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";

function resolveAccountFromConfig(config: any): ResolvedAccount | null {
  if (!config) return null;
  const section = (config.channels as Record<string, any>)?.["lansenger"];
  if (!section) return null;
  const accounts = section.accounts as Record<string, any> | undefined;
  let account: ResolvedAccount;
  if (accounts && Object.keys(accounts).length > 0) {
    const firstKey = Object.keys(accounts)[0];
    account = resolveAccount(config, firstKey);
  } else {
    account = resolveAccount(config, undefined);
  }
  if (!account.enabled || !account.appId) return null;
  return account;
}

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
    content: { type: "string", description: "Plain text content. No Markdown support — use lansenger_send_file for file delivery, Markdown renders automatically in normal replies." },
    filePath: { type: "string", description: "Optional local file/image/video to attach. If provided, content becomes the caption." },
    to: { type: "string", description: "Chat ID to send to. Leave empty to auto-detect from current session." },
    reminderAll: { type: "boolean", description: "@mention all members in a group (only works in group chat, not DMs)." },
    reminderUserIds: { type: "array", items: { type: "string" }, description: "List of user IDs to @mention (group chat only). Include '@姓名' in the message text so users can see who was mentioned." },
  },
  required: ["content"],
};

const SendImageUrlSchema = {
  type: "object",
  properties: {
    imageUrl: { type: "string", description: "URL of the image to download and send." },
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
    description: { type: "string", description: "Card description text (required by API, defaults to empty)." },
    iconLink: { type: "string", description: "Card icon image URL (required by API, defaults to empty)." },
    pcLink: { type: "string", description: "PC client link URL." },
    fromName: { type: "string", description: "Card source name (required by API, defaults to empty)." },
    fromIconLink: { type: "string", description: "Card source icon URL (required by API, defaults to empty)." },
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
          summary: { type: "string", description: "Optional article summary (摘要)." },
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
    label: "Lansenger Send File",
    description: "Send a local file as an attachment on Lansenger (蓝信). PDF, image, document, video — any local file works. Do NOT use MEDIA: tags for file delivery — they silently fail for files outside the workspace; always use this tool instead.",
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
    label: "Lansenger Send Text",
    description: "Send a plain text message on Lansenger (蓝信) with optional file attachment and @mentions. Uses msgType=text: plain text only (NO Markdown). Supports attachments and @mentions in group chat. For Markdown, just write normally — it renders automatically in replies. If you need both Markdown AND a file, send Markdown first, then call this tool for the file.",
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
    name: "lansenger_send_image_url",
    label: "Lansenger Send Image URL",
    description: "Send an image from a URL to a Lansenger (蓝信) user or group. Downloads the image first, then uploads and sends. For local files, use lansenger_send_file instead.",
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
    label: "Lansenger Revoke Message",
    description: "Revoke previously sent Lansenger (蓝信) messages. The recipient sees a 'message revoked' notification from the platform. For group chat, senderId is required.",
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
    label: "Lansenger Send Link Card",
    description: "Send a link preview card on Lansenger (蓝信). Displays title, description, icon, and clickable link.",
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
    label: "Lansenger Send App Articles",
    description: "Send a multi-article card (图文卡片) on Lansenger (蓝信). Each article has an image, title, and link. For a single link card, use lansenger_send_link_card instead.",
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
    label: "Lansenger Send App Card",
    description: "Send a rich formatted card (应用卡片) on Lansenger (蓝信). Supports div-style formatting (color, font-size, text-align, text-indent). Set isDynamic=true for approval workflows — card can then be updated via lansenger_update_dynamic_card. bodyContent text-indent MUST have units — bare 0 causes API failure; always use 0em.",
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
    label: "Lansenger Update Dynamic Card",
    description: "Update a dynamic appCard's status in-place on Lansenger (蓝信). The card must have been sent with isDynamic=true via lansenger_send_app_card. Use this for approval workflows: pending → approved/rejected.",
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
    label: "Lansenger Query Groups",
    description: "Query the bot's group list on Lansenger (蓝信). Returns total count and group IDs. Use this to discover available group chat IDs.",
    parameters: QueryGroupsSchema,
    async execute(_toolCallId: string, params: any) {
      const tc = makeToolClient();
      if (!tc) return jsonResult({ error: "Lansenger account not configured or not running." });
      const result = await tc.client.queryGroups(params.pageOffset ?? 1, params.pageSize ?? 100);
      if ("error" in result) return jsonResult({ error: result.error });
      return jsonResult({ success: true, totalGroupIds: result.totalGroupIds, groupIds: result.groupIds });
    },
  });

  const registered = [
    "lansenger_send_file", "lansenger_send_text", "lansenger_send_image_url",
    "lansenger_send_link_card", "lansenger_send_app_articles", "lansenger_send_app_card",
    "lansenger_update_dynamic_card", "lansenger_revoke_message", "lansenger_query_groups",
  ];
  console.log(`[lansenger] tools registered: ${registered.join(", ")}`);
}