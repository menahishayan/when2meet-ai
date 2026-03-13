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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    try {
      await handleLlmStream(payload, fetchFn, res);
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
