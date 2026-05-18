import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { lansengerPlugin } from "./src/channel.js";
import { startLansengerGateway } from "./src/runtime.js";
import { registerLansengerTools } from "./src/tools.js";

export { resolveAccount, makeClient } from "./src/channel.js";
export type { ResolvedAccount } from "./src/channel.js";
export { getRunningClient, getRunningAccount, getLastInboundChatId } from "./src/runtime.js";
export { LansengerClient } from "./src/client.js";

export default defineChannelPluginEntry({
  id: "lansenger",
  name: "Lansenger (蓝信)",
  description: "Lansenger enterprise messaging channel plugin for OpenClaw",
  plugin: lansengerPlugin,
  registerFull(api) {
    startLansengerGateway(api);
    registerLansengerTools(api);
  },
});