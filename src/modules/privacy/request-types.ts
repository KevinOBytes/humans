import type { privacyRequests } from "@/db/schema/privacy";
export type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
export type PrivacyRequestState = PrivacyRequestRow["state"];
export const privacyRequestTypes = [
  "access",
  "correction",
  "export",
  "restriction",
  "consent_withdrawal",
  "deletion",
] as const;
export const privacyProcessors = [
  "files",
  "search",
  "cache",
  "email",
  "ai_provider",
] as const;
export type PrivacyProcessor = (typeof privacyProcessors)[number];
