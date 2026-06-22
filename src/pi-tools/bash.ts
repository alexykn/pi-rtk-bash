import {
  type AgentToolResult,
  type BashToolDetails,
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getRecoverableRtkError } from "../rtk/errors.js";
import { incrementFallback, type RtkBashStats } from "../rtk/stats.js";
import type {
  RewriteDecision,
  RtkRewriteService,
  RtkRewriteSource,
} from "../rtk/rewrite.js";

export const RTK_BASH_TOOL_NAME = "rtk_bash";

export type RtkBashServices = {
  rewrite: RtkRewriteService;
  stats: RtkBashStats;
};

const rtkBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
  pure_execution: Type.Optional(
    Type.Boolean({
      description:
        "Bypass RTK rewriting and run plain local bash. Use only when RTK rewriting causes a real issue.",
    }),
  ),
  metadata: Type.Optional(
    Type.Boolean({
      description:
        "Include RTK rewrite metadata in the result. Default false to save tokens.",
    }),
  ),
});

export type RtkBashToolInput = Static<typeof rtkBashSchema>;

export type RtkBashExecutionMetadata = {
  pure_execution: boolean;
  original_command: string;
  executed_command: string;
  rewrite_kind: RewriteDecision["kind"] | "pure_execution";
  rewrite_source?: RtkRewriteSource;
  fallback?: {
    reason: string;
    executed_command: string;
  };
};

type RtkBashToolDetails = BashToolDetails & {
  rtk_bash?: RtkBashExecutionMetadata;
};

type RtkBashOperationHooks = {
  onDecision?: (decision: RewriteDecision) => void;
  onRecoverableFallback?: (decision: RewriteDecision, reason: string) => void;
};

const RTK_BASH_DESCRIPTION = [
  "Run one-shot shell commands through RTK for compact output.",
  "Prefer rtk_bash over built-in bash, exec_command, and write_stdin for almost all coding-agent terminal work, including git, cargo, ruff, ty, grep/rg, find, cat/read, tests, builds, and linters.",
  "This tool is optimized for context efficiency.",
  "It does not support persistent background sessions or interactive stdin.",
  "Set pure_execution=true only when RTK rewriting causes a real issue and the exact raw bash behavior is required.",
  "Set metadata=true only when debugging rewrite behavior because metadata adds output tokens.",
  "Use exec_command/write_stdin only when you genuinely need a persistent/background process or later stdin, such as dev servers, watchers, and REPLs.",
].join(" ");

const RTK_BASH_PROMPT_GUIDELINES = [
  "Use rtk_bash for ordinary one-shot shell commands because pi-rtk-bash routes them through RTK for compact output.",
  "Use rtk_bash for git inspection, diffs, builds, tests, linters, type checks, search, filesystem inspection, and short one-shot project commands.",
  "Prefer rtk_bash over built-in bash and exec_command for normal one-shot commands.",
  "Use rtk_bash pure_execution=true only after RTK rewriting causes a concrete problem; do not use it preemptively.",
  "Use rtk_bash metadata=true only when debugging what command RTK executed; keep it false for normal token-saving use.",
  "Use exec_command only for persistent/background processes, dev servers, watchers, REPLs, or commands that require later write_stdin.",
  "Use write_stdin only for processes started by exec_command.",
  "rtk_bash does not provide persistent background sessions or interactive stdin; choose exec_command for those cases.",
  "If cbm / codebase memory tools are availible still prefer them for codebase exploration",
];

export function createRtkBashOperations(
  services: RtkBashServices,
  hooks: RtkBashOperationHooks = {},
): BashOperations {
  const local = createLocalBashOperations();

  return {
    async exec(command, cwd, options) {
      const decision = await services.rewrite.rewrite(command, {
        cwd,
        env: options.env,
        signal: options.signal,
      });
      hooks.onDecision?.(decision);

      if (!decision.fallbackAllowed) {
        return local.exec(decision.command, cwd, options);
      }

      const bufferedOutput: Buffer[] = [];
      const rewrittenResult = await local.exec(decision.command, cwd, {
        ...options,
        onData: (data) => bufferedOutput.push(data),
      });

      const rewrittenText = Buffer.concat(bufferedOutput).toString("utf8");
      const recoverableError = getRecoverableRtkError(rewrittenText);
      if (rewrittenResult.exitCode !== 0 && recoverableError) {
        incrementFallback(services.stats, recoverableError.id);
        hooks.onRecoverableFallback?.(decision, recoverableError.id);
        return local.exec(decision.originalCommand, cwd, options);
      }

      for (const chunk of bufferedOutput) {
        options.onData(chunk);
      }

      return rewrittenResult;
    },
  };
}

