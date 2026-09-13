import type { InferInsertModel } from "drizzle-orm";

import { newId } from "@/db/id";
import { factDefinitions } from "@/db/schema/facts";

/**
 * The portable profile fields provisioned for every newly-created workspace.
 *
 * These are definitions, not person data. Values still enter through the
 * audited fact service, so each value can retain temporal bounds, provenance,
 * confidence, review state, sensitivity, and contradictions. Workspaces may
 * add their own definitions without changing this catalog.
 */
export const DEFAULT_PROFILE_FACT_DEFINITIONS = [
  {
    namespace: "profile",
    fieldKey: "pronouns",
    label: "Pronouns",
    description: "A person-provided or source-backed pronoun set.",
    category: "identity",
    allowedValueType: "text",
    cardinality: "many",
    searchable: true,
    filterable: true,
    graphable: false,
    defaultSensitivity: "internal",
    state: "active",
  },
  {
    namespace: "profile",
    fieldKey: "employment",
    label: "Employment",
    description: "An employment role, employer, or employment period.",
    category: "work",
    allowedValueType: "text",
    cardinality: "many",
    searchable: true,
    filterable: true,
    graphable: true,
    defaultSensitivity: "internal",
    state: "active",
  },
  {
    namespace: "profile",
    fieldKey: "education",
    label: "Education",
    description: "An educational institution, program, or qualification.",
    category: "background",
    allowedValueType: "text",
    cardinality: "many",
    searchable: true,
    filterable: true,
    graphable: false,
    defaultSensitivity: "internal",
    state: "active",
  },
  {
    namespace: "profile",
    fieldKey: "language",
    label: "Language",
    description: "A language associated with the person and its evidence.",
    category: "profile",
    allowedValueType: "text",
    cardinality: "many",
    searchable: true,
    filterable: true,
    graphable: false,
    defaultSensitivity: "internal",
    state: "active",
  },
  {
    namespace: "profile",
    fieldKey: "organization",
    label: "Organization",
    description: "An organization affiliation or membership claim.",
    category: "affiliation",
    allowedValueType: "text",
    cardinality: "many",
    searchable: true,
    filterable: true,
    graphable: true,
    defaultSensitivity: "internal",
    state: "active",
  },
  {
    namespace: "profile",
    fieldKey: "birth_date",
    label: "Birth date",
    description: "A date or date range associated with birth evidence.",
    category: "identity",
    allowedValueType: "date",
    cardinality: "one",
    searchable: true,
    filterable: true,
    graphable: false,
    defaultSensitivity: "confidential",
    state: "active",
  },
  {
    namespace: "profile",
    fieldKey: "custom_note",
    label: "Custom profile field",
    description:
      "A workspace-defined JSON value; do not use it to bypass sensitivity or provenance controls.",
    category: "custom",
    allowedValueType: "json",
    cardinality: "many",
    searchable: false,
    filterable: false,
    graphable: false,
    defaultSensitivity: "internal",
    state: "active",
  },
] as const;

type FactDefinitionInsert = InferInsertModel<typeof factDefinitions>;

export function createDefaultProfileFactDefinitions(input: {
  workspaceId: string;
  actorId: string;
  idFactory?: () => string;
}): FactDefinitionInsert[] {
  const idFactory = input.idFactory ?? newId;
  return DEFAULT_PROFILE_FACT_DEFINITIONS.map((definition) => ({
    ...definition,
    id: idFactory(),
    workspaceId: input.workspaceId,
    createdBy: input.actorId,
    updatedBy: input.actorId,
  }));
}
