import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project } from "./project-store.js";
import {
  setProxyToken,
  callLLM,
  callLLMWithTools,
  callLLMStreaming,
  callLLMStructured,
  type StructuredTool,
} from "./orchestrator-llm.js";

const VERDICT_TOOL: StructuredTool = {
  name: "report_verdict",
  description: "Report a verdict.",
  parameters: {
    type: "object",
    properties: { pass: { type: "boolean" } },
    required: ["pass"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<Project> = {}): Project {
  return {
    id: "node-1",
    name: "Agent",
    instructions: "",
    color: "#fff",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// Builds a non-streaming OpenAI-style chat completion response.
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Builds a streaming (SSE) Response whose body.getReader() yields the given
// chunks as encoded Uint8Arrays, mimicking the proxy's `data: {...}` frames.
function streamResponse(chunks: string[], ok = true, status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok,
    status,
    text: async () => "",
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            return { done: false, value: encoder.encode(chunks[i++]) };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setProxyToken("test-token-abc");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// callLLM
// ---------------------------------------------------------------------------

describe("callLLM", () => {
  it("sends the Bearer proxy token and project id header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    await callLLM(makeNode({ id: "proj-42" }), "sys", "user");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token-abc");
    expect(init.headers["X-OpenAxis-Project-Id"]).toBe("proj-42");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("returns the assistant message content", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "réponse" } }] }),
    );

    const result = await callLLM(makeNode(), "sys", "user");

    expect(result).toBe("réponse");
  });

  it("returns empty string when no choices are present", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [] }));

    const result = await callLLM(makeNode(), "sys", "user");

    expect(result).toBe("");
  });

  it("uses the node model over the fallback and DEFAULT_MODEL", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );

    await callLLM(
      makeNode({ model: "claude-3-opus-latest" }),
      "s",
      "u",
      undefined,
      false,
      "fallback-model",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("claude-3-opus-latest");
  });

  it("falls back to the fallbackModel when node has no model", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );

    await callLLM(makeNode(), "s", "u", undefined, false, "fallback-model");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("fallback-model");
  });

  it("defaults to deepseek/deepseek-chat when nothing is provided", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );

    await callLLM(makeNode(), "s", "u");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("deepseek/deepseek-chat");
  });

  it("includes reasoning_effort when set, omits it when 'none'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );

    await callLLM(makeNode({ reasoningEffort: "high" }), "s", "u");
    const withEffort = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(withEffort.reasoning_effort).toBe("high");

    fetchMock.mockClear();
    await callLLM(makeNode({ reasoningEffort: "none" }), "s", "u");
    const noEffort = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(noEffort.reasoning_effort).toBeUndefined();
  });

  it("propagates bypassInjection from the bypassMemory flag", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );

    await callLLM(makeNode({ bypassMemory: true }), "s", "u");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bypassInjection).toBe(true);
  });

  it("throws a credit-specific error on HTTP 402", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 402));

    await expect(callLLM(makeNode(), "s", "u")).rejects.toThrow(/Crédits insuffisants/);
  });

  it("throws a generic proxy error on other non-ok responses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    });

    await expect(callLLM(makeNode(), "s", "u")).rejects.toThrow(/Proxy error: boom/);
  });

  it("throws when the abort signal is already aborted (no fetch issued)", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(callLLM(makeNode(), "s", "u", controller.signal)).rejects.toThrow(
      /annulée par l'utilisateur/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// callLLMWithTools
// ---------------------------------------------------------------------------

describe("callLLMWithTools", () => {
  it("returns the message and finish reason from the response", async () => {
    const toolCall = {
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: "{}" },
    };
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: null, tool_calls: [toolCall] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const result = await callLLMWithTools(makeNode(), [], []);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.message.tool_calls?.[0].function.name).toBe("search");
    expect(result.message.content).toBeNull();
  });

  it("defaults role to assistant and finishReason to stop", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{}] }));

    const result = await callLLMWithTools(makeNode(), [], []);

    expect(result.message.role).toBe("assistant");
    expect(result.finishReason).toBe("stop");
  });

  it("always sets bypassInjection true (tool loop never injects memory)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{}] }));

    await callLLMWithTools(makeNode(), [], []);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bypassInjection).toBe(true);
  });

  it("throws a credit error on HTTP 402", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 402));

    await expect(callLLMWithTools(makeNode(), [], [])).rejects.toThrow(
      /Crédits insuffisants/,
    );
  });

  it("forwards tool_choice when provided, omits it otherwise", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{}] }));
    await callLLMWithTools(
      makeNode(),
      [],
      [],
      undefined,
      undefined,
      undefined,
      "required",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_choice).toBe("required");

    fetchMock.mockClear();
    await callLLMWithTools(makeNode(), [], []);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_choice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// callLLMStructured
