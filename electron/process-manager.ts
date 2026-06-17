import { spawn, ChildProcess, execFileSync } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import type { SlotName } from "./types.js";
import fs from "fs";
import os from "os";
import { startStaticServer, type StaticServerHandle } from "./static-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_APPS_DIR = path.join(__dirname, "..", "..", "apps");

// 3 minutes — openwork installs deps on first run before starting Vite
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 500;

interface RunningApp {
  // Array of child processes associated with this slot
  readonly processes: ChildProcess[];
  // Static file servers (packaged mode) replacing the dev servers; closed on stop
  readonly staticServers: StaticServerHandle[];
  port: number;
  healthy: boolean;
}

export interface ApiKeys {
  googleAiKey?: string | null;
}

/**
 * Runtime layout, computed by main.ts from `app.isPackaged`. In dev the apps live
 * in the cloned repo and run their dev servers; when packaged they are bundled
 * builds under Resources/ and writable data must live under userData.
 */
export interface PackagingContext {
  readonly isPackaged: boolean;
  readonly appsDir: string;
  readonly resourcesPath: string;
  readonly userDataDir: string;
}

export class ProcessManager {
  private readonly running = new Map<string, RunningApp>();
  private readonly starting = new Map<string, Promise<number | null>>();
  private readonly proxyToken: string;
  private readonly apiKeys: ApiKeys;
  private readonly shimDir: string;
  private readonly ctx: PackagingContext;

  // NOTE: `opencode serve` is bound to 127.0.0.1 only (see startOpenCode). A
  // per-session OPENCODE_SERVER_PASSWORD is intentionally NOT set: the upstream
  // OpenWork client connects to opencode directly and we cannot inject the password
  // into it, so loopback binding is the enforced boundary for this surface.

