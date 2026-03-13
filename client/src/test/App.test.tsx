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
};

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the availability API when iframe loads", async () => {
    const fetchMock = vi.fn(async () =>
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
  });

  it("logs availabilities on query submit after successful load", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(successPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    render(<App />);

    fireEvent.load(screen.getByTitle("When2Meet Frame"));

    await waitFor(() => {
      expect(screen.getByText(/Status: Availability loaded/i)).toBeInTheDocument();
    });

    const queryInput = screen.getByLabelText("AI query");
    fireEvent.change(queryInput, { target: { value: "Who is free?" } });
    fireEvent.submit(queryInput.closest("form") as HTMLFormElement);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toBe("availabilitiesByPerson");
    expect(logSpy.mock.calls[0][1]).toMatchObject({
      Alice: expect.any(Array),
      Bob: expect.any(Array),
    });
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
