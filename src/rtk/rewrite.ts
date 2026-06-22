import { isAlreadyRtkCommand } from "./command.js";
import { MissingRtkError, runRtk } from "./binary.js";
import type { RtkBashStats } from "./stats.js";

const DEFAULT_REWRITE_TIMEOUT_MS = 2_000;
const MAX_LOCAL_REWRITE_SEGMENTS = 8;

const COMPACT_DISCOVERY_COMMANDS = new Set(["find", "grep", "ls", "rg", "tree"]);
const FIND_UNSAFE_OPTIONS = new Set(["-delete", "-exec", "-execdir", "-fprint", "-fprint0", "-fls", "-ok", "-okdir", "-print0", "-printf"]);
const SEARCH_UNSAFE_LONG_OPTIONS = new Set([
  "--count",
  "--files",
  "--files-with-matches",
  "--files-without-match",
  "--json",
  "--null",
  "--only-matching",
]);
const SEARCH_UNSAFE_SHORT_OPTIONS = new Set(["0", "c", "l", "L", "o"]);

export type RtkRewriteSource = "rtk" | "local_command_list" | "local_display_pipeline";

export type RewriteDecision =
  | {
      kind: "already_rtk";
      command: string;
      originalCommand: string;
      fallbackAllowed: false;
    }
  | {
      kind: "rewritten";
      command: string;
      originalCommand: string;
      source: RtkRewriteSource;
      fallbackAllowed: true;
    }
  | {
      kind: "passthrough";
      command: string;
      originalCommand: string;
      reason: "unsupported" | "rewrite_failed";
      fallbackAllowed: false;
    };

export type RewriteOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type LocalRewrite = {
  command: string;
  source: Exclude<RtkRewriteSource, "rtk">;
};

export class RtkRewriteService {
  constructor(private readonly stats: RtkBashStats) {}

  async rewrite(command: string, options: RewriteOptions = {}): Promise<RewriteDecision> {
    if (isAlreadyRtkCommand(command)) {
      this.stats.alreadyRtk++;
      return { kind: "already_rtk", command, originalCommand: command, fallbackAllowed: false };
    }

    try {
      const displayPipelineRewrite = await this.rewriteDisplayPipeline(command, options);
      if (displayPipelineRewrite) {
        this.recordRewrite(displayPipelineRewrite.source);
        return {
          kind: "rewritten",
          command: displayPipelineRewrite.command,
          originalCommand: command,
          source: displayPipelineRewrite.source,
          fallbackAllowed: true,
        };
      }

      const result = await runRtk(["rewrite", command], {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_REWRITE_TIMEOUT_MS,
      });

      const rewritten = result.stdout.trim();
      if (rewritten.length > 0) {
        this.recordRewrite("rtk");
        return { kind: "rewritten", command: rewritten, originalCommand: command, source: "rtk", fallbackAllowed: true };
      }

      if (result.code === 1 && rewritten.length === 0) {
        const locallyRewritten = await this.rewriteUnsupportedCompoundCommand(command, options);
        if (locallyRewritten) {
          this.recordRewrite(locallyRewritten.source);
          return {
            kind: "rewritten",
            command: locallyRewritten.command,
            originalCommand: command,
            source: locallyRewritten.source,
            fallbackAllowed: true,
          };
        }

        this.stats.passthroughs++;
        return { kind: "passthrough", command, originalCommand: command, reason: "unsupported", fallbackAllowed: false };
      }

      this.stats.rewriteFailures++;
      return { kind: "passthrough", command, originalCommand: command, reason: "rewrite_failed", fallbackAllowed: false };
    } catch (error) {
      if (error instanceof MissingRtkError) {
        this.stats.missingRtkErrors++;
        throw error;
      }

      this.stats.rewriteFailures++;
      return { kind: "passthrough", command, originalCommand: command, reason: "rewrite_failed", fallbackAllowed: false };
    }
  }

  private recordRewrite(source: RtkRewriteSource): void {
    this.stats.rewrites++;
    this.stats.rewriteBySource[source] = (this.stats.rewriteBySource[source] ?? 0) + 1;
  }

  private async rewriteUnsupportedCompoundCommand(command: string, options: RewriteOptions): Promise<LocalRewrite | undefined> {
    const displayPipelineRewrite = await this.rewriteDisplayPipeline(command, options);
    if (displayPipelineRewrite) return displayPipelineRewrite;

    return this.rewriteTopLevelCommandList(command, options);
  }

  private async rewriteDisplayPipeline(command: string, options: RewriteOptions): Promise<LocalRewrite | undefined> {
    if (isUnsafeForLocalRewrite(command)) return undefined;

    const pipeline = splitTopLevel(command, "|");
    if (!pipeline || pipeline.commands.length < 2) return undefined;

    const firstCommand = pipeline.commands[0];
    if (!isCompactDiscoveryCommand(firstCommand)) return undefined;
    if (hasTopLevelRedirection(firstCommand)) return undefined;
    if (hasUnsafeDiscoveryOptions(firstCommand)) return undefined;
    if (!pipeline.commands.slice(1).every(isDisplayOnlyPipelineCommand)) return undefined;

    const rewritten = await this.rewriteCommandSegment(firstCommand, options);
    return rewritten.changed ? { command: rewritten.command, source: "local_display_pipeline" } : undefined;
  }

