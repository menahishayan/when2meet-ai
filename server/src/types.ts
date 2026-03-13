export type AvailabilityResponse = {
  availabilitiesByPerson: Record<string, string[]>;
  participantCount: number;
  slotCount: number;
  source: "event-page-inline-js";
};

export type ParsedWhen2MeetUrl = {
  eventId: string;
  code: string;
  token: string;
};