  constructor(proxyToken: string, apiKeys: ApiKeys = {}, ctx?: PackagingContext) {
    this.proxyToken = proxyToken;
    this.apiKeys = apiKeys;
    // Default to the dev layout so tests / `npm run dev` work without wiring ctx.
    this.ctx = ctx ?? {
      isPackaged: false,
      appsDir: DEV_APPS_DIR,
      resourcesPath: path.join(__dirname, ".."),
      userDataDir: os.tmpdir(),
    };

    // S2: only auto-inject --dangerously-skip-permissions in DEV. A distributed
    // build must let opencode prompt the user before running shell/file actions.
    const skipPermsBlock = this.ctx.isPackaged
      ? ""
      : `
if [ "\$has_run" = true ]; then
  args+=("--dangerously-skip-permissions")
fi`;

    // Create a temporary directory for shims
    this.shimDir = path.join(
      os.tmpdir(),
      `openhub-shims-${randomBytes(8).toString("hex")}`,
    );
    try {
      // Owner-only: the shim dir lives in a shared /tmp; 0700 keeps other local
      // accounts from reading or planting files in it.
      fs.mkdirSync(this.shimDir, { recursive: true, mode: 0o700 });
      const shimContent = `#!/bin/bash
# Prefer the bundled opencode binary, then the next one in PATH (excluding this
# shim), then the standard ~/.opencode install location.
# Paths injected via env vars to avoid shell metacharacter injection.
SHIM_DIR="\$(dirname "\$0")"
BUNDLED="\${OPENHUB_BUNDLED_OPENCODE:-}"
FALLBACK="\${OPENHUB_FALLBACK_OPENCODE:-}"
REAL_PATH=""
if [ -n "\$BUNDLED" ] && [ -x "\$BUNDLED" ]; then
  REAL_PATH="\$BUNDLED"
fi

if [ -z "\$REAL_PATH" ]; then
  REAL_PATH=\$(PATH=\$(echo "\$PATH" | tr ':' '\\n' | grep -v "\$SHIM_DIR" | tr '\\n' ':') which opencode)
fi

if [ -z "\$REAL_PATH" ]; then
  if [ -n "\$FALLBACK" ] && [ -x "\$FALLBACK" ]; then
    REAL_PATH="\$FALLBACK"
  fi
fi

args=()
has_run=false
for arg in "\$@"; do
  args+=("\$arg")
  if [ "\$arg" = "run" ]; then
    has_run=true
  fi
done
${skipPermsBlock}

exec "\$REAL_PATH" "\${args[@]}"
`;
      fs.writeFileSync(path.join(this.shimDir, "opencode"), shimContent, "utf8");
      fs.writeFileSync(path.join(this.shimDir, "opencode-cli"), shimContent, "utf8");
      fs.chmodSync(path.join(this.shimDir, "opencode"), 0o700);
      fs.chmodSync(path.join(this.shimDir, "opencode-cli"), 0o700);
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
      this.running.set(slot, {
        processes: [],
        staticServers: [],
        port,
        healthy: true,
      });
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

  stop(slot: Exclude<SlotName, "config" | "chat" | "projects">): void {
    const app = this.running.get(slot);
    if (!app) return;
    for (const proc of app.processes) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    for (const srv of app.staticServers) {
      void srv.close();
    }
    this.killPort(app.port);
    if (slot === "design") this.killPort(7456);
    this.running.delete(slot);
    console.warn(`[${slot}] stopped`);
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
      for (const srv of app.staticServers) {
        void srv.close();
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

  private static readonly ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "SSH_AUTH_SOCK",
    "NO_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "ELECTRON_RUN_AS_NODE",
  ] as const;

  private sharedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ProcessManager.ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.OPENHUB_TOKEN = this.proxyToken;
    env.OPENHUB_BUNDLED_OPENCODE = path.join(this.ctx.resourcesPath, "bin", "opencode");
    env.OPENHUB_FALLBACK_OPENCODE = path.join(
      os.homedir(),
      ".opencode",
      "bin",
      "opencode",
    );
    if (
      this.apiKeys.googleAiKey !== null &&
      this.apiKeys.googleAiKey !== undefined &&
      this.apiKeys.googleAiKey !== ""
    ) {
      env.GOOGLE_GENERATIVE_AI_API_KEY = this.apiKeys.googleAiKey;
    }
    const existingPath = process.env.PATH ?? "";
    env.PATH = this.shimDir + path.delimiter + existingPath;
    return env;
  }

  private killPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    try {
      // execFile (no shell) so the port can never be interpreted as a command.
      // lsof exits non-zero when nothing holds the port — caught below.
      const pids = execFileSync("lsof", ["-ti", `:${port}`], { stdio: "pipe" })
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
    this.killPort(port);

    // Packaged: serve the prebuilt static SPA (vite build) over loopback instead
    // of running the Vite dev server, which isn't shipped.
    if (this.ctx.isPackaged) {
      const distDir = path.join(this.ctx.appsDir, "openwork", "dist");
      console.warn(`[work] serving static build from ${distDir} on :${port}...`);
      const handle = await startStaticServer(distDir, port);
      this.running.set("work", {
        processes: [],
        staticServers: [handle],
        port,
        healthy: true,
      });
      console.warn(`[work] healthy ✓ (static)`);
      return port;
    }

    console.warn(`[work] killing port ${port} and spawning pnpm dev:ui...`);
    const proc = spawn("pnpm", ["dev:ui"], {
      cwd: path.join(this.ctx.appsDir, "openwork"),
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
    this.running.set("work", {
      processes: [proc],
      staticServers: [],
      port,
      healthy: true,
    });
    console.warn(`[work] healthy ✓`);
    return port;
  }

  private async startOpenCode(): Promise<number> {
    const port = 4096;
    this.killPort(port);
    console.warn(`[code] spawning opencode serve on 127.0.0.1:${port}...`);
    // "serve" starts the server + web UI without opening the system browser
    // ("web" = serve + browser open, which we don't want inside Electron)
    // Dev: project root (sees local sessions). Packaged: process.cwd() may be "/"
    // or a read-only bundle path, so use a writable workspace under userData (S3).
    const cwd = this.ctx.isPackaged ? this.workspaceDir() : process.cwd();
    const proc = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd,
        env: this.sharedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.pipeOutput("code", proc, "code");
    console.warn(`[code] waiting for health on 127.0.0.1:${port}...`);
    await this.waitForHealth(`http://127.0.0.1:${port}`);
    this.running.set("code", {
      processes: [proc],
      staticServers: [],
      port,
      healthy: true,
    });
    console.warn(`[code] healthy ✓`);
    return port;
  }

  private async startOpenDesign(): Promise<number> {
    const odCwd = path.join(this.ctx.appsDir, "open-design");
    const webCwd = path.join(odCwd, "apps", "web");
    const webPort = 3456;
    this.killPort(7456);
    this.killPort(webPort);

    const daemonProc = this.spawnDesignDaemon(odCwd, webPort);
    const staticServers: StaticServerHandle[] = [];
    const processes: ChildProcess[] = [daemonProc];

    if (this.ctx.isPackaged) {
      // Serve the prebuilt Next.js static export over loopback (no dev server).
      const outDir = path.join(webCwd, "out");
      console.warn(`[design] serving static web from ${outDir} on :${webPort}...`);
      staticServers.push(await startStaticServer(outDir, webPort));
    } else {
      console.warn(`[design] spawning web frontend: next dev on :${webPort}`);
      const webProc = spawn("pnpm", ["dev"], {
        cwd: webCwd,
        env: { ...this.sharedEnv(), PORT: String(webPort), BROWSER: "none" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.pipeOutput("design-web", webProc, "design");
      processes.push(webProc);
    }

    console.warn(
      `[design] waiting for web frontend (:${webPort}) AND daemon API (:7456)...`,
    );
    // Gate on BOTH: the Design tab loads the web frontend, but the orchestrator's
    // design backend talks to the daemon API on :7456. The daemon is spawned in
    // parallel and can be slower than Next.js — without this wait, a cold start
    // makes the design node's isAvailable() probe fail and silently fall back to
    // plain LLM HTML instead of the iterated Open Design mockups.
    await Promise.all([
      this.waitForHealth(`http://localhost:${webPort}`),
      this.waitForHealth(`http://127.0.0.1:7456/api/health`),
    ]);
    this.running.set("design", {
      processes,
      staticServers,
      port: webPort,
      healthy: true,
    });
    console.warn(`[design] healthy ✓`);
    return webPort;
  }

  // The daemon (Open Design API on :7456) is a compiled Node program. Packaged
  // builds run it with the bundled Node 24 binary (Electron's own Node is too old)
  // and write SQLite into a writable userData dir, not the read-only bundle (S3).
  private spawnDesignDaemon(odCwd: string, webPort: number): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...this.sharedEnv(),
      OD_WEB_PORT: String(webPort),
      BROWSER: "none",
    };

    if (this.ctx.isPackaged) {
      const nodeBin = path.join(this.ctx.resourcesPath, "bin", "node");
      const odEntry = path.join(odCwd, "apps", "daemon", "bin", "od.mjs");
      const dataDir = path.join(this.ctx.userDataDir, "open-design");
      // OD_DATA_DIR overrides the daemon's default <projectRoot>/.od. We point it
      // at a writable userData dir AND expose it to our own process.env so the
      // design backend (design-backend.ts) reads the SAME .od/projects the daemon
      // writes — otherwise mockups land in userData but are read from the bundle.
      const odDataDir = path.join(dataDir, ".od");
      try {
        fs.mkdirSync(odDataDir, { recursive: true });
      } catch (err) {
        console.error("[design] failed to create data dir:", err);
      }
      process.env.OD_DATA_DIR = odDataDir;
      env.OD_DATA_DIR = odDataDir;
      console.warn(`[design] spawning daemon: ${nodeBin} ${odEntry} --no-open`);
      const proc = spawn(nodeBin, [odEntry, "--no-open"], {
        cwd: dataDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.pipeOutput("design-daemon", proc, "design");
      return proc;
    }

    const odBin = path.join(odCwd, "node_modules", ".bin", "od");
    console.warn(`[design] spawning daemon: ${odBin} --no-open`);
    const proc = spawn(odBin, ["--no-open"], {
      cwd: odCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pipeOutput("design-daemon", proc, "design");
    return proc;
  }

  // Writable per-user workspace for child processes that persist state (opencode
  // sessions, etc.). Never the read-only app bundle.
  private workspaceDir(): string {
    const dir = path.join(this.ctx.userDataDir, "workspace");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error("[workspace] failed to create workspace dir:", err);
    }
    return dir;
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

  // Strips secrets a child might echo to its stdout/stderr before we log them:
  // the per-session proxy token (injected via env) plus common provider key shapes.
  private redactSecrets(text: string): string {
    let out = text;
    // Literal redaction of every secret we injected into the child env (the
    // per-session proxy token and the Google key).
    const literals = [this.proxyToken, this.apiKeys?.googleAiKey];
    for (const secret of literals) {
      if (typeof secret === "string" && secret.length >= 8) {
        out = out.split(secret).join("[REDACTED]");
      }
    }
    return out
      .replace(
        /\b(sk-ant|sk-proj|sk-or|sk|ghp|gho|ghs|github_pat|xoxb|AIza|GOCSPX)[-_][A-Za-z0-9_-]{6,}/g,
        "[REDACTED]",
      )
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer [REDACTED]");
  }

  private pipeOutput(label: string, proc: ChildProcess, runningKey?: string): void {
    proc.stdout?.on("data", (d: Buffer) =>
      console.warn(`[${label}] ${this.redactSecrets(d.toString().trim())}`),
    );
    proc.stderr?.on("data", (d: Buffer) =>
      console.error(`[${label}] ${this.redactSecrets(d.toString().trim())}`),
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
