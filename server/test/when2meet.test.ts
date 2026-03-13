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
    const parsed = parseWhen2MeetUrl("https://www.when2meet.com/?12345678-AbCdE");

    expect(parsed).toEqual({
      eventId: "12345678",
      code: "AbCdE",
      token: "12345678-AbCdE",
    });
  });

  it("rejects non-when2meet hosts", () => {
    expect(() => parseWhen2MeetUrl("https://example.com/?12345678-AbCdE")).toThrow(
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

  it("deduplicates repeated PeopleNames/PeopleIDs entries for same person id", () => {
    const html = `
      <script>
        PeopleNames[0] = 'Ava Czarnecki';PeopleIDs[0] = 136998938;
        PeopleNames[1] = 'Ava Czarnecki';PeopleIDs[1] = 136998938;
        TimeOfSlot[0]=1710000000;
        AvailableAtSlot[0]=new Array();
        AvailableAtSlot[0].push(136998938);
      </script>
    `;

    const parsed = parseAvailabilityFromHtml(html);
    expect(Object.keys(parsed.availabilitiesByPerson)).toEqual(["Ava Czarnecki"]);
  });
});
