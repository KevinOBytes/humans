export function relationshipPresentation(input: {
  relationship: {
    labelOverride?: string | null;
    sourcePersonId?: string | null;
    targetPersonId?: string | null;
  };
  type?: {
    directed?: boolean | null;
    forwardLabel?: string | null;
    inverseLabel?: string | null;
  } | null;
  viewedPersonId: string;
}): { counterpartId: string | null; label: string } {
  const isTarget = input.relationship.targetPersonId === input.viewedPersonId;
  const counterpartId = isTarget
    ? input.relationship.sourcePersonId
    : input.relationship.targetPersonId;
  const directional = input.type?.directed && isTarget;
  return {
    counterpartId: counterpartId ?? null,
    label:
      input.relationship.labelOverride ??
      (directional ? input.type?.inverseLabel : input.type?.forwardLabel) ??
      "Related to",
  };
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});
const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function titleCase(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.replaceAll("_", " ").toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function temporalDateLabel(
  value: string,
  precision: string | null | undefined,
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  if (precision?.toLowerCase() === "year") return String(date.getUTCFullYear());
  if (precision?.toLowerCase() === "month") return monthFormatter.format(date);
  return dayFormatter.format(date);
}

export function relationshipSemanticPresentation(input: {
  confidence?: number | null;
  creationMethod?: string | null;
  reviewState?: string | null;
  state?: string | null;
  temporalPrecision?: string | null;
  temporalSemantics?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}): {
  claimLabel: string;
  confidenceLabel: string;
  originLabel: string;
  reviewLabel: string;
  temporalLabel: string;
} {
  const creationMethod = input.creationMethod?.toLowerCase();
  const reviewState = input.reviewState?.toLowerCase();
  const state = input.state?.toLowerCase();
  const originLabel =
    creationMethod === "ai"
      ? "AI-assisted"
      : creationMethod === "import"
        ? "Imported"
        : creationMethod === "manual"
          ? "Manual"
          : titleCase(creationMethod, "Origin not recorded");
  const claimLabel =
    reviewState === "approved"
      ? "Documented"
      : state === "inferred"
        ? "Hypothesis"
        : state === "asserted" && creationMethod === "manual"
          ? "Manual assertion"
          : titleCase(state, "Claim state not recorded");
  const confidenceLabel =
    input.confidence == null
      ? "Confidence not recorded"
      : `Confidence ${Math.round(input.confidence * 100)}%`;
  const from = input.validFrom
    ? temporalDateLabel(input.validFrom, input.temporalPrecision)
    : null;
  const until = input.validUntil
    ? temporalDateLabel(input.validUntil, input.temporalPrecision)
    : null;
  const semantics = input.temporalSemantics?.toLowerCase();
  let temporalLabel = "Time not specified";
  if (from && until) {
    temporalLabel = `${semantics === "approximate" ? "Approx. " : ""}${from}–${until}`;
  } else if (from) {
    temporalLabel =
      semantics === "after"
        ? `After ${from}`
        : semantics === "approximate"
          ? `Approx. from ${from}`
          : `From ${from}`;
  } else if (until) {
    temporalLabel =
      semantics === "before"
        ? `Before ${until}`
        : semantics === "approximate"
          ? `Approx. until ${until}`
          : `Until ${until}`;
  }
  return {
    claimLabel,
    confidenceLabel,
    originLabel,
    reviewLabel: titleCase(reviewState, "Review state not recorded"),
    temporalLabel,
  };
}
