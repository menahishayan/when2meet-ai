import express from "express";
import type { Request, Response } from "express";
import {
  fetchAndParseWhen2MeetAvailability,
  HtmlParseError,
  UrlValidationError,
} from "./when2meet.js";
import {
  handleLlmStream,
  LlmUpstreamError,
  LlmValidationError,
  validateLlmStreamRequestBody,
} from "./llm.js";

type AppDeps = {
  fetchFn?: typeof fetch;
};

const DEFAULT_MODE_REQUEST_LIMIT = 2;
const DEFAULT_MODE_WINDOW_MS = 60_000;

function getClientIdentifier(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() || req.ip || "unknown-client";
  }
  return req.ip || "unknown-client";
}

function isOverDefaultModeRateLimit(
  clientId: string,
  requestTimesByClient: Map<string, number[]>,
  now: number = Date.now(),
): boolean {
  const windowStart = now - DEFAULT_MODE_WINDOW_MS;
  const previous = requestTimesByClient.get(clientId) ?? [];
  const recent = previous.filter((time) => time > windowStart);

  if (recent.length >= DEFAULT_MODE_REQUEST_LIMIT) {
    requestTimesByClient.set(clientId, recent);
    return true;
  }

  recent.push(now);
  requestTimesByClient.set(clientId, recent);
  return false;
}

export async function handleAvailabilityRequest(
  req: Request,
  res: Response,
  fetchFn: typeof fetch,
) {
  const url = String(req.query.url ?? "").trim();

  if (!url) {
    res.status(400).json({ error: "Missing required query parameter: url" });
    return;
  }

  try {
    const parsed = await fetchAndParseWhen2MeetAvailability(url, fetchFn);
    res.json(parsed);
  } catch (error) {
    if (error instanceof UrlValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof HtmlParseError) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(502).json({
      error: error instanceof Error ? error.message : "Failed to fetch When2Meet page.",
    });
  }
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  const fetchFn = deps.fetchFn ?? fetch;
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  const requestTimesByClient = new Map<string, number[]>();

  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;

    if (corsOrigin) {
      if (requestOrigin === corsOrigin) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/when2meet/availability", async (req, res) => {
    await handleAvailabilityRequest(req, res, fetchFn);
  });

  app.post("/api/llm/stream", async (req, res) => {
    let payload;

    try {
      payload = validateLlmStreamRequestBody(req.body);
    } catch (error) {
      if (error instanceof LlmValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(400).json({ error: "Invalid request body." });
      return;
    }

    const serverGeminiApiKey = process.env.SERVER_GEMINI_API_KEY?.trim();
    if (payload.mode === "default" && !serverGeminiApiKey) {
      res.status(500).json({
        error: "SERVER_GEMINI_API_KEY is not configured on the server.",
      });
      return;
    }

    if (payload.mode === "default") {
      const clientId = getClientIdentifier(req);
      if (isOverDefaultModeRateLimit(clientId, requestTimesByClient)) {
        res.status(429).json({
          error:
            "Default mode is limited to 2 requests per minute. Switch to custom mode to use your own API key.",
        });
        return;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    try {
      await handleLlmStream(payload, fetchFn, res, serverGeminiApiKey);
      res.write("event: done\ndata: {}\n\n");
      res.end();
    } catch (error) {
      const message =
        error instanceof LlmUpstreamError || error instanceof Error
          ? error.message
          : "Unknown LLM streaming error.";

      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  });

  return app;
}
