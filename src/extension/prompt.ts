import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RTK_BASH_TOOL_NAME } from "../pi-tools/bash.js";

const SHELL_GUIDANCE = `Shell tool policy:
- Prefer rtk_bash for almost all one-shot terminal commands because pi-rtk-bash routes rtk_bash through RTK and is more context-efficient.
- Use rtk_bash for git, cargo, ruff, ty, tests, builds, linters, grep/rg, find, cat/read, and general shell inspection.
- Prefer rtk_bash over built-in bash and exec_command for ordinary one-shot commands.
- Use rtk_bash pure_execution=true only when RTK rewriting causes a concrete issue and exact raw bash behavior is required.
- Use rtk_bash metadata=true only when debugging rewrite behavior; leave it false for normal token-saving use.
- Use exec_command only for persistent/background/session commands such as dev servers, watchers, REPLs, or commands needing later write_stdin.
- Do not use exec_command or built-in bash for ordinary one-shot commands just because they are available.
- Use write_stdin only for processes started by exec_command.`;

export function registerPromptGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const selectedTools = getSelectedTools(event.systemPromptOptions?.selectedTools, pi.getActiveTools());
    if (!selectedTools.includes(RTK_BASH_TOOL_NAME)) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${SHELL_GUIDANCE}` };
  });
}

function getSelectedTools(selectedTools: unknown, activeTools: string[]): string[] {
  if (!Array.isArray(selectedTools)) return activeTools;
  return selectedTools.filter((tool): tool is string => typeof tool === "string");
}
