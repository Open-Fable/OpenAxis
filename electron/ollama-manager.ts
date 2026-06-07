import { ipcMain, WebContents } from "electron";
import { readSecret } from "./keychain.js";

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
  const url = await readSecret("openhub", "ollama-url");
  return url || "http://127.0.0.1:11434";
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
    if (!res.ok) return { installed: [], missing: modelsToEnsure, pulling, running: false };

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const installedNames = (data.models || []).map((m) => m.name);
    
    const installed = modelsToEnsure.filter(req => 
      installedNames.some(inst => inst === req || inst === `${req}:latest`)
    );
    const missing = modelsToEnsure.filter(req => 
      !installedNames.some(inst => inst === req || inst === `${req}:latest`)
    );

    return { installed, missing, pulling, running: true };
  } catch {
    return { installed: [], missing: modelsToEnsure, pulling, running: false };
  }
}

async function pullModel(
  model: string,
  webContents: WebContents
): Promise<void> {
  if (activePulls.has(model)) return;

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
          webContents.send("ollama-pull-progress", json);
        } catch (e) {
          // Ligne peut-être encore incomplète malgré le split
        }
      }
    }

    activePulls.delete(model);
    webContents.send("ollama-pull-progress", { model, status: "success", percent: 100 });
  } catch (err) {
    activePulls.delete(model);
    if ((err as any).name === "AbortError") {
      webContents.send("ollama-pull-progress", { model, status: "canceled" });
    } else {
      console.error(`[ollama-manager] Error pulling ${model}:`, err);
      webContents.send("ollama-pull-progress", {
        model,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function registerOllamaHandlers(): void {
  ipcMain.handle("ollama-check-models", () => checkOllamaModels());

  ipcMain.on("ollama-pull-model", (event, model: string) => {
    pullModel(model, event.sender);
  });

  ipcMain.on("ollama-cancel-pull", (_event, model: string) => {
    const state = activePulls.get(model);
    if (state) {
      state.abortController.abort();
      activePulls.delete(model);
    }
  });
}
