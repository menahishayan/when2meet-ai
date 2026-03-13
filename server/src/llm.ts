import type { Response as ExpressResponse } from "express";

export type LlmProvider = "chatgpt" | "claude" | "gemini";
export type LlmMode = "default" | "custom";

export type ChatHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type LlmStreamRequestBody = {
  mode: LlmMode;
  provider: LlmProvider;
  apiKey: string;
  query: string;
  availabilitiesByPerson: Record<string, string[]>;
  history: ChatHistoryTurn[];
};

export class LlmValidationError extends Error {}
export class LlmUpstreamError extends Error {}

type ProviderRequest = {
  url: string;
  init: RequestInit;
};

const claudeModelCache = new Map<string, string>();
const geminiModelCache = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProvider(value: string): value is LlmProvider {
  return value === "chatgpt" || value === "claude" || value === "gemini";
}

function isMode(value: string): value is LlmMode {
  return value === "default" || value === "custom";
}

function isHistoryRole(value: string): value is ChatHistoryTurn["role"] {
  return value === "user" || value === "assistant";
}

export function validateLlmStreamRequestBody(body: unknown): LlmStreamRequestBody {
  if (!isRecord(body)) {
    throw new LlmValidationError("Request body must be a JSON object.");
  }

  const mode = String(body.mode ?? "custom")
    .trim()
    .toLowerCase();
  const provider = String(body.provider ?? "")
    .trim()
    .toLowerCase();
  const apiKey = String(body.apiKey ?? "").trim();
  const query = String(body.query ?? "").trim();
  const availabilitiesRaw = body.availabilitiesByPerson;
  const historyRaw = body.history ?? [];

  if (!isMode(mode)) {
    throw new LlmValidationError("mode must be one of: default, custom.");
  }

  if (!isProvider(provider)) {
    throw new LlmValidationError("provider must be one of: chatgpt, claude, gemini.");
  }

  if (mode === "custom" && !apiKey) {
    throw new LlmValidationError("apiKey is required.");
  }

  if (!query) {
    throw new LlmValidationError("query is required.");
  }

  if (!isRecord(availabilitiesRaw)) {
    throw new LlmValidationError("availabilitiesByPerson must be an object.");
  }

  if (!Array.isArray(historyRaw)) {
    throw new LlmValidationError("history must be an array.");
  }

  const availabilitiesByPerson: Record<string, string[]> = {};

  for (const [person, slots] of Object.entries(availabilitiesRaw)) {
    if (!Array.isArray(slots) || !slots.every((slot) => typeof slot === "string")) {
      throw new LlmValidationError("Each value in availabilitiesByPerson must be an array of strings.");
    }

    availabilitiesByPerson[person] = slots;
  }

  const history: ChatHistoryTurn[] = historyRaw.map((turn, index) => {
    if (!isRecord(turn)) {
      throw new LlmValidationError(`history[${index}] must be an object.`);
    }

    const role = String(turn.role ?? "").trim().toLowerCase();
    const content = String(turn.content ?? "").trim();

    if (!isHistoryRole(role)) {
      throw new LlmValidationError(`history[${index}].role must be 'user' or 'assistant'.`);
    }

    if (!content) {
      throw new LlmValidationError(`history[${index}].content must be a non-empty string.`);
    }

    return { role, content };
  });

  return {
    mode,
    provider,
    apiKey,
    query,
    availabilitiesByPerson,
    history,
  };
}

function buildContextPrompt(availabilitiesByPerson: Record<string, string[]>): string {
  return [
    "You are a scheduling assistant.",
    "Use the availability data to answer questions in this conversation.",
    "If possible, suggest concrete time windows and mention tradeoffs.",
    "",
    "Availability data (local time strings):",
    JSON.stringify(availabilitiesByPerson, null, 2),
    "",
    "Use this availability data for all upcoming chat turns.",
  ].join("\n");
}

type ClaudeModelsResponse = {
  data?: Array<{ id?: string }>;
};

type GeminiModelsResponse = {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
};

const fallbackClaudeModels = [
  "claude-3-5-sonnet-latest",
  "claude-3-5-sonnet-20241022",
];

