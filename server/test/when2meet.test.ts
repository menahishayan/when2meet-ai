import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAvailabilityFromHtml,
  parseWhen2MeetUrl,
  UrlValidationError,
} from "../src/when2meet.js";

describe("parseWhen2MeetUrl", () => {
  it("parses a valid when2meet URL", () => {
    const parsed = parseWhen2MeetUrl("https://www.when2meet.com/?35187552-u5FTV");

    expect(parsed).toEqual({
      eventId: "35187552",
      code: "u5FTV",
      token: "35187552-u5FTV",
    });
  });

  it("rejects non-when2meet hosts", () => {
    expect(() => parseWhen2MeetUrl("https://example.com/?35187552-u5FTV")).toThrow(
      UrlValidationError,
    );
  });

  it("rejects malformed event token", () => {
    expect(() => parseWhen2MeetUrl("https://www.when2meet.com/?bad-token-format")).toThrow(
      UrlValidationError,
    );
  });
});

describe("parseAvailabilityFromHtml", () => {
  it("extracts people and slot availability from fixture HTML", () => {
    const fixturePath = path.join(import.meta.dirname, "fixtures", "availability-page.html");
    const html = fs.readFileSync(fixturePath, "utf8");

    const parsed = parseAvailabilityFromHtml(html);

    expect(parsed.participantCount).toBe(2);
    expect(parsed.slotCount).toBe(3);
    expect(parsed.source).toBe("event-page-inline-js");

    expect(parsed.availabilitiesByPerson).toEqual({
      Alice: [new Date(1710000000 * 1000).toISOString(), new Date(1710003600 * 1000).toISOString()],
      Bob: [new Date(1710003600 * 1000).toISOString()],
    });
  });
});
