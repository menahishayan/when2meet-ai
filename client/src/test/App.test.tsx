import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const successPayload = {
  availabilitiesByPerson: {
    Alice: ["2026-03-13T15:00:00.000Z"],
    Bob: ["2026-03-13T16:00:00.000Z"],
  },
  participantCount: 2,
  slotCount: 2,
  source: "event-page-inline-js",
} as const;

function buildSseResponse(lines: string): Response {
  return new Response(lines, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("calls the availability API when iframe loads", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(successPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.load(screen.getByTitle("When2Meet Frame"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/when2meet/availability");
  });

  it("submits query with send button and streams the LLM response", async () => {
    localStorage.setItem("when2meet-ai-api-key", "test-api-key");
    localStorage.setItem("when2meet-ai-provider", "chatgpt");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith("/api/when2meet/availability")) {
        return new Response(JSON.stringify(successPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/llm/stream") {
        return buildSseResponse(
          'data: {"delta":"Top option: Tuesday 3pm. "}\n\n' +
            'data: {"delta":"Backup: Wednesday 4pm."}\n\n' +
            "event: done\n" +
            "data: {}\n\n",
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.load(screen.getByTitle("When2Meet Frame"));

    await waitFor(() => {
      expect(screen.getByText(/Status: Availability loaded/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("AI query"), {
      target: { value: "What are the best times?" },
    });
    fireEvent.click(screen.getByLabelText("Send query"));

    await waitFor(() => {
      expect(screen.getByText(/Top option: Tuesday 3pm./i)).toBeInTheDocument();
      expect(screen.getByText(/Backup: Wednesday 4pm./i)).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/llm/stream");

    const secondCallInit = fetchMock.mock.calls[1]?.[1];
    const body = JSON.parse(String(secondCallInit?.body)) as {
      provider: string;
      apiKey: string;
      query: string;
      availabilitiesByPerson: Record<string, string[]>;
    };

    expect(body.provider).toBe("chatgpt");
    expect(body.apiKey).toBe("test-api-key");
    expect(body.query).toBe("What are the best times?");
    expect(Object.keys(body.availabilitiesByPerson)).toEqual(["Alice", "Bob"]);
  });

  it("logs a clear warning if submit happens before data is ready", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Network failure");
    });
    vi.stubGlobal("fetch", fetchMock);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(<App />);

    fireEvent.load(screen.getByTitle("When2Meet Frame"));

    await waitFor(() => {
      expect(screen.getByText(/Status: Error/i)).toBeInTheDocument();
    });

    const queryInput = screen.getByLabelText("AI query");
    fireEvent.submit(queryInput.closest("form") as HTMLFormElement);

    expect(warnSpy).toHaveBeenCalledWith(
      "Availability data is not ready yet.",
      expect.objectContaining({ status: "error" }),
    );
  });
});
