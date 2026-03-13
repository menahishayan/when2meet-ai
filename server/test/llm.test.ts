import { describe, expect, it, vi } from "vitest";
import {
  extractProviderDelta,
  handleLlmStream,
  LlmUpstreamError,
  validateLlmStreamRequestBody,
} from "../src/llm.js";

type MockSseRes = {
  writes: string[];
  write: (chunk: string) => boolean;
};

function makeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

function createMockSseRes(): MockSseRes {
  return {
    writes: [],
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
  };
}

describe("validateLlmStreamRequestBody", () => {
  it("accepts valid request payload", () => {
    const parsed = validateLlmStreamRequestBody({
      provider: "chatgpt",
      apiKey: "abc",
      query: "Who is free?",
      availabilitiesByPerson: {
        Alice: ["3/13/2026, 3:00:00 PM"],
      },
    });

    expect(parsed.provider).toBe("chatgpt");
    expect(parsed.apiKey).toBe("abc");
  });

  it("rejects unsupported provider", () => {
    expect(() =>
      validateLlmStreamRequestBody({
        provider: "unknown",
        apiKey: "abc",
        query: "Who is free?",
        availabilitiesByPerson: {},
      }),
    ).toThrowError(/provider/i);
  });
});

describe("extractProviderDelta", () => {
  it("extracts text deltas for chatgpt", () => {
    const delta = extractProviderDelta(
      "chatgpt",
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
    );

    expect(delta).toBe("Hello");
  });

  it("extracts text deltas for claude", () => {
    const delta = extractProviderDelta(
      "claude",
      JSON.stringify({ type: "content_block_delta", delta: { text: "Hi" } }),
    );

    expect(delta).toBe("Hi");
  });

  it("extracts text deltas for gemini", () => {
    const delta = extractProviderDelta(
      "gemini",
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Hello world" }] } }],
      }),
    );

    expect(delta).toBe("Hello world");
  });
});

describe("handleLlmStream", () => {
  it("streams chatgpt deltas as SSE data lines", async () => {
    const fetchMock = vi.fn(async () =>
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const res = createMockSseRes();

    await handleLlmStream(
      {
        provider: "chatgpt",
        apiKey: "test-key",
        query: "Find a good slot",
        availabilitiesByPerson: { Alice: ["Friday 4 PM"] },
      },
      fetchMock as never,
      res as never,
    );

    expect(res.writes.join(""))
      .toContain('data: {"delta":"Hello"}');
    expect(res.writes.join(""))
      .toContain('data: {"delta":" there"}');
  });

  it("throws on non-OK upstream response", async () => {
    const fetchMock = vi.fn(async () => new Response("bad key", { status: 401 }));
    const res = createMockSseRes();

    await expect(
      handleLlmStream(
        {
          provider: "chatgpt",
          apiKey: "bad-key",
          query: "Find a slot",
          availabilitiesByPerson: { Alice: ["Friday 4 PM"] },
        },
        fetchMock as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(LlmUpstreamError);
  });

  it("resolves claude model from /v1/models before streaming", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "claude-3-5-haiku-latest" }, { id: "claude-3-7-sonnet-latest" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockImplementationOnce(async () =>
        makeSseResponse([
          'data: {"type":"content_block_delta","delta":{"text":"Ready"}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

    const res = createMockSseRes();

    await handleLlmStream(
      {
        provider: "claude",
        apiKey: "claude-key",
        query: "Best schedule?",
        availabilitiesByPerson: { Alice: ["Friday 4 PM"] },
      },
      fetchMock as never,
      res as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.anthropic.com/v1/models");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.anthropic.com/v1/messages");

    const secondBody = String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body);
    expect(secondBody).toContain("claude-3-7-sonnet-latest");
    expect(res.writes.join("")).toContain('data: {"delta":"Ready"}');
  });
});
