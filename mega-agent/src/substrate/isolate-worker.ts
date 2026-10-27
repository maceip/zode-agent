// Runs inside the jailed child process. Reads one JSON request on stdin:
// {code, globals}. Agent code gets: console, cap(name, ...args) backed by the
// parent over stdout lines, and globals (data only). Nothing else.
// cap/console are created inside the vm realm: host-created functions would
// leak the host Function constructor via fn.constructor.
import vm from "node:vm";
import { createInterface } from "node:readline";

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let capSeq = 0;
function send(obj: unknown) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function hostCap(name: string, ...args: unknown[]): Promise<unknown> {
  const id = ++capSeq;
  send({ type: "cap", id, name, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const rl = createInterface({ input: process.stdin });
let started = false;
rl.on("line", async (line) => {
  let msg: { type?: string; id?: number; value?: unknown; error?: string; code?: string; globals?: Record<string, unknown> };
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "cap-result" && msg.id !== undefined) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (p) (msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.value));
    return;
  }
  if (started || msg.type !== "run") return;
  started = true;
  const logs: string[] = [];
  const sandbox: Record<string, unknown> = {
    __bridge: { cap: hostCap, log: (...a: unknown[]) => logs.push(a.map(String).join(" ")) },
    __globals: msg.globals ?? {},
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  // Realm-local wrappers, then the bridge global is deleted. Closures keep the
  // bridge alive for cap/console; agent code cannot reach closure variables.
  vm.runInContext(`
    "use strict";
    const __b = globalThis.__bridge;
    globalThis.cap = (name, ...args) => __b.cap(name, ...args);
    globalThis.console = { log: (...args) => __b.log(...args) };
    for (const [k, v] of Object.entries(globalThis.__globals)) globalThis[k] = v;
    delete globalThis.__bridge;
    delete globalThis.__globals;
    Object.defineProperty(globalThis, "constructor", { value: undefined, configurable: false });
  `, sandbox);
  try {
    const script = new vm.Script(`"use strict";\n(async () => {\n${msg.code ?? ""}\n})()`);
    // timeout covers synchronous execution; the parent hard-kills the process for async runaway code.
    const value: unknown = await script.runInContext(sandbox, { timeout: 5000 });
    send({ type: "result", value: value ?? null, logs });
  } catch (e) {
    send({ type: "result", error: (e as Error).message, logs });
  }
  process.exit(0);
});
