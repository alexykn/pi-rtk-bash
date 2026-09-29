import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { createRtkBashToolDefinition } from "../src/pi-tools/bash.ts";
import { registerRtkBashTool } from "../src/pi-tools/registry.ts";
import rtkBashExtension from "../src/index.ts";
import { RtkRewriteService } from "../src/rtk/rewrite.ts";
import { createRtkBashStats } from "../src/rtk/stats.ts";

function createServices() {
  const stats = createRtkBashStats();
  return { stats, rewrite: new RtkRewriteService(stats) };
}

test("preview decoration retains the executable tool contract", async () => {
  initTheme("dark");
  const services = createServices();
  const original = createRtkBashToolDefinition(services);
  const decorated = withCodePreviewShell(original, { mode: "border" });
  for (const key of Object.keys(original)) {
    if (!["renderShell", "renderCall", "renderResult"].includes(key)) {
      assert.strictEqual(decorated[key], original[key], key);
    }
  }
  assert.equal(decorated.renderShell, "self");
  assert.equal(typeof decorated.renderCall, "function");
  assert.equal(typeof decorated.renderResult, "function");

  const result = await decorated.execute("preview-test", {
    command: "printf 'raw output\\n'", pure_execution: true, metadata: true,
  }, undefined, undefined, {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "preview-test", getSessionFile: () => undefined },
  });
  assert.match(result.content[0].text, /raw output/);
  assert.equal(result.details.rtk_bash.rewrite_kind, "pure_execution");
  assert.equal(services.stats.pureExecutions, 1);
  assert.equal(services.stats.rewrites, 0);

  const theme = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
  };
  const context = {
    args: { command: "printf 'raw output\\n'" },
    toolCallId: "preview-test",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  };
  const call = decorated.renderCall(context.args, theme, context);
  assert.match(call.render(100).join("\n"), /printf/);
  decorated.renderResult(result, { expanded: true, isPartial: false }, theme, {
    ...context, executionStarted: true,
  });
  assert.match(call.render(100).join("\n"), /raw output/);
});

test("registration decorates only rtk_bash", () => {
  const tools = [];
  registerRtkBashTool({ registerTool: (tool) => tools.push(tool) }, createServices());
  assert.deepEqual(tools.map((tool) => tool.name), ["rtk_bash"]);
  assert.equal(typeof tools[0].renderCall, "function");
  assert.equal(typeof tools[0].renderResult, "function");
});

test("decorated execution preserves the older RTK find fallback and metadata", async () => {
  const services = createServices();
  services.rewrite.rewrite = async (command) => ({
    kind: "rewritten",
    command: "printf 'rtk find does not support compound predicates or actions. Use find directly\\n'; exit 1",
    originalCommand: command,
    source: "rtk",
    fallbackAllowed: true,
  });
  const tool = withCodePreviewShell(createRtkBashToolDefinition(services));
  const command = "printf 'native fallback\\n'";
  const result = await tool.execute("fallback-test", { command, metadata: true },
    undefined, undefined, {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "fallback-test", getSessionFile: () => undefined },
    });
  assert.match(result.content[0].text, /^native fallback\n/);
  assert.doesNotMatch(result.content[0].text, /does not support/);
  assert.equal(result.details.rtk_bash.executed_command, command);
  assert.equal(result.details.rtk_bash.fallback.reason, "rtk-find-unsupported-predicate");
  assert.equal(services.stats.fallbackByReason["rtk-find-unsupported-predicate"], 1);
});

test("extension loads global preview settings before registering the shell", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "rtk-preview-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousMode = process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
  try {
    await writeFile(path.join(agentDir, "code-previews.json"), JSON.stringify({ toolCallBackground: "border" }));
    const tools = [];
    const events = [];
    await rtkBashExtension({
      registerTool: (tool) => tools.push(tool),
      registerCommand() {},
      on: (event) => events.push(event),
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "rtk_bash");
    assert.equal(tools[0].renderShell, "self");
    assert.ok(events.includes("session_start"));
    assert.ok(events.includes("before_agent_start"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousMode === undefined) delete process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
    else process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = previousMode;
    await loadCodePreviewSettings();
    await rm(agentDir, { recursive: true, force: true });
  }
});
