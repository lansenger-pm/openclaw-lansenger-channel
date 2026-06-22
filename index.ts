import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { lansengerPlugin } from "./src/channel.js";
import { startLansengerGateway } from "./src/runtime.js";
import { registerLansengerTools } from "./src/tools.js";

export { resolveAccount, makeClient } from "./src/channel.js";
export type { ResolvedAccount } from "./src/channel.js";
export { getRunningClient, getRunningAccount, getLastInboundChatId } from "./src/runtime.js";
export { LansengerClient } from "./src/client.js";

/**
 * Ensure lansenger-setup skill is available in the global skills directory.
 * This is needed because the plugin may not activate until channels.lansenger
 * config exists, but the setup skill is meant to help create that config.
 * Skills in ~/.openclaw/skills/ are always loaded regardless of plugin activation.
 */
function ensureSetupSkill() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const srcPath = join(__dirname, "..", "skills", "lansenger-setup", "SKILL.md");

  if (!existsSync(srcPath)) return;

  const destDir = join(homedir(), ".openclaw", "skills", "lansenger-setup");
  const destPath = join(destDir, "SKILL.md");

  // Always overwrite so plugin upgrades propagate skill changes
  mkdirSync(destDir, { recursive: true });
  cpSync(srcPath, destPath);
}

export default defineChannelPluginEntry({
  id: "lansenger",
  name: "Lansenger (蓝信)",
  description: "Lansenger enterprise messaging channel plugin for OpenClaw",
  plugin: lansengerPlugin,
  registerCliMetadata(api) {
    registerLansengerTools(api);
  },
  registerFull(api) {
    ensureSetupSkill();
    startLansengerGateway(api);
    registerLansengerTools(api);
  },
});