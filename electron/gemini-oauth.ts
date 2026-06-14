// In-app Google OAuth login for Gemini, mirroring the `opencode-gemini-auth`
// plugin so OpenHub writes the exact same ~/.local/share/opencode/auth.json the
// proxy already reads. The packed refresh format is `refreshToken|projectId|managedProjectId`.

import { createServer, type Server } from "http";
import type { ServerResponse } from "http";
import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { homedir, platform, arch } from "os";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

// Public Gemini CLI "installed app" credentials (non-confidential per Google's
// native-app OAuth spec); identical to the proxy's working defaults.
const GEMINI_CLIENT_ID =
  process.env.GEMINI_CLIENT_ID ??
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET =
  process.env.GEMINI_CLIENT_SECRET ?? "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";

const AUTH_DIR = path.join(homedir(), ".local", "share", "opencode");
const AUTH_JSON_PATH = path.join(AUTH_DIR, "auth.json");

const FREE_TIER_ID = "free-tier";
const LEGACY_TIER_ID = "legacy-tier";
const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;
const ONBOARD_MAX_ATTEMPTS = 10;
const ONBOARD_DELAY_MS = 5000;

interface CloudAiCompanionProject {
  id?: string;
}
interface GeminiUserTier {
  id?: string;
  isDefault?: boolean;
}
interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | CloudAiCompanionProject;
  currentTier?: { id?: string };
  allowedTiers?: GeminiUserTier[];
}
interface OnboardUserPayload {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
}
interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export interface GeminiAuthStatus {
  connected: boolean;
  email?: string;
}

// ── PKCE ──────────────────────────────────────────────────────────────────

export function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(challenge: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", GEMINI_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

// ── Loopback callback server ────────────────────────────────────────────────

function sendPage(res: ServerResponse, title: string, message: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;` +
      `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
      `.card{text-align:center;padding:2rem 3rem;background:#161b22;border:1px solid #30363d;` +
      `border-radius:12px}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#8b949e;margin:0}</style>` +
      `</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`,
  );
}

// Starts the loopback server. `ready` resolves once it is listening (open the
// browser only after that); `code` resolves with the OAuth authorization code.
function startCallbackServer(expectedState: string): {
  ready: Promise<void>;
  code: Promise<string>;
  close: () => void;
} {
  let resolveCode!: (value: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? "";
    if (rawUrl.length === 0 || !rawUrl.startsWith(CALLBACK_PATH)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const parsed = new URL(rawUrl, REDIRECT_URI);
    const error = parsed.searchParams.get("error");
    const authCode = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (error !== null) {
      sendPage(res, "Connexion refusée", "Tu peux fermer cette fenêtre.");
      rejectCode(new Error(`Google a renvoyé une erreur : ${error}`));
      return;
    }
    if (authCode === null || authCode.length === 0 || state !== expectedState) {
      res.writeHead(400);
      res.end("Callback OAuth invalide. Retourne à la connexion Google.");
      return;
    }
    sendPage(
      res,
      "Connexion réussie",
      "Tu peux fermer cette fenêtre et revenir à OpenHub.",
    );
    resolveCode(authCode);
  });

  const timer = setTimeout(
    () => rejectCode(new Error("Délai de connexion dépassé (5 min).")),
    CALLBACK_TIMEOUT_MS,
  );
  const close = (): void => {
    clearTimeout(timer);
    server.close();
  };

  let listening = false;
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      listening = true;
      resolve();
    });
    server.once("error", (err: NodeJS.ErrnoException) => {
      // Only a pre-listen failure (e.g. EADDRINUSE) aborts the flow; a late error
      // must not cancel the timeout that guards the wait for the browser callback.
      if (listening) return;
      clearTimeout(timer);
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              "Le port 8085 est déjà utilisé (login opencode en cours ?). Réessaie dans un instant.",
            )
          : err,
      );
    });
  });
  server.listen(CALLBACK_PORT, "127.0.0.1");
  return { ready, code, close };
}

// ── Token exchange + user info ──────────────────────────────────────────────

async function exchangeCode(
  code: string,
  verifier: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Échec de l'échange du code OAuth (${resp.status}) : ${text.slice(0, 200)}`,
    );
  }
  const data = (await resp.json()) as TokenResponse;
  if (data.refresh_token === undefined || data.refresh_token.length === 0) {
    throw new Error(
      "Réponse OAuth sans refresh token — réessaie en autorisant l'accès hors-ligne.",
    );
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
  try {
    const resp = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return undefined;
    const info = (await resp.json()) as { email?: string };
    return info.email;
  } catch {
    return undefined;
  }
}

// ── Cloud Code Assist project resolution ────────────────────────────────────

function buildUserAgent(): string {
  return `GeminiCLI/0.45.1/gemini-code-assist (${platform()}; ${arch()}; terminal)`;
}

function codeAssistHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": buildUserAgent(),
    "x-activity-request-id": Math.random().toString(36).substring(7),
  };
}

