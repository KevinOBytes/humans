import { z } from "zod";
import { createGraphQLError } from "@/graphql/errors";
import { privacyRequestTypes, type PrivacyRequestState } from "./request-types";

const ids = z
  .array(z.uuid())
  .max(100)
  .default([])
  .transform((v) => v.map((id) => id.toLowerCase()).sort())
  .refine((v) => new Set(v).size === v.length);
const schema = z.object({
  requestType: z.enum(privacyRequestTypes),
  personIds: ids,
  fileIds: ids,
  caseId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullish()
    .transform((v) => v ?? null),
  dueAt: z.coerce.date(),
  executeAfter: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
});
export function normalizePrivacyRequest(value: unknown, now = new Date()) {
  const result = schema.safeParse(value);
  if (
    !result.success ||
    result.data.dueAt <= now ||
    result.data.dueAt.getTime() > now.getTime() + 366 * 86_400_000 ||
    result.data.personIds.length + result.data.fileIds.length < 1 ||
    result.data.personIds.length + result.data.fileIds.length > 100 ||
    (result.data.executeAfter &&
      (result.data.executeAfter < now ||
        result.data.executeAfter > result.data.dueAt))
  )
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The privacy request is invalid.",
    );
  if (
    (result.data.requestType === "consent_withdrawal" ||
      result.data.requestType === "restriction") &&
    (!result.data.personIds.length ||
      result.data.fileIds.length ||
      !result.data.purpose)
  )
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "A person scope and purpose are required.",
    );
  return { ...result.data, executeAfter: result.data.executeAfter ?? now };
}
export function assertPrivacyTransition(input: {
  from: PrivacyRequestState;
  to: PrivacyRequestState;
  verified: boolean;
  independentReviewer?: boolean;
  completionEvidence?: string | null;
  held?: boolean;
  destructive?: boolean;
}) {
  const transitions: Record<
    PrivacyRequestState,
    readonly PrivacyRequestState[]
  > = {
    requested: ["reviewing", "approved", "rejected", "cancelled"],
    reviewing: ["approved", "rejected", "cancelled"],
    approved: ["fulfilling", "cancelled"],
    fulfilling: ["completed"],
    completed: [],
    rejected: [],
    cancelled: [],
  };
  if (
    !transitions[input.from].includes(input.to) ||
    (input.to === "approved" &&
      (!input.verified || !input.independentReviewer)) ||
    (input.to === "fulfilling" &&
      (!input.verified || (input.destructive && input.held))) ||
    (input.to === "completed" && !input.completionEvidence)
  )
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The privacy request transition is not permitted.",
    );
}
