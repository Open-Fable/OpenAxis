import type { Project } from "./project-store.js";

const PROXY_URL = "http://127.0.0.1:9999/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-chat";

// The per-session proxy token, injected by main.ts after the proxy starts.
// There is no static fallback: requests fail closed until the token is set.
let proxyToken = "";

export function setProxyToken(token: string): void {
  proxyToken = token;
}

function proxyHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${proxyToken}`,
  };
}

export interface ToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: { readonly name: string; readonly arguments: string };
  readonly thought_signature?: string;
}

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCallResponse {
  readonly message: ChatMessage;
  readonly finishReason: string;
}

function getModel(node: Project, fallback?: string): string {
  return node.model || fallback || DEFAULT_MODEL;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Orchestration annulée par l'utilisateur.");
  }
}

function getReasoningEffort(node: Project, fallback?: string): string | undefined {
  const effort = node.reasoningEffort || fallback;
  if (!effort || effort === "none") return undefined;
  return effort;
}

export async function callLLM(
  node: Project,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  bypassMemory = false,
  fallbackModel?: string,
  fallbackReasoningEffort?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: getModel(node, fallbackModel),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 16384,
    stream: false,
    bypassInjection: bypassMemory || Boolean(node.bypassMemory),
  };
  const effort = getReasoningEffort(node, fallbackReasoningEffort);
  if (effort) body.reasoning_effort = effort;

  checkAborted(signal);

  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify(body),
    signal: signal ?? undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 402) {
      throw new Error(`Crédits insuffisants sur le fournisseur LLM. ${text}`);
    }
    throw new Error(`Proxy error: ${text}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

export async function callLLMWithTools(
  node: Project,
  messages: readonly ChatMessage[],
  tools: readonly Record<string, unknown>[],
  signal?: AbortSignal,
  fallbackModel?: string,
  fallbackReasoningEffort?: string,
): Promise<ToolCallResponse> {
  const body: Record<string, unknown> = {
    model: getModel(node, fallbackModel),
    messages,
    tools,
    temperature: 0.1,
    max_tokens: 16384,
    stream: false,
    bypassInjection: true,
  };
  const effort = getReasoningEffort(node, fallbackReasoningEffort);
  if (effort) body.reasoning_effort = effort;

  checkAborted(signal);

  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify(body),
    signal: signal ?? undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 402) {
      throw new Error(`Crédits insuffisants sur le fournisseur LLM. ${text}`);
    }
    throw new Error(`Proxy error: ${text}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        role?: string;
        content?: string | null;
        tool_calls?: ToolCall[];
      };
      finish_reason?: string;
    }>;
  };

  const choice = json.choices?.[0];
  const msg: ChatMessage = {
    role: choice?.message?.role ?? "assistant",
    content: choice?.message?.content ?? null,
    tool_calls: choice?.message?.tool_calls,
  };
  return { message: msg, finishReason: choice?.finish_reason ?? "stop" };
}

export async function callLLMStreaming(
  node: Project,
  prompt: string,
  timeoutMs: number,
  orchSignal?: AbortSignal,
  systemPrompt?: string,
  fallbackModel?: string,
  fallbackReasoningEffort?: string,
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model: getModel(node, fallbackModel),
    messages,
    stream: true,
    temperature: 0.1,
    max_tokens: 32768,
    bypassInjection: Boolean(node.bypassMemory),
  };
  const effort = getReasoningEffort(node, fallbackReasoningEffort);
  if (effort) body.reasoning_effort = effort;

  const controller = new AbortController();
  checkAborted(orchSignal);
  orchSignal?.addEventListener("abort", () => controller.abort(), { once: true });

  const timeoutSignal = controller.signal;

  // Two budgets: a generous FIRST-TOKEN window (a high-reasoning model may
  // "think" well beyond the inter-chunk budget before emitting anything) and a
  // tighter INTER-CHUNK window (once streaming, a long gap means a real stall).
  // timeoutMs is the inter-chunk budget; the first-token budget scales with it
  // and with reasoning effort so big single-turn deliverables aren't killed.
  const interChunkMs = timeoutMs;
  const firstTokenMs =
    effort === "high" || effort === "max"
      ? Math.max(timeoutMs, 600_000)
      : Math.max(timeoutMs, 180_000);
  let firstChunkReceived = false;

  let timer: NodeJS.Timeout | undefined = undefined;
  const resetTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(
      () => {
        console.warn("[watchdog] Timeout! Aborting request...");
        controller.abort();
      },
      firstChunkReceived ? interChunkMs : firstTokenMs,
    );
  };

  resetTimer();

  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify(body),
    signal: timeoutSignal,
  });

  if (!response.ok) {
    clearTimeout(timer);
    const text = await response.text();
    if (response.status === 402) {
      throw new Error(`Crédits insuffisants sur le fournisseur LLM. ${text}`);
    }
    throw new Error(`Proxy error (${response.status}): ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    throw new Error("Impossible de lire le flux de réponse du proxy.");
  }

  const decoder = new TextDecoder("utf-8");
  let accumulatedText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      firstChunkReceived = true;
      resetTimer();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const text = parsed.choices?.[0]?.delta?.content;
            if (typeof text === "string") {
              accumulatedText += text;
            }
          } catch {}
        }
      }
    }
    return accumulatedText;
  } catch (err: unknown) {
    if (orchSignal?.aborted) {
      throw new Error("Orchestration annulée par l'utilisateur.");
    }
    if (timeoutSignal.aborted) {
      throw new Error("WATCHDOG_TIMEOUT");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
