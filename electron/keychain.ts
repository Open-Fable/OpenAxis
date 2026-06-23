import { app } from "electron";
import { promises as fs, readFileSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { execFileSync } from "child_process";
import path from "path";
import net from "net";

const SERVICE = "openaxis";

// Secrets are stored in a single AES-256-GCM encrypted file under userData.
// The encryption key is derived from the machine's hardware UUID + a public,
// in-source salt. This avoids the macOS Keychain entirely (which, under ad-hoc
// signing, re-prompts for the login password on every launch).
//
// THREAT MODEL — be honest: the salt is public and the hardware UUID is readable
// by any unprivileged local process (`ioreg`). So this is machine-binding /
// obfuscation, NOT confidentiality against a local attacker running as the same
// user — such a process can re-derive the key and decrypt this file. It is on par
// with Chromium's `password-store=basic`. It DOES stop the file from being read
// on a different machine and from casual inspection. The real boundary remains
// the OS user account + 0600 file perms.
const SECRETS_FILE = "secrets.enc";

// Display mask for secrets sent to the renderer. The "…" character never appears in
// a real API key, so it doubles as a reliable "this is a mask, don't save it" marker.
const MASK_CHAR = "…";

export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return MASK_CHAR.repeat(4);
  return value.slice(0, 4) + MASK_CHAR + value.slice(-4);
}

export function isMaskedValue(value: string): boolean {
  return value.includes(MASK_CHAR);
}

// Rejects Ollama base URLs that point at cloud-metadata / link-local / reserved
// addresses (SSRF defense). Loopback and private LAN hosts stay allowed because a
// real user may run Ollama on a self/LAN GPU box, but every cloud-metadata vector
// (169.254.169.254 and its IPv6, decimal, hex and octal encodings) is closed.
export function isSafeOllamaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // URL keeps IPv6 literals wrapped in brackets; strip them and a trailing dot.
    const host = u.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (host.length === 0) return false;
    if (host === "metadata.google.internal" || host === "metadata") return false;

    const family = net.isIP(host);
    if (family === 0) {
      // Not a literal IP. Reject all-numeric hosts (decimal/hex/octal IP encodings
      // such as 2852039166 or 0xa9fea9fe that bypass the link-local check below).
      if (/^(0x[0-9a-f]+|\d+)$/.test(host)) return false;
      return true; // ordinary DNS name (e.g. localhost, my-gpu.lan)
    }
    return family === 6 ? !isReservedIpv6(host) : !isReservedIpv4(host);
  } catch {
    return false;
  }
}

function isReservedIpv4(ip: string): boolean {
  const o = ip.split(".").map((p) => Number(p));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — fail closed
  }
  const [a, b] = o;
  if (a === 0) return true; // "this" network / 0.0.0.0
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isReservedIpv6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::") return true; // unspecified / 0.0.0.0-equivalent
  if (low === "::1") return false; // loopback ok
  if (low.startsWith("fe80")) return true; // link-local
  // IPv4-mapped (::ffff:…) — Node normalizes the dotted form to hex groups
  // (::ffff:a9fe:a9fe), so handle both and re-check the embedded IPv4.
  const mapped = low.match(/^::ffff:(.+)$/);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return isReservedIpv4(rest);
    const groups = rest.split(":");
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const v4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
        return isReservedIpv4(v4);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Encrypted store (AES-256-GCM, key derived from hardware UUID)
// ---------------------------------------------------------------------------

type SecretStore = Record<string, Record<string, string>>;

let store: SecretStore | null = null;
let loadPromise: Promise<SecretStore> | null = null;
let secretsPath: string | null = null;
let derivedKey: Buffer | null = null;
// True when the secrets file existed but could not be decrypted/parsed (key
// mismatch or corruption). We must NOT silently overwrite it on the next save —
// that would permanently destroy recoverable data. Instead saveStore() moves the
// unreadable file aside first.
let loadCorrupted = false;

const APP_SALT = "openaxis-secrets-v1";

function getSecretsPath(): string {
  if (!secretsPath) {
    secretsPath = path.join(app.getPath("userData"), SECRETS_FILE);
  }
  return secretsPath;
}

const FALLBACK_KEY_FILE = "machine-key.bin";

function getOrCreateFallbackKey(): string {
  const keyPath = path.join(app.getPath("userData"), FALLBACK_KEY_FILE);
  try {
    const existing = readFileSync(keyPath);
    if (existing.length === 32) return existing.toString("hex");
  } catch {
    /* doesn't exist yet */
  }
  const key = randomBytes(32);
  mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key.toString("hex");
}

