import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";
import type { AvailabilityResponse, CaptureStatus, ChatHistoryTurn, LlmMode, LlmProvider } from "./types";

const DEFAULT_URL = "";
const STORAGE_KEY_PROVIDER = "when2meet-ai-provider";
const STORAGE_KEY_MODE = "when2meet-ai-mode";
const STORAGE_KEY_API_KEYS = "when2meet-ai-api-keys";
const LEGACY_STORAGE_KEY_API = "when2meet-ai-api-key";
const URL_LOAD_DEBOUNCE_MS = 1000;
const QUERY_PLACEHOLDER_ROTATE_MS = 3600;
const QUERY_PLACEHOLDER_FADE_MS = 220;

const QUERY_PLACEHOLDERS = [
  "Are Katy and Eve both available at 2pm?",
  "When is the best date and time if Lexi is non-negotiable?",
  "Who can do a 45-minute meeting this Thursday afternoon?",
  "Find the top 3 meeting windows for everyone.",
  "What is the earliest time at least 4 people can attend?",
];

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const GOOGLE_ADS_CLIENT = (import.meta.env.VITE_GOOGLE_ADS_CLIENT ?? "ca-pub-8962085849419447").trim();
const GOOGLE_ADS_SLOT = (import.meta.env.VITE_GOOGLE_ADS_SLOT ?? "2974711027").trim();
const GOOGLE_ADS_LAYOUT_KEY = (import.meta.env.VITE_GOOGLE_ADS_LAYOUT_KEY ?? "-fv+4x+8l-bt-5o").trim();

type StreamEventPayload = {
  delta?: string;
  error?: string;
};

type ApiKeysByProvider = Record<LlmProvider, string>;

function emptyApiKeys(): ApiKeysByProvider {
  return {
    chatgpt: "",
    claude: "",
    gemini: "",
  };
}

