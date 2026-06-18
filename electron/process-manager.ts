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

// Grace period after SIGTERM before a stubborn child is force-killed with
// SIGKILL. Prevents zombies when a daemon ignores SIGTERM (the timer is
// unref'd so it never keeps the event loop — and the process — alive).
const KILL_GRACE_MS = 3_000;

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
    const t0 = Date.now();
    if (this.running.has(slot)) {
      console.warn(`[pm-timing] ${slot} already running → +${Date.now() - t0}ms`);
      return this.running.get(slot)!.port;
    }

    // Deduplicate concurrent calls — only one spawn per slot at a time
    if (this.starting.has(slot)) {
      console.warn(
        `[pm-timing] ${slot} already starting (dedup) → +${Date.now() - t0}ms`,
      );
      return this.starting.get(slot)!;
    }

    console.warn(`[pm-timing] ${slot} doStart begin → +${Date.now() - t0}ms`);
    const promise = this.doStart(slot);
    this.starting.set(slot, promise);
    try {
      const port = await promise;
      console.warn(
        `[pm-timing] ${slot} doStart done → port=${port} +${Date.now() - t0}ms`,
      );
      return port;
    } finally {
      this.starting.delete(slot);
    }
  }

  private async doStart(
    slot: Exclude<SlotName, "config" | "chat" | "projects">,
  ): Promise<number | null> {
    const t0 = Date.now();
    // Use localhost (not 127.0.0.1) — Vite/opencode bind to ::1 on modern macOS
    const knownUrls: Partial<Record<string, string>> = {
      work: "http://localhost:5173",
    };
    const knownUrl = knownUrls[slot];
    if (knownUrl !== undefined) {
      console.warn(
        `[pm-timing] ${slot} isAlreadyHealthy(${knownUrl}) check start +${Date.now() - t0}ms`,
      );
      const healthy = await this.isAlreadyHealthy(knownUrl);
      console.warn(
        `[pm-timing] ${slot} isAlreadyHealthy=${healthy} +${Date.now() - t0}ms`,
      );
      if (healthy) {
        const port = parseInt(new URL(knownUrl).port);
        this.running.set(slot, {
          processes: [],
          staticServers: [],
          port,
          healthy: true,
        });
        return port;
      }
    }

    console.warn(
      `[pm-timing] ${slot} start${slot.charAt(0).toUpperCase() + slot.slice(1)}() begin +${Date.now() - t0}ms`,
    );
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

  // Send SIGTERM, then escalate to SIGKILL after a grace period if the child is
  // still alive. The fallback timer is unref'd so it never blocks app exit.
  private terminateProcess(proc: ChildProcess): void {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, KILL_GRACE_MS);
    timer.unref();
  }

  stop(slot: Exclude<SlotName, "config" | "chat" | "projects">): void {
    const app = this.running.get(slot);
    if (!app) return;
    for (const proc of app.processes) {
      this.terminateProcess(proc);
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
        this.terminateProcess(proc);
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

  private sharedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENHUB_TOKEN: this.proxyToken,
      OPENHUB_BUNDLED_OPENCODE: path.join(this.ctx.resourcesPath, "bin", "opencode"),
      OPENHUB_FALLBACK_OPENCODE: path.join(os.homedir(), ".opencode", "bin", "opencode"),
    };
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
    const t0 = Date.now();
    const t = (label: string) =>
      console.warn(`[pm-timing] work ${label} +${Date.now() - t0}ms`);
    const port = 5173;
    t("killPort start");
    this.killPort(port);
    t("killPort done");

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
      t("healthy (static)");
      return port;
    }

    t("spawn pnpm dev:ui");
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
    t("waitForHealth start");
    await this.waitForHealth(`http://localhost:${port}`);
    t("waitForHealth done → healthy");
    this.running.set("work", {
      processes: [proc],
      staticServers: [],
      port,
      healthy: true,
    });
    return port;
  }

  private async startOpenCode(): Promise<number> {
    const t0 = Date.now();
    const t = (label: string) =>
      console.warn(`[pm-timing] code ${label} +${Date.now() - t0}ms`);
    const port = 4096;
    t("killPort start");
    this.killPort(port);
    t("killPort done");
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
    t("waitForHealth start");
    await this.waitForHealth(`http://127.0.0.1:${port}`);
    t("waitForHealth done → healthy");
    this.running.set("code", {
      processes: [proc],
      staticServers: [],
      port,
      healthy: true,
    });
    return port;
  }

  private async startOpenDesign(): Promise<number> {
    const t0 = Date.now();
    const t = (label: string) =>
      console.warn(`[pm-timing] design ${label} +${Date.now() - t0}ms`);
    const odCwd = path.join(this.ctx.appsDir, "open-design");
    const webCwd = path.join(odCwd, "apps", "web");
    const webPort = 3456;
    t("killPort start");
    this.killPort(7456);
    this.killPort(webPort);
    t("killPort done");

    const daemonProc = this.spawnDesignDaemon(odCwd, webPort);
    const staticServers: StaticServerHandle[] = [];
    const processes: ChildProcess[] = [daemonProc];

    // Dev fast path: when a production web build exists, the daemon itself serves
    // it (apps/web/out) together with /api on its own port (:7456). Loading the
    // view from the daemon skips `next dev`, whose Turbopack cold-compiles the
    // route on first navigation (20-40s black screen). The view loads :7456
    // directly; no separate web server. Packaged keeps its dedicated static
    // server below. Falls back to `next dev` when no build is present.
    const hasWebBuild = fs.existsSync(path.join(webCwd, "out", "index.html"));
    t(`hasWebBuild=${hasWebBuild} isPackaged=${this.ctx.isPackaged}`);
    if (hasWebBuild) {
      const daemonPort = 7456;
      t("daemon fast-path: waitForHealth start");
      await this.waitForHealth(`http://127.0.0.1:${daemonPort}/api/health`);
      t("daemon fast-path: waitForHealth done → healthy");
      this.running.set("design", {
        processes,
        staticServers,
        port: daemonPort,
        healthy: true,
      });
      return daemonPort;
    }

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
      const odCli = path.join(odCwd, "apps", "daemon", "dist", "cli.js");
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
      env.OD_DAEMON_CLI_PATH = odCli;
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
    const t0 = Date.now();
    let polls = 0;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      polls++;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status < 500) {
          console.warn(
            `[pm-timing] waitForHealth(${url}) OK after ${polls} polls +${Date.now() - t0}ms`,
          );
          return;
        }
        console.warn(
          `[pm-timing] waitForHealth(${url}) poll#${polls} status=${res.status} +${Date.now() - t0}ms`,
        );
      } catch (err) {
        if (polls <= 3 || polls % 10 === 0) {
          console.warn(
            `[pm-timing] waitForHealth(${url}) poll#${polls} err=${(err as NodeJS.ErrnoException).code ?? (err as Error).message} +${Date.now() - t0}ms`,
          );
        }
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
