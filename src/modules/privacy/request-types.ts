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

const propagationRequestTypes = new Set([
  "correction",
  "consent_withdrawal",
  "restriction",
  "deletion",
]);

/**
 * These request types can change or remove data outside the primary
 * PostgreSQL transaction. Completion must therefore wait for a terminal,
 * auditable result from every configured processor. Access/export requests
 * are completed against their evidence artifact and do not require processor
 * propagation rows.
 */
export function privacyPropagationIsComplete(
  requestType: PrivacyRequestRow["requestType"] | string,
  rows: readonly {
    processor: string;
    state: string;
  }[],
) {
  if (!propagationRequestTypes.has(requestType)) return true;
  if (rows.length !== privacyProcessors.length) return false;
  const configured = new Set(privacyProcessors);
  const observed = new Set(rows.map((row) => row.processor));
  return (
    observed.size === configured.size &&
    rows.every(
      (row) =>
        configured.has(row.processor as PrivacyProcessor) &&
        (row.state === "succeeded" || row.state === "not_applicable"),
    )
  );
}