function apiUrl(path: string): string {
  if (!API_BASE_URL) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

function toLocalMap(availabilitiesByPerson: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(availabilitiesByPerson).map(([person, slots]) => [person, slots.map((isoTime) => new Date(isoTime).toLocaleString())]),
  );
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

function readInitialMode(): LlmMode {
  if (typeof window === "undefined") {
    return "default";
  }

  const stored = (localStorage.getItem(STORAGE_KEY_MODE) ?? "default").toLowerCase();
  return stored === "custom" ? "custom" : "default";
}

function readInitialApiKeys(): ApiKeysByProvider {
  if (typeof window === "undefined") {
    return emptyApiKeys();
  }

  const parsed = emptyApiKeys();
  const stored = localStorage.getItem(STORAGE_KEY_API_KEYS);

  if (stored) {
    try {
      const json = JSON.parse(stored) as Partial<ApiKeysByProvider>;
      for (const provider of ["chatgpt", "claude", "gemini"] as const) {
        if (typeof json[provider] === "string") {
          parsed[provider] = json[provider] ?? "";
        }
      }
    } catch {
      // Ignore malformed localStorage payload.
    }
  }

  // Migrate prior single-key storage to the currently selected provider.
  const legacy = (localStorage.getItem(LEGACY_STORAGE_KEY_API) ?? "").trim();
  if (legacy) {
    const provider = readInitialProvider();
    if (!parsed[provider]) {
      parsed[provider] = legacy;
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY_API);
  }

  return parsed;
}

async function fetchAvailability(url: string): Promise<AvailabilityResponse> {
  const response = await fetch(apiUrl(`/api/when2meet/availability?url=${encodeURIComponent(url)}`));

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
  mode: LlmMode;
  provider: LlmProvider;
  apiKey: string;
  query: string;
  availabilitiesByPerson: Record<string, string[]>;
  history: ChatHistoryTurn[];
  onDelta: (delta: string) => void;
  onErrorEvent: (message: string) => void;
}) {
  const response = await fetch(apiUrl("/api/llm/stream"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: options.mode,
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

function GoogleAdsBanner() {
  const hasLiveAdConfig = Boolean(GOOGLE_ADS_CLIENT && GOOGLE_ADS_SLOT && GOOGLE_ADS_LAYOUT_KEY);

  useEffect(() => {
    if (!hasLiveAdConfig) {
      return;
    }

    const adsWindow = window as Window & { adsbygoogle?: unknown[] };
    adsWindow.adsbygoogle = adsWindow.adsbygoogle ?? [];

    try {
      adsWindow.adsbygoogle.push({});
    } catch {
      // Ignore transient ad bootstrap errors.
    }
  }, [hasLiveAdConfig]);

  return (
    <footer className="ads-banner" aria-label="Advertisement">
      {hasLiveAdConfig ? (
        <ins
          className="adsbygoogle"
          style={{ display: "block" }}
          data-ad-format="fluid"
          data-ad-layout-key={GOOGLE_ADS_LAYOUT_KEY}
          data-ad-client={GOOGLE_ADS_CLIENT}
          data-ad-slot={GOOGLE_ADS_SLOT}
        />
      ) : (
        <div className="ads-placeholder">Google Ads banner</div>
      )}
    </footer>
  );
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
  const [mode, setMode] = useState<LlmMode>(readInitialMode);
  const [apiKeysByProvider, setApiKeysByProvider] = useState<ApiKeysByProvider>(readInitialApiKeys);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isIframeLoading, setIsIframeLoading] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState("");
  const [llmError, setLlmError] = useState("");
  const [history, setHistory] = useState<ChatHistoryTurn[]>([]);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [isPlaceholderFading, setIsPlaceholderFading] = useState(false);
  const urlLoadTimerRef = useRef<number | null>(null);
  const placeholderFadeTimerRef = useRef<number | null>(null);
  const iframeUrlRef = useRef(iframeUrl);

  const peopleCount = useMemo(() => availability?.participantCount ?? 0, [availability]);
  const selectedApiKey = apiKeysByProvider[provider] ?? "";

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PROVIDER, provider);
  }, [provider]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_MODE, mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_API_KEYS, JSON.stringify(apiKeysByProvider));
  }, [apiKeysByProvider]);

  useEffect(() => {
    iframeUrlRef.current = iframeUrl;
  }, [iframeUrl]);

  useEffect(() => {
    return () => {
      if (urlLoadTimerRef.current !== null) {
        window.clearTimeout(urlLoadTimerRef.current);
        urlLoadTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const rotationId = window.setInterval(() => {
      setIsPlaceholderFading(true);

      if (placeholderFadeTimerRef.current !== null) {
        window.clearTimeout(placeholderFadeTimerRef.current);
      }

      placeholderFadeTimerRef.current = window.setTimeout(() => {
        setPlaceholderIndex((previous) => (previous + 1) % QUERY_PLACEHOLDERS.length);
        setIsPlaceholderFading(false);
        placeholderFadeTimerRef.current = null;
      }, QUERY_PLACEHOLDER_FADE_MS);
    }, QUERY_PLACEHOLDER_ROTATE_MS);

    return () => {
      window.clearInterval(rotationId);
      if (placeholderFadeTimerRef.current !== null) {
        window.clearTimeout(placeholderFadeTimerRef.current);
        placeholderFadeTimerRef.current = null;
      }
    };
  }, []);

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
    } finally {
      setIsIframeLoading(false);
    }
  }

  function clearPendingUrlLoad() {
    if (urlLoadTimerRef.current !== null) {
      window.clearTimeout(urlLoadTimerRef.current);
      urlLoadTimerRef.current = null;
    }
  }

  function handleUrlBlur() {
    clearPendingUrlLoad();
    const trimmedUrl = urlInput.trim();

    if (!trimmedUrl) {
      setIframeUrl("");
      setIsIframeLoading(false);
      setAvailability(null);
      setStatus("idle");
      setErrorMessage("");
      return;
    }

    urlLoadTimerRef.current = window.setTimeout(() => {
      if (iframeUrlRef.current === trimmedUrl) {
        urlLoadTimerRef.current = null;
        return;
      }

      setIsIframeLoading(true);
      setIframeUrl(trimmedUrl);
      urlLoadTimerRef.current = null;
    }, URL_LOAD_DEBOUNCE_MS);
  }

  function handleSettingsKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (mode !== "custom" || event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    setSettingsOpen(false);
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

    const cleanedApiKey = selectedApiKey.trim();
    if (mode === "custom" && !cleanedApiKey) {
      setLlmError(`Please add a ${provider} API key in settings before sending a query.`);
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
        mode,
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

  function handleApiKeyChange(nextValue: string) {
    setApiKeysByProvider((previous) => ({
      ...previous,
      [provider]: nextValue,
    }));
  }

  return (
    <>
      <main className="app">
        <div className="panel">
          <div className="header-row">
            <h1>When2Meet... but with ✨ AI 🔮 (oooooooh)</h1>
            <button type="button" className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.99l2.11-1.65a.5.5 0 0 0 .12-.63l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.15 7.15 0 0 0-1.72-.99l-.38-2.65a.5.5 0 0 0-.5-.42h-4a.5.5 0 0 0-.5.42L9.08 5.06c-.62.24-1.19.57-1.72.99l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.63l2.11 1.65c-.05.33-.08.66-.08.99s.03.66.08.99L2.39 14.63a.5.5 0 0 0-.12.63l2 3.46c.13.22.39.31.6.22l2.49-1c.53.42 1.1.75 1.72.99l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.62-.24 1.19-.57 1.72-.99l2.49 1c.22.09.47 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.63l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
              </svg>
            </button>
          </div>

          <div className="controls">
            <h3>How to use?</h3>
            <p>Paste your when2meet link down here and ask questions to an AI</p>
            <input
              aria-label="When2Meet URL"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onBlur={handleUrlBlur}
              onFocus={clearPendingUrlLoad}
              placeholder="https://www.when2meet.com/?..."
            />
          </div>

          <form className="query" onSubmit={handleQuerySubmit}>
            <div className="query-row">
              <input
                aria-label="AI query"
                className={isPlaceholderFading ? "query-input placeholder-fade" : "query-input"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={QUERY_PLACEHOLDERS[placeholderIndex]}
                disabled={isStreaming}
              />
              <button type="submit" className="icon-button send-button" aria-label="Send query" disabled={isStreaming}>
                {isStreaming ? (
                  <span className="spinner spinner-sm" aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                )}
              </button>
            </div>
          </form>

          <section className="response-panel" aria-live="polite">
            <h2>LLM Response</h2>
            {llmError ? <p className="status error">{llmError}</p> : null}
            <div className="response-box">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamedResponse || (isStreaming ? "Streaming response..." : "No response yet.")}
              </ReactMarkdown>
            </div>
          </section>

          <div className="iframe-container">
            {isIframeLoading ? (
              <div className="iframe-loading-overlay">
                <span className="spinner" aria-hidden="true" />
                <span>Loading schedule...</span>
              </div>
            ) : null}
            <iframe title="When2Meet Frame" src={iframeUrl} onLoad={handleIframeLoad} referrerPolicy="no-referrer" />
          </div>

          <p className={`status ${status === "error" ? "error" : ""}`}>
            Status: {statusLabel(status)}
            {status === "ready" ? ` (${peopleCount} participants)` : ""}
            {status === "error" && errorMessage ? ` - ${errorMessage}` : ""}
          </p>
        </div>
      </main>

      {settingsOpen ? (
        <div className="settings-modal-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <section
            className="settings-modal"
            aria-modal="true"
            role="dialog"
            aria-label="LLM settings"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleSettingsKeyDown}
          >
            <div className="settings-modal-header">
              <h2>Settings</h2>
              <button type="button" className="icon-button modal-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4l-6.3 6.31-1.41-1.42L9.17 12 2.88 5.71 4.29 4.3l6.3 6.29 6.29-6.3z" />
                </svg>
              </button>
            </div>

            <div className="settings-toggle" role="radiogroup" aria-label="Mode">
              <button
                type="button"
                role="radio"
                aria-checked={mode === "default"}
                className={mode === "default" ? "toggle-option active" : "toggle-option"}
                onClick={() => setMode("default")}
              >
                Default
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "custom"}
                className={mode === "custom" ? "toggle-option active" : "toggle-option"}
                onClick={() => setMode("custom")}
              >
                Custom
              </button>
            </div>

            {mode === "default" ? (
              <p className="settings-note">
                Default mode is limited to 2 requests per minute. You can use Custom Mode with your own API key for unlimited access.
              </p>
            ) : (
              <>
                <label className="settings-field">
                  Model Provider
                  <select aria-label="Model provider" value={provider} onChange={(event) => setProvider(event.target.value as LlmProvider)}>
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
                    value={selectedApiKey}
                    onChange={(event) => handleApiKeyChange(event.target.value)}
                    placeholder={`Paste your ${provider} API key`}
                  />
                </label>

                <p className="settings-note">Keys are saved per provider in localStorage.</p>
              </>
            )}
          </section>
        </div>
      ) : null}

      <GoogleAdsBanner />
    </>
  );
}
