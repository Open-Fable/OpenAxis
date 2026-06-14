import type { BackendContext, ExecutionBackend, BackendResult } from "./types.js";
import { BackendUnavailableError } from "./types.js";
import { OpencodeBackend } from "./opencode-backend.js";
import { DesignBackend } from "./design-backend.js";

export { BackendUnavailableError } from "./types.js";
export type { BackendContext, BackendResult } from "./types.js";

const opencodeBackend = new OpencodeBackend();
const designBackend = new DesignBackend();

const BACKEND_MAP: Record<string, ExecutionBackend | null> = {
  code: opencodeBackend,
  work: opencodeBackend,
  design: designBackend,
  recherche: null,
  verifier: null,
};

export function selectBackend(type: string | undefined): ExecutionBackend | null {
  return BACKEND_MAP[type ?? ""] ?? null;
}

export async function executeWithBackend(
  ctx: BackendContext,
  ensureRunning: (slot: "code" | "design") => Promise<number | null>,
): Promise<BackendResult> {
  const backend = selectBackend(ctx.node.type);
  if (!backend) {
    throw new BackendUnavailableError(ctx.node.type ?? "unknown");
  }

  console.warn(
    `[backend] executeWithBackend: type="${ctx.node.type}" → slot="${backend.slot}"`,
  );

  console.warn(`[backend] Ensuring slot "${backend.slot}" is running…`);
  const lifecyclePort = await ensureRunning(backend.slot);
  const portNote =
    lifecyclePort === backend.apiPort
      ? `port=${lifecyclePort}`
      : `lifecycle/UI port=${lifecyclePort}, API port=${backend.apiPort}`;
  console.warn(`[backend] ensureRunning("${backend.slot}") → ${portNote}`);

  console.warn(`[backend] Checking availability (API :${backend.apiPort})…`);
  const available = await backend.isAvailable();
  if (!available) {
    console.warn(`[backend] ✗ Backend "${backend.slot}" is NOT available — throwing`);
    throw new BackendUnavailableError(backend.slot);
  }
  console.warn(`[backend] ✓ Backend "${backend.slot}" is available — executing`);

  return backend.execute(ctx);
}
