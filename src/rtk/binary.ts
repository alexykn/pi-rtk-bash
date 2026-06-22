import { spawn } from "node:child_process";

export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export class MissingRtkError extends Error {
  constructor() {
    super(formatMissingRtkError());
    this.name = "MissingRtkError";
  }
}

export function formatMissingRtkError(): string {
  return [
    "RTK is not available on PATH.",
    "",
    "Install RTK first, then restart Pi or run /reload.",
    "",
    "Expected command:",
    "  rtk --help",
    "",
    "pi-rtk-bash registers the rtk_bash tool and requires rtk for command rewriting.",
  ].join("\n");
}

export function runRtk(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("rtk", args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", abort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("RTK command aborted")));
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(error.code === "ENOENT" ? new MissingRtkError() : error));
    });
    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`RTK command timed out after ${options.timeoutMs}ms`));
          return;
        }
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });

    if (options.signal) {
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    }

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
  });
}
