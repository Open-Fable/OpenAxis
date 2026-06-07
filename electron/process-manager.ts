import { spawn, ChildProcess, execSync } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import type { SlotName } from "./types.js";
import fs from "fs";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPS_DIR = path.join(__dirname, "..", "..", "apps");

// 3 minutes — openwork installs deps on first run before starting Vite
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 500;

interface RunningApp {
  // Array of child processes associated with this slot
  readonly processes: ChildProcess[];
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
  private readonly shimDir: string;

  getOpencodePassword(): string {
    return this.opencodePassword;
  }

  constructor(proxyToken: string, apiKeys: ApiKeys = {}) {
    this.proxyToken = proxyToken;
    this.apiKeys = apiKeys;

    // Create a temporary directory for shims
    this.shimDir = path.join(
      os.tmpdir(),
      `openhub-shims-${randomBytes(8).toString("hex")}`,
    );
    try {
      fs.mkdirSync(this.shimDir, { recursive: true });
      const shimContent = `#!/bin/bash
# Find the next opencode in PATH (excluding this shim)
SHIM_DIR="\$(dirname "\$0")"
REAL_PATH=\$(PATH=\$(echo "\$PATH" | tr ':' '\\n' | grep -v "\$SHIM_DIR" | tr '\\n' ':') which opencode)

if [ -z "\$REAL_PATH" ]; then
  REAL_PATH="${path.join(os.homedir(), ".opencode", "bin", "opencode")}"
fi

args=()
has_run=false
for arg in "\$@"; do
  args+=("\$arg")
  if [ "\$arg" = "run" ]; then
    has_run=true
  fi
done

if [ "\$has_run" = true ]; then
  args+=("--dangerously-skip-permissions")
fi

exec "\$REAL_PATH" "\${args[@]}"
`;
      fs.writeFileSync(path.join(this.shimDir, "opencode"), shimContent, "utf8");
      fs.writeFileSync(path.join(this.shimDir, "opencode-cli"), shimContent, "utf8");
      fs.chmodSync(path.join(this.shimDir, "opencode"), 0o755);
      fs.chmodSync(path.join(this.shimDir, "opencode-cli"), 0o755);
      console.warn(`[shims] opencode wrapper created at ${this.shimDir}`);
    } catch (err) {
      console.error("[shims] failed to create opencode shims:", err);
    }
  }

  async ensureRunning(
    slot: Exclude<SlotName, "config" | "chat" | "projects">,
  ): Promise<number | null> {
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

  private async doStart(
    slot: Exclude<SlotName, "config" | "chat" | "projects">,
  ): Promise<number | null> {
    // Use localhost (not 127.0.0.1) — Vite/opencode bind to ::1 on modern macOS
    const knownUrls: Partial<Record<string, string>> = {
      work: "http://localhost:5173",
    };
    const knownUrl = knownUrls[slot];
    if (knownUrl !== undefined && (await this.isAlreadyHealthy(knownUrl))) {
      const port = parseInt(new URL(knownUrl).port);
      console.warn(`[${slot}] reusing existing process on :${port}`);
      this.running.set(slot, { processes: [], port, healthy: true });
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
      for (const proc of app.processes) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      // Also clean up ports to prevent leaks of orphaned children (e.g. Next.js, daemon)
      this.killPort(app.port);
      if (slot === "design") {
        this.killPort(7456);
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
    if (
      this.apiKeys.googleAiKey !== null &&
      this.apiKeys.googleAiKey !== undefined &&
      this.apiKeys.googleAiKey !== ""
    ) {
      env.GOOGLE_GENERATIVE_AI_API_KEY = this.apiKeys.googleAiKey;
    }
    const pathDelimiter = path.delimiter;
    const existingPath = process.env.PATH !== undefined ? process.env.PATH : "";
    env.PATH = this.shimDir + pathDelimiter + existingPath;
    return env;
  }

  private killPort(port: number): void {
    try {
      const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { stdio: "pipe" })
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n));

      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // may already be dead
        }
      }

      // Give processes 3s to exit gracefully, then force kill
      const deadline = Date.now() + 3000;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      void (async () => {
        while (Date.now() < deadline) {
          const remaining = pids.filter((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          });
          if (remaining.length === 0) return;
          await wait(200);
        }
        // Force kill remaining
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      })();
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
    this.pipeOutput("work", proc, "work");
    // Only add to running AFTER health check — prevents premature port access
    console.warn(`[work] waiting for health on localhost:${port}...`);
    await this.waitForHealth(`http://localhost:${port}`);
    this.running.set("work", { processes: [proc], port, healthy: true });
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
        cwd: process.cwd(), // Use project root to see local sessions
        env: this.sharedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.pipeOutput("code", proc, "code");
    console.warn(`[code] waiting for health on 127.0.0.1:${port}...`);
    await this.waitForHealth(`http://127.0.0.1:${port}`);
    this.running.set("code", { processes: [proc], port, healthy: true });
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
      env: {
        ...this.sharedEnv(),
        OD_WEB_PORT: String(webPort),
        BROWSER: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pipeOutput("design-daemon", daemonProc, "design");

    // 2. Start the web frontend (Next.js on :3456)
    console.warn(`[design] spawning web frontend: next dev on :${webPort}`);
    const webProc = spawn("pnpm", ["dev"], {
      cwd: webCwd,
      env: { ...this.sharedEnv(), PORT: String(webPort), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pipeOutput("design-web", webProc, "design");

    console.warn(`[design] waiting for web frontend on localhost:${webPort}...`);
    await this.waitForHealth(`http://localhost:${webPort}`);
    this.running.set("design", {
      processes: [daemonProc, webProc],
      port: webPort,
      healthy: true,
    });
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

  private pipeOutput(label: string, proc: ChildProcess, runningKey?: string): void {
    proc.stdout?.on("data", (d: Buffer) =>
      console.warn(`[${label}] ${d.toString().trim()}`),
    );
    proc.stderr?.on("data", (d: Buffer) =>
      console.error(`[${label}] ${d.toString().trim()}`),
    );
    proc.on("exit", (code) => {
      console.warn(`[${label}] exited with code ${code}`);
      if (runningKey !== undefined) {
        const app = this.running.get(runningKey);
        if (app !== undefined) {
          for (const p of app.processes) {
            try {
              p.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          }
          // Also clean up ports to prevent leaks of orphaned children (e.g. Next.js, daemon)
          this.killPort(app.port);
          if (runningKey === "design") {
            this.killPort(7456);
          }
          this.running.delete(runningKey);
        }
      }
    });
  }
}
