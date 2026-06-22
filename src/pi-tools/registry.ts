import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRtkBashToolDefinition, type RtkBashServices } from "./bash.js";

export function registerRtkBashTool(pi: ExtensionAPI, services: RtkBashServices) {
  pi.registerTool(createRtkBashToolDefinition(services));
}