export function normalizeProjectId(
  value?: string | CloudAiCompanionProject,
): string | undefined {
  if (value === undefined) return undefined;
  const id = typeof value === "string" ? value : value.id;
  const trimmed = id?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCodeAssist(
  accessToken: string,
): Promise<LoadCodeAssistPayload | null> {
  const resp = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: codeAssistHeaders(accessToken),
    body: JSON.stringify({ metadata: { ...CODE_ASSIST_METADATA } }),
  });
  if (!resp.ok) return null;
  return (await resp.json()) as LoadCodeAssistPayload;
}

async function onboardUser(
  accessToken: string,
  tierId: string,
): Promise<string | undefined> {
  const base = `${CODE_ASSIST_ENDPOINT}/v1internal`;
  const body = JSON.stringify({ tierId, metadata: { ...CODE_ASSIST_METADATA } });
  const resp = await fetch(`${base}:onboardUser`, {
    method: "POST",
    headers: codeAssistHeaders(accessToken),
    body,
  });
  if (!resp.ok) return undefined;
  let payload = (await resp.json()) as OnboardUserPayload;
  for (
    let i = 0;
    i < ONBOARD_MAX_ATTEMPTS && payload.done !== true && (payload.name ?? "").length > 0;
    i += 1
  ) {
    await wait(ONBOARD_DELAY_MS);
    const op = await fetch(`${base}/${payload.name ?? ""}`, {
      headers: codeAssistHeaders(accessToken),
    });
    if (!op.ok) return undefined;
    payload = (await op.json()) as OnboardUserPayload;
  }
  return payload.done === true
    ? payload.response?.cloudaicompanionProject?.id
    : undefined;
}

async function resolveManagedProject(accessToken: string): Promise<string> {
  const load = await loadCodeAssist(accessToken);
  if (!load) {
    throw new Error(
      "Impossible de charger le projet Cloud Code Assist (loadCodeAssist).",
    );
  }
  const direct = normalizeProjectId(load.cloudaicompanionProject);
  if (direct !== undefined) return direct;
  const currentTierId = load.currentTier?.id ?? "";
  if (currentTierId.length > 0) {
    throw new Error(
      "Compte déjà associé à un tier sans projet géré — connecte-toi via 'opencode auth login'.",
    );
  }
  const tier =
    load.allowedTiers?.find((t) => t.isDefault === true) ?? load.allowedTiers?.[0];
  const tierId = tier?.id ?? LEGACY_TIER_ID;
  if (tierId !== FREE_TIER_ID) {
    throw new Error(
      "Ton compte nécessite un projet Google Cloud dédié — connecte-toi via 'opencode auth login'.",
    );
  }
  const onboarded = await onboardUser(accessToken, tierId);
  if (onboarded === undefined || onboarded.length === 0) {
    throw new Error("Échec de l'onboarding Cloud Code Assist.");
  }
  return onboarded;
}

// ── auth.json persistence ───────────────────────────────────────────────────

export function formatRefreshParts(parts: {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}): string {
  const hasProject = (parts.projectId ?? "").length > 0;
  const hasManaged = (parts.managedProjectId ?? "").length > 0;
  if (!hasProject && !hasManaged) return parts.refreshToken;
  return `${parts.refreshToken}|${parts.projectId ?? ""}|${parts.managedProjectId ?? ""}`;
}

async function writeAuthJson(opts: {
  access: string;
  refresh: string;
  expires: number;
}): Promise<void> {
  // The refresh token is a long-lived credential — keep the directory and file
  // owner-only (0700/0600). We write only the keys opencode itself uses so we
  // never break its own parsing of this shared file.
  await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  const existingRaw = await fs.readFile(AUTH_JSON_PATH, "utf-8").catch(() => "{}");
  const existing = JSON.parse(existingRaw) as Record<string, unknown>;
  const google = (existing.google ?? {}) as Record<string, unknown>;
  const updated = {
    ...existing,
    google: {
      ...google,
      type: "oauth",
      access: opts.access,
      refresh: opts.refresh,
      expires: opts.expires,
    },
  };
  await fs.writeFile(AUTH_JSON_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 });
  // Enforce 0600 even if the file pre-existed with looser permissions.
  await fs.chmod(AUTH_JSON_PATH, 0o600).catch(() => {});
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loginWithGoogle(
  openExternal: (url: string) => Promise<void>,
): Promise<{ email?: string }> {
  const { verifier, challenge } = buildPkce();
  const state = randomBytes(32).toString("hex");
  const server = startCallbackServer(state);
  try {
    await server.ready;
    await openExternal(buildAuthUrl(challenge, state));
    const code = await server.code;
    const tokens = await exchangeCode(code, verifier);
    const email = await fetchEmail(tokens.access);
    const managedProjectId = await resolveManagedProject(tokens.access);
    const refresh = formatRefreshParts({
      refreshToken: tokens.refresh,
      managedProjectId,
    });
    await writeAuthJson({ access: tokens.access, refresh, expires: tokens.expires });
    return { email };
  } finally {
    server.close();
  }
}

export async function getGeminiAuthStatus(): Promise<GeminiAuthStatus> {
  try {
    const raw = await fs.readFile(AUTH_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { google?: { refresh?: string; email?: string } };
    const refresh = parsed.google?.refresh;
    if (typeof refresh === "string" && refresh.length > 0) {
      return { connected: true, email: parsed.google?.email };
    }
  } catch {
    // No auth file yet.
  }
  return { connected: false };
}
