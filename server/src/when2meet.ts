import type { AvailabilityResponse, ParsedWhen2MeetUrl } from "./types.js";

export class UrlValidationError extends Error {}
export class HtmlParseError extends Error {}

export function parseWhen2MeetUrl(rawUrl: string): ParsedWhen2MeetUrl {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new UrlValidationError("The provided URL is not a valid URL.");
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host !== "www.when2meet.com" && host !== "when2meet.com") {
    throw new UrlValidationError("URL must point to when2meet.com.");
  }

  const token = parsedUrl.search.replace(/^\?/, "").split("&")[0]?.trim();
  if (!token) {
    throw new UrlValidationError("Missing event token in query string.");
  }

  const match = token.match(/^(\d+)-([A-Za-z0-9]+)$/);
  if (!match) {
    throw new UrlValidationError("Expected token format '<eventId>-<code>'.");
  }

  return {
    eventId: match[1],
    code: match[2],
    token,
  };
}

function parsePeople(html: string): Array<{ index: number; id: number; name: string }> {
  const regex = /PeopleNames\[(\d+)\]\s*=\s*'((?:\\'|[^'])*)';PeopleIDs\[\1\]\s*=\s*(\d+);/g;
  const people: Array<{ index: number; id: number; name: string }> = [];

  for (const match of html.matchAll(regex)) {
    people.push({
      index: Number(match[1]),
      name: match[2].replace(/\\'/g, "'"),
      id: Number(match[3]),
    });
  }

  return people.sort((a, b) => a.index - b.index);
}

function parseSlots(html: string): Map<number, number> {
  const regex = /TimeOfSlot\[(\d+)\]\s*=\s*(\d+);/g;
  const slots = new Map<number, number>();

  for (const match of html.matchAll(regex)) {
    slots.set(Number(match[1]), Number(match[2]));
  }

  return slots;
}

function parseAvailabilityBySlot(html: string): Map<number, Set<number>> {
  const regex = /AvailableAtSlot\[(\d+)\]\.push\((\d+)\);/g;
  const availabilityBySlot = new Map<number, Set<number>>();

  for (const match of html.matchAll(regex)) {
    const slotIndex = Number(match[1]);
    const userId = Number(match[2]);

    if (!availabilityBySlot.has(slotIndex)) {
      availabilityBySlot.set(slotIndex, new Set<number>());
    }

    availabilityBySlot.get(slotIndex)?.add(userId);
  }

  return availabilityBySlot;
}

export function parseAvailabilityFromHtml(html: string): AvailabilityResponse {
  const people = parsePeople(html);
  const slots = parseSlots(html);
  const availabilityBySlot = parseAvailabilityBySlot(html);

  if (people.length === 0) {
    throw new HtmlParseError("Could not parse PeopleNames/PeopleIDs from page HTML.");
  }

  if (slots.size === 0) {
    throw new HtmlParseError("Could not parse TimeOfSlot values from page HTML.");
  }

  const userAvailabilities = new Map<number, number[]>();
  for (const person of people) {
    userAvailabilities.set(person.id, []);
  }

  for (const [slotIndex, unixSeconds] of slots.entries()) {
    const userIds = availabilityBySlot.get(slotIndex);
    if (!userIds) {
      continue;
    }

    for (const userId of userIds.values()) {
      if (!userAvailabilities.has(userId)) {
        userAvailabilities.set(userId, []);
      }
      userAvailabilities.get(userId)?.push(unixSeconds);
    }
  }

  const availabilitiesByPerson: Record<string, string[]> = {};

  for (const person of people) {
    const times = userAvailabilities.get(person.id) ?? [];
    const key = Object.prototype.hasOwnProperty.call(availabilitiesByPerson, person.name)
      ? `${person.name} (${person.id})`
      : person.name;

    availabilitiesByPerson[key] = times
      .sort((a, b) => a - b)
      .map((unixSeconds) => new Date(unixSeconds * 1000).toISOString());
  }

  return {
    availabilitiesByPerson,
    participantCount: people.length,
    slotCount: slots.size,
    source: "event-page-inline-js",
  };
}

export async function fetchAndParseWhen2MeetAvailability(
  rawUrl: string,
  fetchFn: typeof fetch,
): Promise<AvailabilityResponse> {
  parseWhen2MeetUrl(rawUrl);

  const response = await fetchFn(rawUrl, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Upstream fetch failed with status ${response.status}.`);
  }

  const html = await response.text();
  return parseAvailabilityFromHtml(html);
}
