import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RTK_BASH_TOOL_NAME } from "../pi-tools/bash.js";
import { runRtk } from "../rtk/binary.js";
import type { RtkBashStats } from "../rtk/stats.js";
import { toErrorMessage } from "../shared/errors.js";
import { saveSettings } from "./settings.js";

export type CommandServices = {
  stats: RtkBashStats;
};

export function registerCommands(pi: ExtensionAPI, services: CommandServices) {
  pi.registerCommand("rtk-bash", {
    description: "Open the pi-rtk-bash tool visibility menu. Usage: /rtk-bash [menu|status|enable]",
    handler: async (args, ctx) => {
      const action = args.trim() || "menu";
      if (action === "menu") {
        await openToolVisibilityMenu(pi, services.stats, ctx.ui);
        return;
      }

      if (action === "enable") {
        const active = pi.getActiveTools();
        pi.setActiveTools([...new Set([...active, RTK_BASH_TOOL_NAME])]);
        saveSettings(pi);
        ctx.ui.notify("pi-rtk-bash: rtk_bash is active. built-in bash, exec_command, and write_stdin were left unchanged.", "info");
        return;
      }

      if (action !== "status") {
        ctx.ui.notify(`Unknown /rtk-bash action: ${action}. Use menu, status, or enable.`, "warning");
        return;
      }

      ctx.ui.notify(await buildStatus(pi, services.stats), "info");
    },
  });
}

async function openToolVisibilityMenu(
  pi: ExtensionAPI,
  stats: RtkBashStats,
  ui: { select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, type?: "info" | "warning" | "error" | "success"): void },
) {
  while (true) {
    const active = new Set(pi.getActiveTools());
    const choice = await ui.select("pi-rtk-bash tool visibility", [
      `rtk_bash: ${active.has(RTK_BASH_TOOL_NAME) ? "visible" : "hidden"} — toggle`,
      `built-in bash: ${active.has("bash") ? "visible" : "hidden"} — toggle`,
      `exec_command + write_stdin: ${areSessionToolsActive(active) ? "visible" : "hidden"} — toggle`,
      "show status",
      "done",
    ]);

    if (!choice || choice === "done") return;

    if (choice.startsWith("rtk_bash:")) {
      toggleTools(pi, [RTK_BASH_TOOL_NAME]);
      continue;
    }

    if (choice.startsWith("built-in bash:")) {
      toggleTools(pi, ["bash"]);
      continue;
    }

    if (choice.startsWith("exec_command + write_stdin:")) {
      toggleTools(pi, ["exec_command", "write_stdin"]);
      continue;
    }

    if (choice === "show status") {
      ui.notify(await buildStatus(pi, stats), "info");
    }
  }
}

function areSessionToolsActive(active: Set<string>): boolean {
  return active.has("exec_command") || active.has("write_stdin");
}

function toggleTools(pi: ExtensionAPI, toolNames: string[]) {
  const active = new Set(pi.getActiveTools());
  const shouldHide = toolNames.some((toolName) => active.has(toolName));

  for (const toolName of toolNames) {
    if (shouldHide) {
      active.delete(toolName);
      continue;
    }

    active.add(toolName);
  }

  pi.setActiveTools([...active]);
  saveSettings(pi);
}

async function buildStatus(pi: ExtensionAPI, stats: RtkBashStats): Promise<string> {
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools();
  const rtkBash = tools.find((tool) => tool.name === RTK_BASH_TOOL_NAME);
  const bash = tools.find((tool) => tool.name === "bash");
  const execCommand = tools.find((tool) => tool.name === "exec_command");
  const writeStdin = tools.find((tool) => tool.name === "write_stdin");
  const rtk = await getRtkStatus();
  const fallbackLines = Object.entries(stats.fallbackByReason).map(([reason, count]) => `    ${reason}: ${count}`);
  const rewriteSourceLines = Object.entries(stats.rewriteBySource).map(([source, count]) => `      ${source}: ${count}`);

  return [
    "pi-rtk-bash status",
    `  rtk: ${rtk}`,
    `  rtk_bash: ${active.has(RTK_BASH_TOOL_NAME) ? "active" : "inactive"}${formatSource(rtkBash)}`,
    `  bash: ${active.has("bash") ? "active" : "inactive"}${formatSource(bash)}`,
    `  exec_command: ${active.has("exec_command") ? "active" : "inactive"}${formatSource(execCommand)}`,
    `  write_stdin: ${active.has("write_stdin") ? "active" : "inactive"}${formatSource(writeStdin)}`,
    "  stats:",
    `    rewrites: ${stats.rewrites}`,
    "    rewrite_sources:",
    ...(rewriteSourceLines.length > 0 ? rewriteSourceLines : ["      none"]),
    `    passthroughs: ${stats.passthroughs}`,
    `    already_rtk: ${stats.alreadyRtk}`,
    `    pure_executions: ${stats.pureExecutions}`,
    `    rewrite_failures: ${stats.rewriteFailures}`,
    `    missing_rtk_errors: ${stats.missingRtkErrors}`,
    "    fallbacks:",
    ...(fallbackLines.length > 0 ? fallbackLines : ["      none"]),
  ].join("\n");
}

async function getRtkStatus(): Promise<string> {
  try {
    const result = await runRtk(["--version"], { timeoutMs: 2_000 });
    const version = (result.stdout || result.stderr).trim().split("\n")[0];
    return version || `available (exit ${result.code ?? "unknown"})`;
  } catch (error) {
    return `unavailable (${toErrorMessage(error).split("\n")[0]})`;
  }
}

function formatSource(tool: { sourceInfo?: { source?: string; path?: string } } | undefined): string {
  if (!tool?.sourceInfo) return "";
  const source = tool.sourceInfo.source ?? "unknown";
  const path = tool.sourceInfo.path ? ` ${tool.sourceInfo.path}` : "";
  return ` (${source}${path})`;
}