export function createRtkBashToolDefinition(
  services: RtkBashServices,
): ToolDefinition<typeof rtkBashSchema, RtkBashToolDetails | undefined> {
  const base = createBashToolDefinition(process.cwd());

  return {
    ...base,
    name: RTK_BASH_TOOL_NAME,
    label: "RTK Bash",
    description: RTK_BASH_DESCRIPTION,
    parameters: rtkBashSchema,
    promptSnippet: "Run one-shot shell commands through RTK for compact output",
    promptGuidelines: RTK_BASH_PROMPT_GUIDELINES,
    prepareArguments(args: unknown): RtkBashToolInput {
      if (!args || typeof args !== "object" || Array.isArray(args))
        return args as RtkBashToolInput;

      const input = args as Record<string, unknown>;
      return {
        ...input,
        pure_execution: input.pure_execution ?? input.pureExecution,
        metadata:
          input.metadata ?? input.include_metadata ?? input.includeMetadata,
      } as RtkBashToolInput;
    },
    async execute(toolCallId, params: RtkBashToolInput, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const bashParams = { command: params.command, timeout: params.timeout };

      if (params.pure_execution) {
        services.stats.pureExecutions++;
        const metadata = createPureExecutionMetadata(params.command);
        const tool = createBashToolDefinition(cwd);
        const result = await tool.execute(
          toolCallId,
          bashParams,
          signal,
          onUpdate,
          ctx,
        );
        return params.metadata
          ? addExecutionMetadata(result, metadata)
          : result;
      }

      let metadata = createPassthroughMetadata(params.command);
      const operations = createRtkBashOperations(services, {
        onDecision: (decision) => {
          metadata = createDecisionMetadata(decision);
        },
        onRecoverableFallback: (decision, reason) => {
          metadata = {
            ...createDecisionMetadata(decision),
            executed_command: decision.originalCommand,
            fallback: { reason, executed_command: decision.originalCommand },
          };
        },
      });
      const tool = createBashToolDefinition(cwd, { operations });
      const result = await tool.execute(
        toolCallId,
        bashParams,
        signal,
        onUpdate,
        ctx,
      );
      return params.metadata ? addExecutionMetadata(result, metadata) : result;
    },
  };
}

function createPureExecutionMetadata(
  command: string,
): RtkBashExecutionMetadata {
  return {
    pure_execution: true,
    original_command: command,
    executed_command: command,
    rewrite_kind: "pure_execution",
  };
}

function createPassthroughMetadata(command: string): RtkBashExecutionMetadata {
  return {
    pure_execution: false,
    original_command: command,
    executed_command: command,
    rewrite_kind: "passthrough",
  };
}

function createDecisionMetadata(
  decision: RewriteDecision,
): RtkBashExecutionMetadata {
  return {
    pure_execution: false,
    original_command: decision.originalCommand,
    executed_command: decision.command,
    rewrite_kind: decision.kind,
    rewrite_source: decision.kind === "rewritten" ? decision.source : undefined,
  };
}

function addExecutionMetadata<TDetails>(
  result: AgentToolResult<TDetails>,
  metadata: RtkBashExecutionMetadata,
): AgentToolResult<TDetails & RtkBashToolDetails> {
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: `\n\n${formatExecutionMetadata(metadata)}` },
    ],
    details: { ...(result.details ?? {}), rtk_bash: metadata } as TDetails &
      RtkBashToolDetails,
  };
}

function formatExecutionMetadata(metadata: RtkBashExecutionMetadata): string {
  return [
    "[rtk_bash metadata]",
    `  pure_execution: ${metadata.pure_execution}`,
    `  rewrite_kind: ${metadata.rewrite_kind}`,
    ...(metadata.rewrite_source
      ? [`  rewrite_source: ${metadata.rewrite_source}`]
      : []),
    `  original_command: ${metadata.original_command}`,
    `  executed_command: ${metadata.executed_command}`,
    ...(metadata.fallback
      ? [
          `  fallback: ${metadata.fallback.reason}`,
          `  fallback_executed_command: ${metadata.fallback.executed_command}`,
        ]
      : []),
  ].join("\n");
}
