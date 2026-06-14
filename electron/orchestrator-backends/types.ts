import type { Project } from "../project-store.js";

export interface BackendContext {
  readonly node: Project;
  readonly workspaceDir: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly fallbackModel?: string;
  readonly signal?: AbortSignal;
  readonly onProgress: (label: string) => void;
}

export interface BackendResult {
  readonly resultText: string;
  readonly backend: "opencode" | "open-design";
}

export class BackendUnavailableError extends Error {
  constructor(backend: string, cause?: unknown) {
    super(`Backend "${backend}" is unavailable`);
    this.name = "BackendUnavailableError";
    if (cause) this.cause = cause;
  }
}

export interface ExecutionBackend {
  readonly slot: "code" | "design";
  /**
   * The local API port this backend actually communicates with. Note this can
   * differ from the port `ensureRunning(slot)` returns: for "design" that
   * function returns the web-UI port (loaded in the Design tab), while the
   * backend talks to the daemon API on this port.
   */
  readonly apiPort: number;
  isAvailable(): Promise<boolean>;
  execute(ctx: BackendContext): Promise<BackendResult>;
}
