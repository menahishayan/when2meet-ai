import { FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import "./App.css";
import type { AvailabilityResponse, CaptureStatus, ChatHistoryTurn, LlmProvider } from "./types";

const DEFAULT_URL = "";
const STORAGE_KEY_API = "when2meet-ai-api-key";
const STORAGE_KEY_PROVIDER = "when2meet-ai-provider";

type StreamEventPayload = {
  delta?: string;
  error?: string;
};

function toLocalMap(availabilitiesByPerson: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(availabilitiesByPerson).map(([person, slots]) => [
      person,
      slots.map((isoTime) => new Date(isoTime).toLocaleString()),
    ]),
  );
}

function readInitialApiKey(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return localStorage.getItem(STORAGE_KEY_API) ?? "";
}

function readInitialProvider(): LlmProvider {
  if (typeof window === "undefined") {
    return "chatgpt";
  }

  const stored = (localStorage.getItem(STORAGE_KEY_PROVIDER) ?? "chatgpt").toLowerCase();
  if (stored === "claude" || stored === "gemini" || stored === "chatgpt") {
    return stored;
  }

  return "chatgpt";
}

async function fetchAvailability(url: string): Promise<AvailabilityResponse> {
  const response = await fetch(`/api/when2meet/availability?url=${encodeURIComponent(url)}`);

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Use fallback status message when JSON body is not available.
    }

    throw new Error(message);
  }

  return (await response.json()) as AvailabilityResponse;
}

async function streamLlmResponse(options: {
  provider: LlmProvider;
  apiKey: string;
  query: string;
  availabilitiesByPerson: Record<string, string[]>;
  history: ChatHistoryTurn[];
  onDelta: (delta: string) => void;
  onErrorEvent: (message: string) => void;
}) {
  const response = await fetch("/api/llm/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: options.provider,
      apiKey: options.apiKey,
      query: options.query,
      availabilitiesByPerson: options.availabilitiesByPerson,
      history: options.history,
    }),
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Keep fallback when non-JSON error body is returned.
    }

    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Response streaming is not supported by this browser.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.trim();

      if (!line) {
        currentEvent = "message";
        newlineIndex = buffer.indexOf("\n");
        continue;
      }

      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        newlineIndex = buffer.indexOf("\n");
        continue;
      }

      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (!data) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        try {
          const parsed = JSON.parse(data) as StreamEventPayload;

          if (currentEvent === "error") {
            options.onErrorEvent(parsed.error ?? "Unknown streaming error.");
          } else if (typeof parsed.delta === "string") {
            options.onDelta(parsed.delta);
          }
        } catch {
          // Ignore non-JSON data lines.
        }
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }
}

function statusLabel(status: CaptureStatus): string {
  if (status === "idle") return "Idle";
  if (status === "loading") return "Loading availability...";
  if (status === "ready") return "Availability loaded";
  return "Error";
}

