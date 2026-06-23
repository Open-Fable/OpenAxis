import { ipcMain, WebContents } from "electron";
import { readSecret, isSafeOllamaUrl } from "./keychain.js";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

interface OllamaProgress {
  model: string;
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

interface PullState {
  model: string;
  abortController: AbortController;
}

const activePulls = new Map<string, PullState>();

async function getOllamaUrl(): Promise<string> {
  const url = await readSecret("openaxis", "ollama-url");
  // Reject unsafe (cloud-metadata / link-local) hosts even if one slipped into the
  // store — falls back to loopback rather than letting fetch() pivot internally.
  if (url && isSafeOllamaUrl(url)) return url;
  return DEFAULT_OLLAMA_URL;
}

export async function checkOllamaModels(): Promise<{
  installed: string[];
  missing: string[];
  pulling: string[];
  running: boolean;
}> {
  const modelsToEnsure = ["qwen2.5:1.5b", "openbmb/minicpm-v4.6"];
  const url = await getOllamaUrl();
  const pulling = Array.from(activePulls.keys());

  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok)
      return { installed: [], missing: modelsToEnsure, pulling, running: false };

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const installedNames = (data.models || []).map((m) => m.name);

    const installed = modelsToEnsure.filter((req) =>
      installedNames.some((inst) => inst === req || inst === `${req}:latest`),
    );
    const missing = modelsToEnsure.filter(
      (req) => !installedNames.some((inst) => inst === req || inst === `${req}:latest`),
    );

    return { installed, missing, pulling, running: true };
  } catch {
    return { installed: [], missing: modelsToEnsure, pulling, running: false };
  }
}

async function pullModel(model: string, webContents: WebContents): Promise<void> {
  if (activePulls.has(model)) return;

  // The renderer may be torn down mid-pull; guard every send.
  const send = (payload: OllamaProgress | Record<string, unknown>): void => {
    if (!webContents.isDestroyed()) webContents.send("ollama-pull-progress", payload);
  };

  const url = await getOllamaUrl();
  const abortController = new AbortController();
  activePulls.set(model, { model, abortController });

  try {
    const res = await fetch(`${url}/api/pull`, {
      method: "POST",
      body: JSON.stringify({ name: model }),
      signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to pull model ${model}: ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Garde la ligne incomplète pour le prochain chunk

      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          const json = JSON.parse(line) as OllamaProgress;
          if (json.total && json.completed) {
            json.percent = Math.round((json.completed / json.total) * 100);
          }
          json.model = model;
          send(json);
        } catch {
          // Ligne peut-être encore incomplète malgré le split
        }
      }
    }

    activePulls.delete(model);
    send({ model, status: "success", percent: 100 });
  } catch (err) {
    activePulls.delete(model);
    if (err instanceof Error && err.name === "AbortError") {
      send({ model, status: "canceled" });
    } else {
      console.error(`[ollama-manager] Error pulling ${model}:`, err);
      send({
        model,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// These channels are only used by the local sidebar UI (file://). Gate them so a
// remote slot view cannot trigger arbitrary model downloads.
function fromLocalUi(e: { senderFrame?: { url?: string } | null }): boolean {
  return (e.senderFrame?.url ?? "").startsWith("file://");
}

export function registerOllamaHandlers(): void {
  ipcMain.handle("ollama-check-models", (e) => {
    if (!fromLocalUi(e)) throw new Error("forbidden");
    return checkOllamaModels();
  });

  ipcMain.on("ollama-pull-model", (event, model: string) => {
    if (!fromLocalUi(event)) return;
    if (typeof model !== "string" || model.length === 0) return;
    pullModel(model, event.sender);
  });

  ipcMain.on("ollama-cancel-pull", (event, model: string) => {
    if (!fromLocalUi(event)) return;
    const state = activePulls.get(model);
    if (state) {
      state.abortController.abort();
      activePulls.delete(model);
    }
  });
}
