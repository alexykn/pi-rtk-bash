# pi-rtk-bash

Pi extension that adds an RTK-backed `rtk_bash` one-shot shell runner to save tokens on regular bash commands. It sends shell commands through RTK's official rewrite path, runs compactable commands through RTK, and falls back to normal Pi bash when RTK has no rewrite.

## What this does

- Registers a tool named `rtk_bash`.
- Sends each one-shot bash command through `rtk rewrite`.
- Executes the rewritten command with Pi's normal local bash backend.
- Runs the original command unchanged when RTK has no rewrite.
- Adds a narrow local rewrite layer for common display-only pipelines and simple command lists that RTK does not rewrite itself.
- Reruns the original command when a rewritten command fails with a known RTK unsupported-command error.
- Supports `pure_execution=true` to bypass RTK for exact raw bash behavior when needed.
- Supports `metadata=true` to include rewrite debugging metadata when needed.
- Leaves built-in `bash`, `exec_command`, and `write_stdin` available unless you hide them from the agent with `/rtk-bash`.
- Injects shell guidance that strongly prefers `rtk_bash` for one-shot terminal work.

## Why

RTK can compact many noisy development commands, including common `git`, `cargo`, `ruff`, `find`, `grep`, `read`, and related workflows. RTK's normal Pi integration is hook-based, so it only helps when commands pass through the hooked Pi Bash path.

When `@howaboua/pi-codex-conversion` is active, many shell calls use Codex-style `exec_command` instead. Those calls are useful for background/session workflows, but they may bypass RTK's Pi hook and return large raw output. `pi-rtk-bash` fills the reliable part of that gap by adding an explicit `rtk_bash` tool while preserving `exec_command` for the cases where persistent process control is actually needed.

## Tool philosophy

```text
rtk_bash      -> RTK-backed one-shot shell, preferred for context efficiency
bash          -> normal Pi bash, optional fallback
exec_command  -> Codex session/background shell, only for persistent processes
write_stdin   -> only for processes started by exec_command
```

Use `rtk_bash` for ordinary one-shot terminal work:

- git inspection, diffs, logs, status
- builds and checks
- tests
- linters and format checks
- type checks
- search and filesystem inspection
- short project commands

Use `exec_command` only for:

- long-running dev servers
- watchers
- REPL-like processes
- commands requiring later `write_stdin`
- real background/session process control

## Requirements

Install RTK first and make sure it is on `PATH`:

```sh
rtk --help
```

If `rtk` is missing, `rtk_bash` returns an actionable error instead of silently falling back to raw shell output. This avoids giving the impression that RTK savings are active when they are not.

## Install

```sh
pi install npm:pi-rtk-bash
```

Or test for one run:

```sh
pi -e npm:pi-rtk-bash
```

Local development:

```sh
pi -e ~/github/pi-rtk-bash
```

## Behavior

`pi-rtk-bash` does not prefix every command with `rtk`. It asks RTK to rewrite the full shell command:

```text
original command -> rtk rewrite -> rewritten command or passthrough
```

Examples:

```sh
git status
# may run as:
rtk git status
```

```sh
cd crates/foo && cargo check
# may run as:
cd crates/foo && rtk cargo check
```

```sh
RUST_BACKTRACE=1 cargo test parser::tests::case -- --nocapture
# may run as:
RUST_BACKTRACE=1 rtk cargo test parser::tests::case -- --nocapture
```

```sh
cat <<'EOF' > file.txt
hello
EOF
# no RTK rewrite, runs unchanged
```

This preserves shell behavior for compound commands better than blind prefixing. RTK's rewrite command is treated as the primary parser and source of truth.

When RTK has no rewrite for a compound command, `pi-rtk-bash` applies a conservative local rewrite layer for common token-saving shapes:

- display-only pipelines such as `find . -type f | sort | head -20`
- simple top-level command lists such as `cd src && find . -type f | head`

The local layer is intentionally narrow. It skips multiline commands, heredocs, redirections, side-effecting `find` actions, output-format flags like `--json`/`-o`/`-c`, and arbitrary data-processing pipelines.

If RTK rewriting causes a concrete issue the agent may pass `pure_execution=true` to run the command through plain local bash. The Agent may also pass `metadata=true` to debug rewrite behavior; it includes the original command, executed command, rewrite kind/source, and fallback info in the result.

## Fallback behavior

If RTK has no rewrite, the original command runs unchanged.

If RTK rewrites a command but the rewritten command fails with a known RTK unsupported-command error, `pi-rtk-bash` discards the rewritten command output and reruns the original command through normal Pi bash.

The initial recoverable fallback list is intentionally narrow:

- `rtk find does not support compound predicates or actions ... Use find directly`

This handles cases where RTK rewrites a valid native `find` invocation into `rtk find`, but `rtk find` later rejects predicates/actions that native `find` supports.

Other command failures are returned normally.

## Adaptive prompt guidance

`pi-rtk-bash` always gives the `rtk_bash` tool a static description that explains the RTK-backed one-shot workflow. It also uses Pi's `before_agent_start` hook to add shell guidance when `rtk_bash` is active.

The guidance explicitly tells the agent to use `rtk_bash` for normal one-shot commands and reserve `exec_command`/`write_stdin` for persistent/background/session processes.

It also tells the agent to use `pure_execution=true` only when RTK rewriting causes a real problem, and `metadata=true` only when debugging rewrite behavior.

## Commands

```text
/rtk-bash
```

Opens a menu where you can toggle whether the agent can see `rtk_bash`, built-in `bash`, and `exec_command`/`write_stdin`.

```text
/rtk-bash status
```

Shows RTK availability, relevant tool activation/source info, and simple rewrite/fallback counters.

```text
/rtk-bash enable
```

Ensures `rtk_bash` is active without disabling built-in `bash`, `exec_command`, `write_stdin`, or other active tools.

## Non-goals

- Does not implement a safety or policy shell.
- Does not block commands.
- Does not classify dangerous commands.
- Does not broadly parse or rewrite arbitrary shell.
- Does not apply local rewrites to commands with redirections, heredocs, known side-effecting `find` actions, or complex data-processing pipelines.
- Does not replace `exec_command`.
- Does not manage background sessions.
- Does not broadly retry arbitrary failed commands.
- Does not hide real command failures.
- Does not treat native command syntax errors as RTK errors.

## Security

Pi extensions run with your local user permissions. This extension executes commands through your local shell and invokes the `rtk` binary on `PATH`. Install both this package and RTK only from sources you trust.
