export type AvailabilityResponse = {
  availabilitiesByPerson: Record<string, string[]>;
  participantCount: number;
  slotCount: number;
  source: "event-page-inline-js";
};

export type CaptureStatus = "idle" | "loading" | "ready" | "error";

export type LlmProvider = "chatgpt" | "claude" | "gemini";
export type LlmMode = "default" | "custom";

export type ChatHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};
