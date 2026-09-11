import type { z } from "zod";
import type {
  aiProposedValueSchema,
  aiEvidenceReferenceSchema,
  normalizeAiSuggestion,
} from "./review-validation";
export type AiProposedValue = z.infer<typeof aiProposedValueSchema>;
export type AiEvidenceReference = z.infer<typeof aiEvidenceReferenceSchema>;
export type AiSuggestionInput = ReturnType<typeof normalizeAiSuggestion>;
export type AiReviewStatus = "pending" | "accepted" | "rejected" | "deferred";
