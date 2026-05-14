import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { lansengerPlugin } from "./src/channel.js";
import { startLansengerGateway } from "./src/runtime.js";
import { registerLansengerTools } from "./src/tools.js";

export default defineChannelPluginEntry({
  id: "Lansenger",
  name: "Lansenger (蓝信)",
  description: "Lansenger enterprise messaging channel plugin for OpenClaw",
  plugin: lansengerPlugin,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program.command("Lansenger").description("Lansenger (蓝信) management");
      },
      {
        descriptors: [
          {
            name: "Lansenger",
            description: "Lansenger (蓝信) management",
            hasSubcommands: false,
          },
        ],
      },
    );
  },
  registerFull(api) {
    startLansengerGateway(api);
    registerLansengerTools(api);
  },
});