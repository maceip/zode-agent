// Layer 5 — Execution substrate. Source: moejs properties (disposable isolate per
// task, host-granted capabilities only, external interrupt, hard budgets).
//
// Plain security statement: each job runs in a separate child process. The child
// process runs under Node --permission (file access denied) and, on macOS,
// sandbox-exec (network, process spawning, file writes denied). The parent kills
// the child process on timeout. Host capabilities cross the boundary as named
// JSON RPC calls only. Residual risk: without sandbox-exec (non-macOS), a vm
// escape could still reach the network; production on other platforms needs an
// OS jail, moejs, or WASM.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSpan, type Hook } from "../effects/spans.ts";

export interface IsolateResult { value: unknown; logs: string[]; jail: string; }

const workerPath = fileURLToPath(new URL("./isolate-worker.ts", import.meta.url));
import { dirname } from "node:path";
const readableRoots = ["/usr", "/System", "/Library", "/dev", "/private/var", dirname(dirname(process.execPath)), dirname(workerPath)];
const SANDBOX_PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal "${process.execPath}"))
(allow signal (target others))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read* ${readableRoots.map((r) => `(subpath "${r}")`).join(" ")})
(allow file-write-data (literal "/dev/null"))
(deny network*)`;

// Probe for real: sandbox-exec exists on macOS but sandbox_apply fails when the
// parent already runs inside a sandbox (nested sandboxes are denied), or when the
// restricted profile aborts under hardened runtime.
const hasSandboxExec = process.platform === "darwin"
  && spawnSync("sandbox-exec", ["-p", SANDBOX_PROFILE, process.execPath, "-e", ""]).status === 0;

export async function runInIsolate(
  code: string,
  opts: {
    capabilities?: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;
    globals?: Record<string, unknown>;
    timeoutMs?: number;
    maxOutputChars?: number;
    hooks?: Hook[];
  } = {},
): Promise<IsolateResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxOutputChars = opts.maxOutputChars ?? 100_000;
  const capabilities = opts.capabilities ?? {};
  return runSpan({ kind: "exec", name: "isolate", input: code }, async () => {
    const nodeArgs = ["--permission", `--allow-fs-read=${workerPath}`, workerPath];
    const jail = hasSandboxExec ? "sandbox-exec+node-permission" : "node-permission";
    const child = hasSandboxExec
      ? spawn("sandbox-exec", ["-p", SANDBOX_PROFILE, process.execPath, ...nodeArgs], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } })
      : spawn(process.execPath, nodeArgs, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });

    return await new Promise<IsolateResult>((resolve, reject) => {
      let out = "", err = "", done = false;
      const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); child.kill("SIGKILL"); fn(); } };
      const timer = setTimeout(() => finish(() => reject(new Error(`isolate timed out after ${timeoutMs}ms (process killed)`))), timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.length > maxOutputChars + 65_536) return finish(() => reject(new Error("isolate output exceeded budget")));
        let nl: number;
        while ((nl = out.indexOf("\n")) >= 0) {
          const line = out.slice(0, nl); out = out.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: { type?: string; id?: number; name?: string; args?: unknown[]; value?: unknown; logs?: string[]; error?: string };
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "cap") {
            const fn = capabilities[msg.name ?? ""];
            void (async () => {
              try {
                if (!fn) throw new Error(`capability not granted: ${msg.name}`);
                const value: unknown = await fn(...(msg.args ?? []));
                child.stdin.write(JSON.stringify({ type: "cap-result", id: msg.id, value: value ?? null }) + "\n");
              } catch (e) {
                child.stdin.write(JSON.stringify({ type: "cap-result", id: msg.id, error: (e as Error).message }) + "\n");
              }
            })();
          } else if (msg.type === "result") {
            if (msg.error) finish(() => reject(new Error(`isolate error: ${msg.error}`)));
            else if (JSON.stringify(msg.value ?? null).length > maxOutputChars) finish(() => reject(new Error("isolate result exceeded budget")));
            else finish(() => resolve({ value: msg.value ?? null, logs: msg.logs ?? [], jail }));
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e) => finish(() => reject(e)));
      child.on("exit", (exitCode) => finish(() => reject(new Error(`isolate exited (${exitCode}) without result: ${err.slice(-500)}`))));
      child.stdin.write(JSON.stringify({ type: "run", code, globals: opts.globals ?? {} }) + "\n");
    });
  }, opts.hooks ?? []);
}
