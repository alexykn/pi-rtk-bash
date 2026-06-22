import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./extension/commands.js";
import { registerPromptGuidance } from "./extension/prompt.js";
import { applySavedSettings } from "./extension/settings.js";
import { registerRtkBashTool } from "./pi-tools/registry.js";
import { RtkRewriteService } from "./rtk/rewrite.js";
import { createRtkBashStats } from "./rtk/stats.js";

export default function rtkBashExtension(pi: ExtensionAPI) {
  const stats = createRtkBashStats();
  const rewrite = new RtkRewriteService(stats);
  const services = { rewrite, stats };

  registerRtkBashTool(pi, services);
  registerPromptGuidance(pi);
  registerCommands(pi, services);

  pi.on("session_start", () => {
    applySavedSettings(pi);
  });
}
