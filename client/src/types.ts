export type AvailabilityResponse = {
  availabilitiesByPerson: Record<string, string[]>;
  participantCount: number;
  slotCount: number;
  source: "event-page-inline-js";
};

export type CaptureStatus = "idle" | "loading" | "ready" | "error";