// ---------------------------------------------------------------------------

describe("callLLMStructured", () => {
  it("forces the single tool via tool_choice:required", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{}] }));

    await callLLMStructured(makeNode(), "sys", "user", VERDICT_TOOL);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("report_verdict");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({ role: "user", content: "user" });
  });

  it("returns the tool-call arguments as a JSON string", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "report_verdict", arguments: '{"pass":true}' },
                },
              ],
            },
          },
        ],
      }),
    );

    const raw = await callLLMStructured(makeNode(), "s", "u", VERDICT_TOOL);

    expect(JSON.parse(raw)).toEqual({ pass: true });
  });

  it("falls back to plain text content when the provider ignores the forcing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: '{"pass":false}' } }],
      }),
    );

    const raw = await callLLMStructured(makeNode(), "s", "u", VERDICT_TOOL);

    expect(raw).toBe('{"pass":false}');
  });

  it("returns empty string when there is neither a tool call nor content", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{}] }));

    const raw = await callLLMStructured(makeNode(), "s", "u", VERDICT_TOOL);

    expect(raw).toBe("");
  });
});

// ---------------------------------------------------------------------------
// callLLMStreaming
// ---------------------------------------------------------------------------

describe("callLLMStreaming", () => {
  it("accumulates streamed delta content across frames", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Bon"}}]}\n',
        'data: {"choices":[{"delta":{"content":"jour"}}]}\n',
        "data: [DONE]\n",
      ]),
    );

    const result = await callLLMStreaming(makeNode(), "prompt", 5000);

    expect(result).toBe("Bonjour");
  });

  it("includes the system prompt as the first message when provided", async () => {
    fetchMock.mockResolvedValue(streamResponse(["data: [DONE]\n"]));

    await callLLMStreaming(makeNode(), "prompt", 5000, undefined, "system-here");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: "system", content: "system-here" });
    expect(body.messages[1]).toEqual({ role: "user", content: "prompt" });
    expect(body.stream).toBe(true);
  });

  it("ignores malformed JSON frames without throwing", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"A"}}]}\n',
        "data: {not valid json}\n",
        'data: {"choices":[{"delta":{"content":"B"}}]}\n',
      ]),
    );

    const result = await callLLMStreaming(makeNode(), "prompt", 5000);

    expect(result).toBe("AB");
  });

  it("throws a credit error on HTTP 402 before streaming", async () => {
    fetchMock.mockResolvedValue(streamResponse([], false, 402));

    await expect(callLLMStreaming(makeNode(), "p", 5000)).rejects.toThrow(
      /Crédits insuffisants/,
    );
  });

  it("throws when the response has no readable body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      body: null,
    });

    await expect(callLLMStreaming(makeNode(), "p", 5000)).rejects.toThrow(
      /Impossible de lire le flux/,
    );
  });

  it("throws cancellation error when the orchestration signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      callLLMStreaming(makeNode(), "p", 5000, controller.signal),
    ).rejects.toThrow(/annulée par l'utilisateur/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
