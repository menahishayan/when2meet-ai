import { FormEvent, useMemo, useState } from "react";
import "./App.css";
import type { AvailabilityResponse, CaptureStatus } from "./types";

const DEFAULT_URL = "https://www.when2meet.com/?35187552-u5FTV";

function toLocalMap(availabilitiesByPerson: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(availabilitiesByPerson).map(([person, slots]) => [
      person,
      slots.map((isoTime) => new Date(isoTime).toLocaleString()),
    ]),
  );
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

  const peopleCount = useMemo(() => availability?.participantCount ?? 0, [availability]);

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

  function handleQuerySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!availability) {
      console.warn("Availability data is not ready yet.", { status, errorMessage });
      return;
    }

    const localized = toLocalMap(availability.availabilitiesByPerson);
    console.log("availabilitiesByPerson", localized);
  }

  return (
    <main className="app">
      <div className="panel">
        <h1>When2Meet Iframe + AI Query Bar</h1>

        <form className="controls" onSubmit={handleLoadUrl}>
          <input
            aria-label="When2Meet URL"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="https://www.when2meet.com/?..."
          />
          <button type="submit">Load</button>
        </form>

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

        <form className="query" onSubmit={handleQuerySubmit}>
          <input
            aria-label="AI query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask a question and press Enter..."
          />
        </form>
      </div>
    </main>
  );
}
