import keytar from "keytar";
import net from "net";

const SERVICE = "openhub";

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

export async function readSecret(
  service: string,
  account: string,
): Promise<string | null> {
  return keytar.getPassword(service, account);
}

export async function writeSecret(
  service: string,
  account: string,
  secret: string,
): Promise<void> {
  await keytar.setPassword(service, account, secret);
}

export async function deleteSecret(service: string, account: string): Promise<void> {
  await keytar.deletePassword(service, account);
}

export async function readAllApiKeys(): Promise<{
  anthropic: string | null;
  openai: string | null;
  openrouterKey: string | null;
  googleAiKey: string | null;
  githubToken: string | null;
  braveSearchKey: string | null;
  ollamaUrl: string;
}> {
  const [
    anthropic,
    openai,
    openrouterKey,
    googleAiKey,
    githubToken,
    braveSearchKey,
    ollamaUrl,
  ] = await Promise.all([
    keytar.getPassword(SERVICE, "anthropic-api-key"),
    keytar.getPassword(SERVICE, "openai-api-key"),
    keytar.getPassword(SERVICE, "openrouter-api-key"),
    keytar.getPassword(SERVICE, "google-ai-key"),
    keytar.getPassword(SERVICE, "github-token"),
    keytar.getPassword(SERVICE, "brave-search-key"),
    keytar.getPassword(SERVICE, "ollama-url"),
  ]);

  return {
    anthropic,
    openai,
    openrouterKey,
    googleAiKey,
    githubToken,
    braveSearchKey,
    ollamaUrl: ollamaUrl ?? "http://127.0.0.1:11434",
  };
}
