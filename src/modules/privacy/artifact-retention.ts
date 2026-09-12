export type PersonArtifact = {
  id: string;
  kind:
    | "ai_run"
    | "ai_citation"
    | "ai_ephemeral_input"
    | "ai_suggestion"
    | "web_run"
    | "web_source";
  accepted?: boolean;
};

export type PersonArtifactDeletionPlan = {
  aiRunIds: string[];
  aiCitationIds: string[];
  aiEphemeralInputIds: string[];
  aiSuggestionIds: string[];
  webRunIds: string[];
  webSourceIds: string[];
  blocked: boolean;
};

/**
 * Plans local artifact cleanup without reading or disclosing artifact values.
 * Subject-rights deletion includes accepted provenance; ordinary retention does
 * not remove an accepted suggestion because it is the lineage for a domain
 * write. Any held artifact blocks the enclosing transaction rather than
 * allowing a partial cleanup.
 */
export function planPersonArtifactDeletion(input: {
  artifacts: readonly PersonArtifact[];
  heldIds: ReadonlySet<string>;
  mode?: "retention" | "subject_deletion";
}): PersonArtifactDeletionPlan {
  const mode = input.mode ?? "subject_deletion";
  const grouped = {
    aiRunIds: new Set<string>(),
    aiCitationIds: new Set<string>(),
    aiEphemeralInputIds: new Set<string>(),
    aiSuggestionIds: new Set<string>(),
    webRunIds: new Set<string>(),
    webSourceIds: new Set<string>(),
  };
  let blocked = false;
  for (const artifact of input.artifacts) {
    if (input.heldIds.has(artifact.id)) {
      blocked = true;
      continue;
    }
    if (
      mode === "retention" &&
      artifact.kind === "ai_suggestion" &&
      artifact.accepted
    )
      continue;
    if (artifact.kind === "ai_run") grouped.aiRunIds.add(artifact.id);
    else if (artifact.kind === "ai_citation")
      grouped.aiCitationIds.add(artifact.id);
    else if (artifact.kind === "ai_ephemeral_input")
      grouped.aiEphemeralInputIds.add(artifact.id);
    else if (artifact.kind === "ai_suggestion")
      grouped.aiSuggestionIds.add(artifact.id);
    else if (artifact.kind === "web_run") grouped.webRunIds.add(artifact.id);
    else grouped.webSourceIds.add(artifact.id);
  }
  return {
    aiRunIds: [...grouped.aiRunIds].sort(),
    aiCitationIds: [...grouped.aiCitationIds].sort(),
    aiEphemeralInputIds: [...grouped.aiEphemeralInputIds].sort(),
    aiSuggestionIds: [...grouped.aiSuggestionIds].sort(),
    webRunIds: [...grouped.webRunIds].sort(),
    webSourceIds: [...grouped.webSourceIds].sort(),
    blocked,
  };
}
