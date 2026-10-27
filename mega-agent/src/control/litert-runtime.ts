// Layer 2 — Native On-Device Engine Runtime Adapter.
// Embeds Google AI Edge LiteRT-LM (formerly TensorFlow Lite Runtime / MediaPipe LLM)
// for local on-device inference on Apple Silicon (XNNPACK CPU / WebGPU Metal) and other edge devices.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MegaSession, RuntimeAdapter } from "./runtime.ts";

export interface LiteRtLmOptions {
  model?: string;
  modelPath?: string;
  host?: string;
  port?: number;
  backend?: "cpu" | "gpu" | "npu";
  maxTokens?: number;
  temperature?: number;
  autoServe?: boolean;
  timeoutMs?: number;
}

export function findLiteRtBinary(): string | null {
  const common = [
    "/opt/homebrew/bin/litert-lm",
    "/usr/local/bin/litert-lm",
    join(homedir(), ".local/bin/litert-lm"),
    join(homedir(), "Library/Python/3.14/bin/litert-lm"),
    join(homedir(), "Library/Python/3.13/bin/litert-lm"),
    join(homedir(), "Library/Python/3.12/bin/litert-lm"),
  ];
  for (const p of common) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync("which", ["litert-lm"]);
  if (which.status === 0 && which.stdout.toString().trim()) {
    return which.stdout.toString().trim();
  }
  return null;
}

export function getLocalLiteRtModels(): string[] {
  const dir = join(homedir(), ".litert-lm", "models");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((d) => {
      try {
        return statSync(join(dir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export class LiteRtLmRuntimeAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly supportedOptions = [
    "cwd", "model", "effort", "resume", "backend", "temperature", "maxTokens", "serverUrl", "autoServe",
  ] as const;
  readonly canSteer = false;

  readonly model: string;
  readonly modelPath?: string;
  readonly host: string;
  readonly port: number;
  readonly backend: "cpu" | "gpu" | "npu";
  readonly maxTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;

  #serverProcess?: ChildProcess;
  #serverStartedByUs = false;

  private constructor(model: string, options: LiteRtLmOptions = {}) {
    this.model = model;
    this.id = `litert-lm:${model}`;
    this.modelPath = options.modelPath;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 9379;
    this.backend = options.backend ?? "cpu";
    this.maxTokens = options.maxTokens ?? 1024;
    this.temperature = options.temperature ?? 0.7;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  static isInstalled(): boolean {
    return findLiteRtBinary() !== null;
  }

  static async listModels(): Promise<string[]> {
    return getLocalLiteRtModels();
  }

  static async create(options: LiteRtLmOptions = {}): Promise<LiteRtLmRuntimeAdapter> {
    const bin = findLiteRtBinary();
    if (!bin) {
      throw new Error(
        "litert-lm CLI is not installed. Install with: pip install litert-lm or brew install litert-lm"
      );
    }
    const available = getLocalLiteRtModels();
    const model = options.model ?? available[0] ?? "vibethinker-3b-litertlm";
    const adapter = new LiteRtLmRuntimeAdapter(model, options);

    if (options.autoServe ?? true) {
      await adapter.#ensureServer();
    }
    return adapter;
  }

  get serverUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async #isServerAlive(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/v1/models`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #ensureServer(): Promise<void> {
    if (await this.#isServerAlive()) return;

    const bin = findLiteRtBinary();
    if (!bin) throw new Error("litert-lm binary not found");

    const child = spawn(bin, ["serve", "--host", this.host, "--port", String(this.port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH },
    });

    this.#serverProcess = child;
    this.#serverStartedByUs = true;

    // Wait for server to become alive (up to 15 seconds)
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.#isServerAlive()) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    this.dispose();
    throw new Error(`litert-lm serve failed to start on ${this.serverUrl} within 15 seconds`);
  }

  async runTurn(session: MegaSession, prompt: string): Promise<string> {
    // If the server is alive, run via the OpenAI-compatible chat endpoint
    if (await this.#isServerAlive()) {
      const history = session.messages();
      const messages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: prompt },
      ];

      const res = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content;
        if (text !== undefined) return text;
      }
    }

    // Direct CLI fallback: litert-lm run
    const bin = findLiteRtBinary();
    if (!bin) throw new Error("litert-lm binary not found for CLI execution");

    return await new Promise<string>((resolve, reject) => {
      const args = ["run", this.model, "--prompt", prompt, "--backend", this.backend];
      const child = spawn(bin, args, { env: { ...process.env, PATH: process.env.PATH } });

      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`litert-lm run timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) {
          resolve(out.trim());
        } else {
          // If the model had a shape error or template error, provide clean guidance
          const combined = `${err}\n${out}`.trim();
          reject(new Error(`litert-lm execution failed (exit ${code}): ${combined.slice(-400)}`));
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  dispose(): void {
    if (this.#serverStartedByUs && this.#serverProcess) {
      try {
        this.#serverProcess.kill("SIGTERM");
      } catch {}
      this.#serverProcess = undefined;
    }
  }
}
