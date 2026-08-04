import { z } from "zod";

import type {
  ImportMapping,
  ImportValue,
  RelationshipEndpointMapping,
} from "./types";

const uuid = z.uuid();
const personNameKind = z.enum([
  "legal",
  "preferred",
  "birth",
  "married",
  "former",
  "alias",
  "transliteration",
  "other",
]);
const source = z.string().min(1).max(128);
const sensitivity = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const relationshipEndpoint = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PERSON_ID"), source }).strict(),
  z
    .object({
      kind: z.literal("EXTERNAL_KEY"),
      personImportId: uuid,
      source,
    })
    .strict(),
]);
const personMapping = z
  .object({
    version: z.literal(1),
    recordKind: z.literal("PERSON"),
    rowKeySource: source,
    person: z
      .object({
        displayNameSource: source,
        primaryNameKind: personNameKind,
        fields: z
          .array(
            z.object({
              field: z.enum(["biography", "preferredName", "sortName"]),
              source,
            }),
          )
          .max(16),
      })
      .strict(),
    facts: z.array(z.object({ definitionId: uuid, source }).strict()).max(100),
    defaults: z
      .object({
        sensitivity: sensitivity.optional(),
        status: z.enum(["active", "deceased", "missing", "unknown"]).optional(),
      })
      .strict(),
  })
  .strict();
const relationshipMapping = z
  .object({
    version: z.literal(1),
    recordKind: z.literal("RELATIONSHIP"),
    rowKeySource: source,
    relationship: z
      .object({
        typeId: uuid,
        sourcePerson: relationshipEndpoint,
        targetPerson: relationshipEndpoint,
        fields: z
          .array(
            z.object({ field: z.literal("labelOverride"), source }).strict(),
          )
          .max(8),
      })
      .strict(),
    defaults: z
      .object({
        sensitivity: sensitivity.optional(),
        state: z
          .enum(["asserted", "disputed", "disproven", "superseded"])
          .optional(),
      })
      .strict(),
  })
  .strict();
const mappingSchema = z.discriminatedUnion("recordKind", [
  personMapping,
  relationshipMapping,
]);

export function parseImportMappingEnvelope(value: unknown): ImportMapping {
  const result = mappingSchema.safeParse(value);
  if (!result.success) throw new TypeError("Invalid import mapping");
  return result.data;
}

export function formulaRisk(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[\s\u0000-\u001f]*(?:[=+\-@]|[＝＋－＠])/u.test(value)
  );
}

export function neutralizeSpreadsheetCell(value: string): string {
  return formulaRisk(value) ? `'${value}` : value;
}

export function parseImportMapping(
  value: unknown,
  columns: readonly string[],
): ImportMapping {
  const data = parseImportMappingEnvelope(value);
  const known = new Set(columns);
  const used = new Set<string>([data.rowKeySource]);
  if (data.recordKind === "PERSON") {
    used.add(data.person.displayNameSource);
    for (const field of data.person.fields) used.add(field.source);
    for (const fact of data.facts) used.add(fact.source);
  } else {
    used.add(data.relationship.sourcePerson.source);
    used.add(data.relationship.targetPerson.source);
    for (const field of data.relationship.fields) used.add(field.source);
  }
  if ([...used].some((item) => !known.has(item)))
    throw new TypeError("Import mapping references an unknown column");
  return data;
}

function text(value: ImportValue | undefined, required = false): string | null {
  if (value == null) {
    if (required) throw new TypeError("A required mapped value is missing");
    return null;
  }
  if (typeof value === "object")
    throw new TypeError("Mapped values must be scalar");
  const normalized = String(value).normalize("NFKC").trim();
  if (required && !normalized)
    throw new TypeError("A required mapped value is empty");
  if (normalized.length > 20_000)
    throw new TypeError("A mapped value is too long");
  return normalized || null;
}

const unsafeExternalKey =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function externalKey(value: ImportValue | undefined): string {
  const normalized = text(value, true)!;
  if (
    Buffer.byteLength(normalized, "utf8") > 512 ||
    unsafeExternalKey.test(normalized)
  ) {
    throw new TypeError("The external key is invalid");
  }
  return normalized;
}

function relationshipEndpointValue(
  endpoint: RelationshipEndpointMapping,
  values: Record<string, ImportValue>,
) {
  const value = externalKey(values[endpoint.source]);
  if (endpoint.kind === "EXTERNAL_KEY") {
    return {
      kind: "EXTERNAL_KEY" as const,
      personImportId: endpoint.personImportId,
      externalId: value,
    };
  }
  const result = uuid.safeParse(value);
  if (!result.success) throw new TypeError("A valid person UUID is required");
  return { kind: "PERSON_ID" as const, personId: result.data.toLowerCase() };
}

export function projectImportRow(
  mapping: ImportMapping,
  values: Record<string, ImportValue>,
) {
  const rowKey = externalKey(values[mapping.rowKeySource]);
  if (mapping.recordKind === "PERSON") {
    const person: Record<string, string> = {
      displayName: text(values[mapping.person.displayNameSource], true)!,
    };
    for (const field of mapping.person.fields) {
      const value = text(values[field.source]);
      if (value != null) person[field.field] = value;
    }
    return {
      kind: "PERSON" as const,
      rowKey,
      person,
      primaryNameKind: mapping.person.primaryNameKind,
      facts: mapping.facts.flatMap<{
        definitionId: string;
        value: ImportValue;
      }>((fact) => {
        const value = values[fact.source];
        if (value == null) return [];
        if (typeof value === "string") {
          const normalized = value.normalize("NFKC").trim();
          return normalized
            ? [{ definitionId: fact.definitionId, value: normalized }]
            : [];
        }
        return [{ definitionId: fact.definitionId, value }];
      }),
      defaults: mapping.defaults,
    };
  }
  return {
    kind: "RELATIONSHIP" as const,
    rowKey,
    relationship: {
      typeId: mapping.relationship.typeId,
      sourcePerson: relationshipEndpointValue(
        mapping.relationship.sourcePerson,
        values,
      ),
      targetPerson: relationshipEndpointValue(
        mapping.relationship.targetPerson,
        values,
      ),
      ...Object.fromEntries(
        mapping.relationship.fields.flatMap((field) => {
          const value = text(values[field.source]);
          return value == null ? [] : [[field.field, value]];
        }),
      ),
    },
    defaults: mapping.defaults,
  };
}
