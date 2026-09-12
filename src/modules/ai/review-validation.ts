import { z } from "zod";
import { createGraphQLError } from "@/graphql/errors";

const text = (max: number) => z.string().trim().min(1).max(max);
const profileFields = [
  "displayName",
  "preferredName",
  "sortName",
  "biography",
] as const;
export const aiProposedValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("profile"),
      value: text(4000),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("fact"),
      definitionId: z.uuid(),
      value: z.union([
        z.object({ text: text(4000) }).strict(),
        z.object({ boolean: z.boolean() }).strict(),
        z
          .object({
            decimal: z
              .string()
              .regex(/^-?\d+(\.\d+)?$/)
              .max(100),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("relationship"),
      targetPersonId: z.uuid(),
      relationshipTypeId: z.uuid(),
    })
    .strict(),
]);
export const aiEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("evidence"),
      evidenceId: z.uuid(),
      locator: text(2000),
      quote: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("web"),
      url: z
        .url()
        .max(2048)
        .refine((v) => new URL(v).protocol === "https:"),
      locator: text(2000),
      quote: text(4000),
      snapshotHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .strict(),
]);
const suggestionSchema = z
  .object({
    personId: z.uuid(),
    caseId: z.uuid().nullish(),
    purpose: text(200).transform((s) => s.toLowerCase()),
    fieldKey: text(200),
    proposedValue: aiProposedValueSchema,
    confidence: z.number().min(0).max(1),
    uncertainty: text(4000),
    evidenceReferences: z.array(aiEvidenceReferenceSchema).min(1).max(5),
    provider: text(100),
    model: text(200),
    researchRunId: z.uuid(),
    runKind: z.enum(["analysis", "web"]),
    promptPolicyVersion: text(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.proposedValue.kind === "profile" &&
      (!profileFields.some((f) => f === v.fieldKey) ||
        (v.fieldKey !== "biography" && v.proposedValue.value.length > 200))
    )
      ctx.addIssue({ code: "custom", message: "Unsupported profile field." });
    if (
      v.proposedValue.kind !== "profile" &&
      (v.fieldKey !== v.proposedValue.kind ||
        v.evidenceReferences.some((e) => e.kind !== "evidence"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Facts and relationships require workspace evidence.",
      });
    if (
      v.runKind === "analysis" &&
      v.evidenceReferences.some((e) => e.kind === "web")
    )
      ctx.addIssue({
        code: "custom",
        message: "Analysis suggestions require cited evidence.",
      });
  });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The AI review input is invalid.",
    );
  return result.data;
}
export function normalizeAiSuggestion(input: unknown) {
  return parse(suggestionSchema, input);
}
export function normalizeAiReviewDecision(input: unknown) {
  const decision = parse(
    z
      .object({
        id: z.uuid(),
        expectedVersion: z.number().int().positive(),
        decision: z.enum(["accepted", "rejected", "deferred"]),
        explicitConfirmed: z.boolean().optional(),
        reason: text(2000).optional(),
      })
      .strict(),
    input,
  );
  if (decision.decision === "accepted" && !decision.explicitConfirmed)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Explicit human confirmation is required.",
    );
  if (decision.decision === "rejected" && !decision.reason)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "A rejection reason is required.",
    );
  return decision;
}
export function requireAiBatchApproval(input: {
  ids: string[];
  approved: boolean;
}) {
  if (
    !input.approved ||
    !input.ids.length ||
    input.ids.length > 20 ||
    new Set(input.ids).size !== input.ids.length
  )
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Explicit approval of 1–20 unique suggestions is required.",
    );
}
