import { spawn, ChildProcess, execSync } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import type { SlotName } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPS_DIR = path.join(__dirname, "..", "..", "apps");

// 3 minutes — openwork installs deps on first run before starting Vite
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 500;

interface RunningApp {
  // null when slot was reused from an already-running external process
  readonly process: ChildProcess | null;
  port: number;
  healthy: boolean;
}

export interface ApiKeys {
  googleAiKey?: string | null;
}

export class ProcessManager {
  private readonly running = new Map<string, RunningApp>();
  private readonly starting = new Map<string, Promise<number | null>>();
  private readonly proxyToken: string;
  private readonly apiKeys: ApiKeys;
  // Generated per session, never logged
  private readonly opencodePassword = randomBytes(24).toString("hex");

  getOpencodePassword(): string {
    return this.opencodePassword;
  }

  constructor(proxyToken: string, apiKeys: ApiKeys = {}) {
    this.proxyToken = proxyToken;
    this.apiKeys = apiKeys;
  }

  async ensureRunning(slot: Exclude<SlotName, "config" | "chat">): Promise<number | null> {
    if (this.running.has(slot)) return this.running.get(slot)!.port;

    // Deduplicate concurrent calls — only one spawn per slot at a time
    if (this.starting.has(slot)) return this.starting.get(slot)!;

    const promise = this.doStart(slot);
    this.starting.set(slot, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(slot);
    }
  }

  private async doStart(slot: Exclude<SlotName, "config" | "chat">): Promise<number | null> {
    // Use localhost (not 127.0.0.1) — Vite/opencode bind to ::1 on modern macOS
    const knownUrls: Partial<Record<string, string>> = {
      work: "http://localhost:5173",
    };
    const knownUrl = knownUrls[slot];
    if (knownUrl && (await this.isAlreadyHealthy(knownUrl))) {
      const port = parseInt(new URL(knownUrl).port);
      console.warn(`[${slot}] reusing existing process on :${port}`);
      this.running.set(slot, { process: null, port, healthy: true });
      return port;
    }

    switch (slot) {
      case "work":
        return this.startOpenWork();
      case "code":
        return this.startOpenCode();
      case "design":
        return this.startOpenDesign();
    }
  }

  getStatus(): Record<string, { port: number; healthy: boolean }> {
    const out: Record<string, { port: number; healthy: boolean }> = {};
    for (const [slot, app] of this.running) {
      out[slot] = { port: app.port, healthy: app.healthy };
    }
    return out;
  }

  stopAll(): void {
    for (const [slot, app] of this.running) {
      if (app.process) {
        try {
          app.process.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      console.warn(`[${slot}] stopped`);
    }
    this.running.clear();
  }

  private sharedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENHUB_TOKEN: this.proxyToken,
    };
    if (this.apiKeys.googleAiKey) {
      env.GOOGLE_GENERATIVE_AI_API_KEY = this.apiKeys.googleAiKey;
    }
    return env;
  }

  private killPort(port: number): void {
    try {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
        stdio: "ignore",
      });
    } catch {
      /* nothing on that port */
    }
  }

  private async startOpenWork(): Promise<number> {
    const port = 5173;
    console.warn(`[work] killing port ${port} and spawning pnpm dev:ui...`);
    this.killPort(port);
    const proc = spawn("pnpm", ["dev:ui"], {
      cwd: path.join(APPS_DIR, "openwork"),
      env: {
        ...this.sharedEnv(),
        OPENWORK_APP_PORT: String(port),
        OPENWORK_DEV_MODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pipeOutput("work", proc);
    // Only add to running AFTER health check — prevents premature port access
    console.warn(`[work] waiting for health on localhost:${port}...`);
    await this.waitForHealth(`http://localhost:${port}`);
    this.running.set("work", { process: proc, port, healthy: true });
    console.warn(`[work] healthy ✓`);
    return port;
  }

  private async startOpenCode(): Promise<number> {
    const port = 4096;
    this.killPort(port);
    console.warn(`[code] spawning opencode serve on 127.0.0.1:${port}...`);
    // "serve" starts the server + web UI without opening the system browser
    // ("web" = serve + browser open, which we don't want inside Electron)
    const proc = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        env: this.sharedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.pipeOutput("code", proc);
    console.warn(`[code] waiting for health on 127.0.0.1:${port}...`);
    await this.waitForHealth(`http://127.0.0.1:${port}`);
    this.running.set("code", { process: proc, port, healthy: true });
    console.warn(`[code] healthy ✓`);
    return port;
  }

  private async startOpenDesign(): Promise<number> {
    const odCwd = path.join(APPS_DIR, "open-design");
    const webCwd = path.join(odCwd, "apps", "web");
    const webPort = 3456;
    this.killPort(7456);
    this.killPort(webPort);

    // 1. Start the daemon (API backend on :7456)
    const odBin = path.join(odCwd, "node_modules", ".bin", "od");
    console.warn(`[design] spawning daemon: ${odBin} --no-open`);
    const daemonProc = spawn(odBin, ["--no-open"], {
      cwd: odCwd,
      env: { ...this.sharedEnv(), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pipeOutput("design-daemon", daemonProc);

    // 2. Start the web frontend (Next.js on :3456)
    console.warn(`[design] spawning web frontend: next dev on :${webPort}`);
    const webProc = spawn("pnpm", ["dev"], {
      cwd: webCwd,
      env: { ...this.sharedEnv(), PORT: String(webPort), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pipeOutput("design-web", webProc);

    console.warn(`[design] waiting for web frontend on localhost:${webPort}...`);
    await this.waitForHealth(`http://localhost:${webPort}`);
    this.running.set("design", { process: webProc, port: webPort, healthy: true });
    console.warn(`[design] healthy ✓`);
    return webPort;
  }

  private async isAlreadyHealthy(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  }

  private async waitForHealth(url: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status < 500) return;
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`${url} did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
  }

  private pipeOutput(slot: string, proc: ChildProcess): void {
    proc.stdout?.on("data", (d: Buffer) =>
      console.warn(`[${slot}] ${d.toString().trim()}`),
    );
    proc.stderr?.on("data", (d: Buffer) =>
      console.error(`[${slot}] ${d.toString().trim()}`),
    );
    proc.on("exit", (code) => {
      console.warn(`[${slot}] exited with code ${code}`);
      this.running.delete(slot);
    });
  }
}
