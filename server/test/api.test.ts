import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleAvailabilityRequest } from "../src/app.js";

type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (payload: unknown) => MockRes;
};

function loadFixture() {
  const fixturePath = path.join(import.meta.dirname, "fixtures", "availability-page.html");
  return fs.readFileSync(fixturePath, "utf8");
}

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("handleAvailabilityRequest", () => {
  it("returns normalized availability payload", async () => {
    const html = loadFixture();
    const fetchMock = vi.fn(async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const req = { query: { url: "https://www.when2meet.com/?12345678-AbCdE" } };
    const res = createMockRes();

    await handleAvailabilityRequest(req as never, res as never, fetchMock as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      source: "event-page-inline-js",
      participantCount: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid URLs", async () => {
    const fetchMock = vi.fn();
    const req = { query: { url: "https://example.com/?12345678-AbCdE" } };
    const res = createMockRes();

    await handleAvailabilityRequest(req as never, res as never, fetchMock as never);

    expect(res.statusCode).toBe(400);
  });

  it("returns 502 when upstream fetch fails", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not found", {
        status: 404,
      }),
    );
    const req = { query: { url: "https://www.when2meet.com/?12345678-AbCdE" } };
    const res = createMockRes();

    await handleAvailabilityRequest(req as never, res as never, fetchMock as never);

    expect(res.statusCode).toBe(502);
  });

  it("returns 500 when parser cannot parse HTML", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html><body>missing parser markers</body></html>", {
        status: 200,
      }),
    );
    const req = { query: { url: "https://www.when2meet.com/?12345678-AbCdE" } };
    const res = createMockRes();

    await handleAvailabilityRequest(req as never, res as never, fetchMock as never);

    expect(res.statusCode).toBe(500);
  });
});