const fallbackGeminiModels = [
  "models/gemini-1.5-flash",
  "models/gemini-1.5-pro",
];

function rankClaudeModels(models: string[]): string[] {
  const unique = [...new Set(models)];
  return unique.sort((a, b) => {
    const aIsSonnet = a.includes("sonnet") ? 1 : 0;
    const bIsSonnet = b.includes("sonnet") ? 1 : 0;
    if (aIsSonnet !== bIsSonnet) {
      return bIsSonnet - aIsSonnet;
    }
    return b.localeCompare(a);
  });
}

async function resolveClaudeModel(apiKey: string, fetchFn: typeof fetch): Promise<string> {
  const cached = claudeModelCache.get(apiKey);
  if (cached) {
    return cached;
  }

  const modelListResponse = await fetchFn("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  });

  if (!modelListResponse.ok) {
    const fallback = fallbackClaudeModels[0];
    claudeModelCache.set(apiKey, fallback);
    return fallback;
  }

  const body = (await modelListResponse.json()) as ClaudeModelsResponse;
  const ids = (body.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
    .filter(Boolean);

  const ranked = rankClaudeModels([...ids, ...fallbackClaudeModels]);
  const selected = ranked[0] ?? fallbackClaudeModels[0];
  claudeModelCache.set(apiKey, selected);
  return selected;
}

function normalizeGeminiModelName(name: string): string {
  if (name.startsWith("models/")) {
    return name;
  }
  return `models/${name}`;
}

function rankGeminiModels(models: string[]): string[] {
  const unique = [...new Set(models.map(normalizeGeminiModelName))];
  return unique.sort((a, b) => {
    const aIsFlash = a.includes("flash") ? 1 : 0;
    const bIsFlash = b.includes("flash") ? 1 : 0;
    if (aIsFlash !== bIsFlash) {
      return bIsFlash - aIsFlash;
    }
    return b.localeCompare(a);
  });
}

async function resolveGeminiModel(apiKey: string, fetchFn: typeof fetch): Promise<string> {
  const cached = geminiModelCache.get(apiKey);
  if (cached) {
    return cached;
  }

  const modelListResponse = await fetchFn("https://generativelanguage.googleapis.com/v1beta/models", {
    method: "GET",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
  });

  if (!modelListResponse.ok) {
    const fallback = fallbackGeminiModels[0];
    geminiModelCache.set(apiKey, fallback);
    return fallback;
  }

  const body = (await modelListResponse.json()) as GeminiModelsResponse;
  const candidateNames = (body.models ?? [])
    .filter((model) => {
      const methods = model.supportedGenerationMethods ?? [];
      return methods.includes("generateContent");
    })
    .map((model) => (typeof model.name === "string" ? model.name : ""))
    .filter((name) => name.includes("gemini"));

  const ranked = rankGeminiModels([...candidateNames, ...fallbackGeminiModels]);
  const selected = ranked[0] ?? fallbackGeminiModels[0];
  geminiModelCache.set(apiKey, selected);
  return selected;
}

function buildProviderRequest(
  payload: LlmStreamRequestBody,
  claudeModel?: string,
  geminiModel?: string,
): ProviderRequest {
  const contextPrompt = buildContextPrompt(payload.availabilitiesByPerson);
  const history = payload.history;

  if (payload.provider === "chatgpt") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${payload.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          stream: true,
          messages: [
            {
              role: "system",
              content: "You help summarize and reason over scheduling availability data.",
            },
            {
              role: "system",
              content: contextPrompt,
            },
            ...history,
            { role: "user", content: payload.query },
          ],
        }),
      },
    };
  }

  if (payload.provider === "claude") {
    const model = claudeModel ?? fallbackClaudeModels[0];
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "x-api-key": payload.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          stream: true,
          messages: [
            {
              role: "user",
              content: contextPrompt,
            },
            ...history,
            { role: "user", content: payload.query },
          ],
        }),
      },
    };
  }

  const model = normalizeGeminiModelName(geminiModel ?? fallbackGeminiModels[0]);
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/${model}:streamGenerateContent?alt=sse`,
    init: {
      method: "POST",
      headers: {
        "x-goog-api-key": payload.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: contextPrompt }],
          },
          ...history.map((turn) => ({
            role: turn.role === "assistant" ? "model" : "user",
            parts: [{ text: turn.content }],
          })),
          {
            role: "user",
            parts: [{ text: payload.query }],
          },
        ],
      }),
    },
  };
}

export function extractProviderDelta(provider: LlmProvider, dataLine: string): string {
  const payload = JSON.parse(dataLine) as Record<string, unknown>;

  if (provider === "chatgpt") {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return "";
    }

    const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
    return typeof delta?.content === "string" ? delta.content : "";
  }

  if (provider === "claude") {
    if (payload.type === "content_block_delta") {
      const delta = payload.delta as Record<string, unknown> | undefined;
      return typeof delta?.text === "string" ? delta.text : "";
    }

    if (payload.type === "content_block_start") {
      const block = payload.content_block as Record<string, unknown> | undefined;
      return typeof block?.text === "string" ? block.text : "";
    }

    return "";
  }

  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    return "";
  }

  return candidates
    .map((candidate) => {
      const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
      const parts = content?.parts;
      if (!Array.isArray(parts)) {
        return "";
      }

      return parts
        .map((part) => {
          const text = (part as Record<string, unknown>).text;
          return typeof text === "string" ? text : "";
        })
        .join("");
    })
    .join("");
}

async function streamProviderToSse(provider: LlmProvider, upstreamResponse: Response, res: ExpressResponse): Promise<void> {
  const reader = upstreamResponse.body?.getReader();

  if (!reader) {
    throw new LlmUpstreamError("LLM upstream response did not include a stream.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let geminiTextSoFar = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let lineBreak = buffer.indexOf("\n");
    while (lineBreak !== -1) {
      const rawLine = buffer.slice(0, lineBreak);
      buffer = buffer.slice(lineBreak + 1);
      const line = rawLine.trim();

      if (line.startsWith("data:")) {
        const dataLine = line.slice(5).trim();

        if (!dataLine || dataLine === "[DONE]") {
          lineBreak = buffer.indexOf("\n");
          continue;
        }

        try {
          let delta = extractProviderDelta(provider, dataLine);

          if (provider === "gemini" && delta) {
            if (delta.startsWith(geminiTextSoFar)) {
              delta = delta.slice(geminiTextSoFar.length);
            }
            geminiTextSoFar += delta;
          }

          if (delta) {
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {
          // Ignore non-JSON lines from provider streams.
        }
      }

      lineBreak = buffer.indexOf("\n");
    }
  }
}

export async function handleLlmStream(
  payload: LlmStreamRequestBody,
  fetchFn: typeof fetch,
  res: ExpressResponse,
  serverGeminiApiKey?: string,
): Promise<void> {
  const effectiveProvider: LlmProvider = payload.mode === "default" ? "gemini" : payload.provider;
  const effectiveApiKey =
    payload.mode === "default" ? String(serverGeminiApiKey ?? "").trim() : payload.apiKey;

  if (!effectiveApiKey) {
    throw new LlmValidationError("No API key available for selected mode.");
  }

  const requestPayload: LlmStreamRequestBody = {
    ...payload,
    provider: effectiveProvider,
    apiKey: effectiveApiKey,
  };

  const claudeModel =
    requestPayload.provider === "claude"
      ? await resolveClaudeModel(requestPayload.apiKey, fetchFn)
      : undefined;
  const geminiModel =
    requestPayload.provider === "gemini"
      ? await resolveGeminiModel(requestPayload.apiKey, fetchFn)
      : undefined;
  const providerRequest = buildProviderRequest(requestPayload, claudeModel, geminiModel);
  const upstreamResponse = await fetchFn(providerRequest.url, providerRequest.init);

  if (!upstreamResponse.ok) {
    const body = await upstreamResponse.text();
    throw new LlmUpstreamError(`LLM upstream error ${upstreamResponse.status}: ${body.slice(0, 500) || "No response body"}`);
  }

  await streamProviderToSse(requestPayload.provider, upstreamResponse, res);
}
