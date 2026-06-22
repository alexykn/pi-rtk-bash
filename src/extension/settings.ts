import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RTK_BASH_TOOL_NAME } from "../pi-tools/bash.js";

const SETTINGS_FILE_NAME = "pi-rtk-bash-settings.json";
const MANAGED_TOOLS = [RTK_BASH_TOOL_NAME, "bash", "exec_command", "write_stdin"];

export interface RtkBashSettings {
  disabledTools?: string[];
}

function getSettingsPath(): string {
  return path.join(getAgentDir(), SETTINGS_FILE_NAME);
}

export function saveSettings(pi: ExtensionAPI): void {
  const active = new Set(pi.getActiveTools());
  const disabledTools = MANAGED_TOOLS.filter(name => !active.has(name));

  try {
    const settingsPath = getSettingsPath();
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify({ disabledTools }, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save pi-rtk-bash settings:", error);
  }
}

export function applySavedSettings(pi: ExtensionAPI): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) {
      return;
    }
    const content = fs.readFileSync(settingsPath, "utf8");
    const settings: RtkBashSettings = JSON.parse(content);
    
    if (Array.isArray(settings.disabledTools)) {
      const active = new Set(pi.getActiveTools());
      let changed = false;
      
      for (const toolName of settings.disabledTools) {
        if (active.has(toolName)) {
          active.delete(toolName);
          changed = true;
        }
      }
      
      if (changed) {
        pi.setActiveTools([...active]);
      }
    }
  } catch (error) {
    console.error("Failed to load/apply pi-rtk-bash settings:", error);
  }
}