export default function App() {
  const [urlInput, setUrlInput] = useState(DEFAULT_URL);
  const [iframeUrl, setIframeUrl] = useState(DEFAULT_URL);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [provider, setProvider] = useState<LlmProvider>(readInitialProvider);
  const [apiKey, setApiKey] = useState<string>(readInitialApiKey);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState("");
  const [llmError, setLlmError] = useState("");
  const [history, setHistory] = useState<ChatHistoryTurn[]>([]);

  const peopleCount = useMemo(() => availability?.participantCount ?? 0, [availability]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PROVIDER, provider);
  }, [provider]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_API, apiKey);
  }, [apiKey]);

  async function handleIframeLoad() {
    if (!iframeUrl) {
      return;
    }

    setStatus("loading");
    setErrorMessage("");

    try {
      const parsed = await fetchAvailability(iframeUrl);
      setAvailability(parsed);
      setStatus("ready");
    } catch (error) {
      setAvailability(null);
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Unknown error");
      console.warn("Availability capture failed", error);
    }
  }

  function handleLoadUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIframeUrl(urlInput.trim());
  }

  async function handleQuerySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!availability) {
      console.warn("Availability data is not ready yet.", { status, errorMessage });
      return;
    }

    const cleanedQuery = query.trim();
    if (!cleanedQuery) {
      return;
    }

    const cleanedApiKey = apiKey.trim();
    if (!cleanedApiKey) {
      setLlmError("Please add an API key in settings before sending a query.");
      return;
    }

    const localized = toLocalMap(availability.availabilitiesByPerson);
    console.log("availabilitiesByPerson", localized);

    setLlmError("");
    setStreamedResponse("");
    setIsStreaming(true);
    let fullAssistantResponse = "";

    try {
      await streamLlmResponse({
        provider,
        apiKey: cleanedApiKey,
        query: cleanedQuery,
        availabilitiesByPerson: localized,
        history,
        onDelta: (delta) => {
          fullAssistantResponse += delta;
          setStreamedResponse((previous) => previous + delta);
        },
        onErrorEvent: (message) => {
          setLlmError(message);
        },
      });

      if (fullAssistantResponse.trim()) {
        setHistory((previous) => [
          ...previous,
          { role: "user", content: cleanedQuery },
          { role: "assistant", content: fullAssistantResponse.trim() },
        ]);
      }
    } catch (error) {
      setLlmError(error instanceof Error ? error.message : "Unknown LLM request error.");
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <main className="app">
      <div className="panel">
        <div className="header-row">
          <h1>When2Meet Iframe + AI Query Bar</h1>
          <button
            type="button"
            className="icon-button"
            aria-label="Open settings"
            onClick={() => setSettingsOpen((current) => !current)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.99l2.11-1.65a.5.5 0 0 0 .12-.63l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.15 7.15 0 0 0-1.72-.99l-.38-2.65a.5.5 0 0 0-.5-.42h-4a.5.5 0 0 0-.5.42L9.08 5.06c-.62.24-1.19.57-1.72.99l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.63l2.11 1.65c-.05.33-.08.66-.08.99s.03.66.08.99L2.39 14.63a.5.5 0 0 0-.12.63l2 3.46c.13.22.39.31.6.22l2.49-1c.53.42 1.1.75 1.72.99l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.62-.24 1.19-.57 1.72-.99l2.49 1c.22.09.47 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.63l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
            </svg>
          </button>
        </div>

        {settingsOpen ? (
          <section className="settings-panel" aria-label="LLM settings">
            <label className="settings-field">
              Model Provider
              <select
                aria-label="Model provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value as LlmProvider)}
              >
                <option value="chatgpt">ChatGPT</option>
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>

            <label className="settings-field">
              API Key
              <input
                aria-label="API key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste your API key"
              />
            </label>

            <p className="settings-note">Saved in this browser (localStorage).</p>
          </section>
        ) : null}

        <form className="controls" onSubmit={handleLoadUrl}>
          <input
            aria-label="When2Meet URL"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="https://www.when2meet.com/?..."
          />
          <button type="submit">Load</button>
        </form>

        <form className="query" onSubmit={handleQuerySubmit}>
          <div className="query-row">
            <input
              aria-label="AI query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ask a question and press Enter..."
              disabled={isStreaming}
            />
            <button
              type="submit"
              className="icon-button send-button"
              aria-label="Send query"
              disabled={isStreaming}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        </form>

        <section className="response-panel" aria-live="polite">
          <h2>LLM Response</h2>
          {llmError ? <p className="status error">{llmError}</p> : null}
          <div className="response-box">
            <ReactMarkdown>
              {streamedResponse || (isStreaming ? "Streaming response..." : "No response yet.")}
            </ReactMarkdown>
          </div>
        </section>

        <iframe
          title="When2Meet Frame"
          src={iframeUrl}
          onLoad={handleIframeLoad}
          referrerPolicy="no-referrer"
        />

        <p className={`status ${status === "error" ? "error" : ""}`}>
          Status: {statusLabel(status)}
          {status === "ready" ? ` (${peopleCount} participants)` : ""}
          {status === "error" && errorMessage ? ` - ${errorMessage}` : ""}
        </p>
      </div>
    </main>
  );
}