  private async rewriteTopLevelCommandList(command: string, options: RewriteOptions): Promise<LocalRewrite | undefined> {
    if (isUnsafeForLocalRewrite(command)) return undefined;

    const list = splitTopLevelCommandList(command);
    if (!list || list.commands.length < 2 || list.commands.length > MAX_LOCAL_REWRITE_SEGMENTS) return undefined;

    const rewrittenCommands: string[] = [];
    let changed = false;
    for (const segment of list.commands) {
      const rewritten = await this.rewriteCommandSegment(segment, options);
      rewrittenCommands.push(rewritten.command);
      changed ||= rewritten.changed;
    }

    if (!changed) return undefined;

    let rewritten = rewrittenCommands[0] ?? "";
    for (const [index, operator] of list.operators.entries()) {
      rewritten += ` ${operator} ${rewrittenCommands[index + 1]}`;
    }

    return { command: rewritten, source: "local_command_list" };
  }

  private async rewriteCommandSegment(command: string, options: RewriteOptions): Promise<{ command: string; changed: boolean }> {
    const trimmed = command.trim();
    if (trimmed.length === 0 || isAlreadyRtkCommand(trimmed)) {
      return { command: trimmed, changed: false };
    }

    const result = await runRtk(["rewrite", trimmed], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_REWRITE_TIMEOUT_MS,
    });

    const rewritten = result.stdout.trim();
    if (rewritten.length > 0) return { command: rewritten, changed: true };

    const displayPipelineRewrite = await this.rewriteDisplayPipeline(trimmed, options);
    return displayPipelineRewrite ? { command: displayPipelineRewrite.command, changed: true } : { command: trimmed, changed: false };
  }
}

type SplitResult = {
  commands: string[];
  operators: string[];
};

function splitTopLevelCommandList(command: string): SplitResult | undefined {
  return splitTopLevel(command, "&&", "||", ";");
}

function splitTopLevel(command: string, ...operators: string[]): SplitResult | undefined {
  const commands: string[] = [];
  const foundOperators: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let parenDepth = 0;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "{" || char === "[") {
      parenDepth++;
      continue;
    }

    if (char === ")" || char === "}" || char === "]") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (parenDepth > 0) continue;

    const operator = operators.find((candidate) => {
      if (!command.startsWith(candidate, index)) return false;
      return candidate !== "|" || (command[index + 1] !== "|" && command[index + 1] !== "&");
    });
    if (!operator) continue;

    const segment = command.slice(start, index).trim();
    if (segment.length === 0) return undefined;

    commands.push(segment);
    foundOperators.push(operator);
    index += operator.length - 1;
    start = index + 1;
  }

  if (quote || escaped) return undefined;

  const finalSegment = command.slice(start).trim();
  if (finalSegment.length === 0) return undefined;

  commands.push(finalSegment);
  return { commands, operators: foundOperators };
}

function isUnsafeForLocalRewrite(command: string): boolean {
  return command.includes("\n") || command.includes("<<");
}

function hasTopLevelRedirection(command: string): boolean {
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let parenDepth = 0;

  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "{" || char === "[") {
      parenDepth++;
      continue;
    }

    if (char === ")" || char === "}" || char === "]") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (parenDepth === 0 && (char === ">" || char === "<")) return true;
  }

  return false;
}

function isDisplayOnlyPipelineCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    /^sort(?:\s+[-\w]+)*$/.test(trimmed) ||
    /^uniq(?:\s+[-\w]+)*$/.test(trimmed) ||
    /^head(?:\s+(?:-n\s+)?\d+|\s+-\d+)?$/.test(trimmed) ||
    /^tail(?:\s+(?:-n\s+)?\d+|\s+-\d+)?$/.test(trimmed) ||
    /^sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?$/.test(trimmed)
  );
}

function isCompactDiscoveryCommand(command: string): boolean {
  const commandName = getCommandName(command);
  return commandName !== undefined && COMPACT_DISCOVERY_COMMANDS.has(commandName);
}

function hasUnsafeDiscoveryOptions(command: string): boolean {
  const commandName = getCommandName(command);
  const tokens = tokenizeShellWords(command);
  if (!commandName || !tokens) return true;

  if (commandName === "find") {
    return tokens.some((token) => FIND_UNSAFE_OPTIONS.has(token));
  }

  if (commandName === "grep" || commandName === "rg") {
    return tokens.some((token) => SEARCH_UNSAFE_LONG_OPTIONS.has(token) || hasUnsafeSearchShortOption(token));
  }

  return false;
}

function hasUnsafeSearchShortOption(token: string): boolean {
  if (!token.startsWith("-") || token.startsWith("--")) return false;
  return [...token.slice(1)].some((flag) => SEARCH_UNSAFE_SHORT_OPTIONS.has(flag));
}

function getCommandName(command: string): string | undefined {
  const tokens = tokenizeShellWords(command);
  if (!tokens) return undefined;

  for (const token of tokens) {
    if (/^\w+=/.test(token)) continue;
    if (token === "command" || token === "builtin") continue;
    return token;
  }

  return undefined;
}

function tokenizeShellWords(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote || escaped) return undefined;
  if (current.length > 0) tokens.push(current);
  return tokens;
}
