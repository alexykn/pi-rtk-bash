import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withCodePreviewShell } from "pi-code-previews";
import { createRtkBashToolDefinition } from "../src/pi-tools/bash.ts";
import { runRtk } from "../src/rtk/binary.ts";
import { getRecoverableRtkError } from "../src/rtk/errors.ts";
import { RtkRewriteService } from "../src/rtk/rewrite.ts";
import { createRtkBashStats } from "../src/rtk/stats.ts";

test("current RTK rewrite and decorated execution compatibility", async (t) => {
  const version = await runRtk(["--version"], { timeoutMs: 5000 });
  assert.equal(version.code, 0);
  t.diagnostic(version.stdout.trim());
  const cwd = await mkdtemp(path.join(tmpdir(), "rtk-compat-"));
  const stats = createRtkBashStats();
  const rewrite = new RtkRewriteService(stats);
  const tool = withCodePreviewShell(createRtkBashToolDefinition({ stats, rewrite }));
  const execute = (command, extra = {}) => tool.execute(
    "rtk-compat", { command, metadata: true, ...extra }, undefined, undefined, { cwd },
  );
  try {
    await writeFile(path.join(cwd, "fixture.txt"), "compatibility fixture\n");

    await t.test("rewrite stdout remains usable with allowed or ask exit status", async () => {
      const result = await runRtk(["rewrite", "git status"], { cwd });
      assert.ok([0, 3].includes(result.code));
      assert.match(result.stdout, /rtk git status/);
      const decision = await rewrite.rewrite("git status", { cwd });
      assert.equal(decision.kind, "rewritten");
      assert.equal(decision.command, result.stdout.trim());
    });

    await t.test("unsupported commands pass through with raw output", async () => {
      const result = await execute("printf 'passthrough fixture\\n'");
      assert.match(result.content[0].text, /passthrough fixture/);
      assert.equal(result.details.rtk_bash.rewrite_kind, "passthrough");
    });

    await t.test("supported commands execute through RTK with metadata", async () => {
      const result = await execute("ls");
      assert.match(result.content[0].text, /fixture\.txt/);
      assert.equal(result.details.rtk_bash.rewrite_kind, "rewritten");
      assert.match(result.details.rtk_bash.executed_command, /rtk ls/);
    });

    await t.test("command lists and display pipelines remain compactable", async () => {
      for (const command of ["cd . && ls", "find . -type f | sort | head -20"]) {
        const result = await execute(command);
        assert.match(result.content[0].text, /fixture\.txt/);
        assert.equal(result.details.rtk_bash.rewrite_kind, "rewritten");
      }
    });

    await t.test("native find output-format flags still execute correctly", async () => {
      const result = await execute("find . -type f -printf '%f\\n'");
      assert.match(result.content[0].text, /^fixture\.txt\n/);
    });

    await t.test("pure execution bypasses rewriting and keeps metadata opt-in", async () => {
      const before = stats.rewrites;
      const result = await execute("printf 'pure fixture\\n'", { pure_execution: true, metadata: false });
      assert.equal(result.content[0].text, "pure fixture\n");
      assert.equal(result.details?.rtk_bash, undefined);
      assert.equal(stats.rewrites, before);
    });

    await t.test("real command errors remain visible", async () => {
      await assert.rejects(() => execute("printf 'failure fixture\\n'; exit 7"), /failure fixture|7/);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the older RTK find fallback stays narrowly matched", () => {
  const error = getRecoverableRtkError("rtk find does not support compound predicates or actions. Use find directly");
  assert.equal(error?.id, "rtk-find-unsupported-predicate");
  assert.equal(getRecoverableRtkError("find: invalid predicate"), undefined);
  assert.equal(getRecoverableRtkError("rtk: unrelated command failure"), undefined);
});
