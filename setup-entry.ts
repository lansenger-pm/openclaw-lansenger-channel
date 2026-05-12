import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { lansengerPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(lansengerPlugin);