function getDerivedKey(): Buffer {
  if (derivedKey) return derivedKey;
  let hwUuid: string;
  try {
    const raw = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString();
    const match = raw.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) {
      hwUuid = match[1];
    } else {
      console.warn(
        "[keychain] ioreg returned no IOPlatformUUID — using per-machine random fallback",
      );
      hwUuid = getOrCreateFallbackKey();
    }
  } catch {
    console.warn("[keychain] ioreg failed — using per-machine random fallback");
    hwUuid = getOrCreateFallbackKey();
  }
  derivedKey = createHash("sha256").update(`${APP_SALT}:${hwUuid}`).digest();
  return derivedKey;
}

function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getDerivedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [iv 12B][tag 16B][ciphertext]
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(data: Buffer): string {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getDerivedKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function loadStore(): Promise<SecretStore> {
  if (store) return store;
  if (loadPromise) return loadPromise;
  loadPromise = doLoadStore();
  return loadPromise;
}

async function doLoadStore(): Promise<SecretStore> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(getSecretsPath());
  } catch {
    // No file yet (first run) — an empty store is correct.
    store = {};
    return store;
  }
  // The file exists. If decrypt/parse fails the data is present but unreadable
  // (key mismatch or corruption) — flag it so saveStore() preserves it instead
  // of clobbering, rather than pretending the secrets simply vanished.
  try {
    store = JSON.parse(decrypt(raw)) as SecretStore;
  } catch {
    loadCorrupted = true;
    console.error(
      "[keychain] secrets file present but unreadable (key mismatch or corruption); " +
        "it will be backed up on next save and not overwritten.",
    );
    store = {};
  }
  return store;
}

async function saveStore(): Promise<void> {
  if (!store) return;
  const json = JSON.stringify(store);
  const encrypted = encrypt(json);
  const filePath = getSecretsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // If the prior file couldn't be decrypted, move it aside before writing so the
  // user can still recover it manually — never destroy it silently.
  if (loadCorrupted) {
    await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => undefined);
    loadCorrupted = false;
  }

  // Atomic write: a crash mid-write would otherwise truncate the file, making
  // EVERY stored secret unrecoverable on next launch. Write to a fresh 0600 temp
  // file then rename over the target.
  const tmpPath = `${filePath}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, encrypted, { mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures)
// ---------------------------------------------------------------------------

export async function readSecret(
  service: string,
  account: string,
): Promise<string | null> {
  const s = await loadStore();
  return s[service]?.[account] ?? null;
}

export async function writeSecret(
  service: string,
  account: string,
  secret: string,
): Promise<void> {
  const s = await loadStore();
  const updated = {
    ...s,
    [service]: { ...s[service], [account]: secret },
  };
  store = updated;
  await saveStore();
}

export async function deleteSecret(service: string, account: string): Promise<void> {
  const s = await loadStore();
  const bucket = s[service];
  if (!bucket || !(account in bucket)) return;
  const rest = Object.fromEntries(Object.entries(bucket).filter(([k]) => k !== account));
  store = { ...s, [service]: rest };
  await saveStore();
}

export async function readAllApiKeys(): Promise<{
  anthropic: string | null;
  openai: string | null;
  openrouterKey: string | null;
  googleAiKey: string | null;
  githubToken: string | null;
  braveSearchKey: string | null;
  ollamaUrl: string;
  deepseek: string | null;
  customKeys: Record<string, string>;
}> {
  const s = await loadStore();
  const svc = s[SERVICE] ?? {};

  const customKeys: Record<string, string> = {};
  try {
    const settingsPath = path.join(homedir(), ".config", "openaxis", "settings.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const providers = parsed.customProviders || [];
    for (const p of providers) {
      const field = `custom-provider-key-${p.id}`;
      const val = svc[field];
      if (val) {
        customKeys[p.id] = val;
      }
    }
  } catch {
    // Ignore settings.json read errors
  }

  return {
    anthropic: svc["anthropic-api-key"] ?? null,
    openai: svc["openai-api-key"] ?? null,
    openrouterKey: svc["openrouter-api-key"] ?? null,
    googleAiKey: svc["google-ai-key"] ?? null,
    githubToken: svc["github-token"] ?? null,
    braveSearchKey: svc["brave-search-key"] ?? null,
    ollamaUrl: svc["ollama-url"] ?? "http://127.0.0.1:11434",
    deepseek: svc["deepseek-api-key"] ?? null,
    customKeys,
  };
}
