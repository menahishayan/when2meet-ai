import express from "express";
import type { Request, Response } from "express";
import {
  fetchAndParseWhen2MeetAvailability,
  HtmlParseError,
  UrlValidationError,
} from "./when2meet.js";

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

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/when2meet/availability", async (req, res) => {
    await handleAvailabilityRequest(req, res, fetchFn);
  });

  return app;
}
