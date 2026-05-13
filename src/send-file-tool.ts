import { resolveAccount, makeClient } from "./channel.js";
import type { ResolvedAccount } from "./channel.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const SendFileSchema = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Absolute local path to the file to send. Any path works — Documents, Desktop, workspace, /tmp, etc." },
    caption: { type: "string", description: "Plain-text caption for the file (Markdown will NOT render on Lansenger). Optional." },
    to: { type: "string", description: "Lansenger target chat ID. Optional — if omitted, the file is sent to the current conversation automatically." },
  },
  required: ["filePath"],
};

function resolveSessionTarget(ctx: any): string {
  if (ctx.to) return ctx.to;
  if (ctx.sessionKey) {
    const parts = String(ctx.sessionKey).split(":");
    if (parts.length >= 3 && parts[2]) return parts[2];
  }
  return String(ctx.requesterSenderId ?? "");
}

export function registerLansengerSendFileTool(api: any) {
  if (!api.config) return;
  const section = (api.config.channels as Record<string, any>)?.["lansenger"];
  if (!section) return;

  const accounts = section.accounts as Record<string, any> | undefined;
  let account: ResolvedAccount;
  if (accounts && Object.keys(accounts).length > 0) {
    const firstKey = Object.keys(accounts)[0];
    account = resolveAccount(api.config, firstKey);
  } else {
    account = resolveAccount(api.config, undefined);
  }
  if (!account.enabled || !account.appId) return;

  api.registerTool((ctx: any) => ({
    name: "lansenger_send_file",
    label: "Lansenger Send File",
    description: "Send a local file as an attachment to the user on Lansenger (蓝信). Use this tool to deliver any file — PDF, image, document, video, etc. The file can be anywhere on the local disk. Do NOT use MEDIA: tags to send files on Lansenger — they silently fail for files outside the workspace; always use this tool instead.",
    parameters: SendFileSchema,
    async execute(_toolCallId: string, params: any) {
      const filePath = params.filePath;
      const caption = params.caption ?? "";
      const to = resolveSessionTarget({ ...ctx, to: params.to });

      if (!filePath) return { content: [{ type: "text", text: JSON.stringify({ error: "filePath is required" }) }] };
      if (!to) return { content: [{ type: "text", text: JSON.stringify({ error: "No target specified and no active session context. Provide a 'to' parameter." }) }] };

      const resolved = path.resolve(filePath);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) return { content: [{ type: "text", text: JSON.stringify({ error: `Not a file: ${filePath}` }) }] };
      } catch {
        return { content: [{ type: "text", text: JSON.stringify({ error: `File not found: ${filePath}` }) }] };
      }

      const client = makeClient(account);
      const result = await client.sendFile(to, resolved, caption);
      return { content: [{ type: "text", text: JSON.stringify({ success: result.success, messageId: result.messageId ?? null }) }] };
    },
  }), { name: "lansenger_send_file" });
}