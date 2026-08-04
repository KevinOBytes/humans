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
