import { createGraphQLError } from "@/graphql/errors";
import { decodeResearchCursor, normalizePagination } from "@/graphql/limits";
import { newId } from "@/db/id";
import { facts } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import { createPeopleRepository } from "@/modules/people/repository";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  visibleResourceIds,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction as writeTransaction,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
import type { Connection, MutationOutcome } from "@/modules/people/service";

import {
  createFactsRepository,
  type FactDefinitionRow,
  type FactRelationshipRow,
  type FactRevisionRow,
  type FactRow,
  type PersonFieldSelectionRow,
  sourceFactForRelationship,
  targetFactForRelationship,
} from "./repository";
import {
  normalizeHumanText,
  normalizeNamespaceKey,
  validateBoundedJson,
  validateFactValue,
  validateJsonSchema,
  validateTemporal,
  validateUnitDecimal,
  type FactValueInput,
  type ValidationIssue,
} from "./validation";

type DefinitionOutcome = MutationOutcome<FactDefinitionRow>;
type FactOutcome = MutationOutcome<FactRow>;

export type FactServiceRuntime = Readonly<{
  idempotencyHmacKey: string;
}>;

const FACT_CREATE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const FACT_REVISE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const FACT_SELECT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const FACT_RELATIONSHIP_CREATE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const FACT_RELATIONSHIP_ARCHIVE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invalid<T>(issues: ValidationIssue[]): MutationOutcome<T> {
  return { resource: null, issues, code: "VALIDATION_FAILED" };
}

function conflict<T>(currentVersion?: number): MutationOutcome<T> {
  return { resource: null, issues: [], code: "CONFLICT", currentVersion };
}

function fieldMaterial(
  value: CanonicalRequestMaterial | undefined,
): CanonicalRequestMaterial {
  return value === undefined
    ? { present: false }
    : { present: true, value: value ?? null };
}

type FactCreateResponseReference = ResearchResponseReference & {
  readonly factId: string | null;
  readonly outcome?: string;
};
type SelectionResponseReference = ResearchResponseReference & {
  readonly outcome?: string;
};
type FactReviseResponseReference = ResearchResponseReference & {
  readonly factId?: string;
  readonly outcome?: string;
};
type FactRelationshipResponseReference = ResearchResponseReference & {
  readonly relationshipId?: string;
  readonly outcome?: string;
};

type FactCreateInput = {
  personId: string;
  definitionId: string;
  value: FactValueInput;
  state?: string | null;
  confidence?: number | null;
  confidenceMethod?: string | null;
  confidenceExplanation?: string | null;
  sensitivity?: string | null;
  reviewState?: string | null;
  temporalSemantics?: string | null;
  temporalPrecision?: string | null;
  validEarliestAt?: string | null;
  validLatestAt?: string | null;
  observedAt?: string | null;
  supersedesFactId?: string | null;
  language?: string | null;
};

function factCreateRequestMaterial(
  input: FactCreateInput,
): Readonly<Record<string, CanonicalRequestMaterial>> {
  const date = (value: unknown): string | null =>
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : null;
  return {
    confidence: input.confidence ?? null,
    confidenceExplanation: input.confidenceExplanation ?? null,
    confidenceMethod: input.confidenceMethod ?? null,
    definitionId: input.definitionId,
    language: input.language ?? null,
    observedAt: input.observedAt ?? null,
    personId: input.personId,
    reviewState: input.reviewState ?? null,
    sensitivity: input.sensitivity ?? null,
    state: input.state ?? null,
    supersedesFactId: input.supersedesFactId ?? null,
    temporalPrecision: input.temporalPrecision ?? null,
    temporalSemantics: input.temporalSemantics ?? null,
    validEarliestAt: input.validEarliestAt ?? null,
    validLatestAt: input.validLatestAt ?? null,
    value: {
      boolean: input.value.boolean ?? null,
      dateEnd: date(input.value.dateEnd),
      dateStart: date(input.value.dateStart),
      decimal: input.value.decimal ?? null,
      fileId: input.value.fileId ?? null,
      json: (input.value.json ?? null) as CanonicalRequestMaterial,
      placeId: input.value.placeId ?? null,
      referencedPersonId: input.value.referencedPersonId ?? null,
      text: input.value.text ?? null,
      timestamp: date(input.value.timestamp),
      unit: input.value.unit ?? null,
    },
  };
}

function factReviseRequestMaterial(input: {
  id: string;
  expectedVersion: number;
  value?: FactValueInput | null;
  state?: string | null;
  confidence?: number | null;
  reviewState?: string | null;
  sensitivity?: string | null;
  changeReason?: string | null;
}): Readonly<Record<string, CanonicalRequestMaterial>> {
  const date = (value: unknown): string | null =>
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : null;
  const value = input.value;
  return {
    changeReason: fieldMaterial(input.changeReason),
    confidence: fieldMaterial(input.confidence),
    expectedVersion: input.expectedVersion,
    id: input.id,
    reviewState: fieldMaterial(input.reviewState),
    sensitivity: fieldMaterial(input.sensitivity),
    state: fieldMaterial(input.state),
    value: fieldMaterial(
      value === undefined
        ? undefined
        : {
            boolean: value?.boolean ?? null,
            dateEnd: date(value?.dateEnd),
            dateStart: date(value?.dateStart),
            decimal: value?.decimal ?? null,
            fileId: value?.fileId ?? null,
            json: (value?.json ?? null) as CanonicalRequestMaterial,
            placeId: value?.placeId ?? null,
            referencedPersonId: value?.referencedPersonId ?? null,
            text: value?.text ?? null,
            timestamp: date(value?.timestamp),
            unit: value?.unit ?? null,
          },
    ),
  };
}

function encodeFactReviseOutcome(result: FactOutcome): string {
  return encodeFactCreateOutcome(result);
}

function decodeFactReviseOutcome(value: string): FactOutcome {
  try {
    return decodeFactCreateOutcome(value);
  } catch {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored fact revision result is invalid.",
    );
  }
}

function factRelationshipCreateRequestMaterial(input: {
  sourceFactId: string;
  targetFactId: string;
  relationshipType: string;
  explanation?: string | null;
}): Readonly<Record<string, CanonicalRequestMaterial>> {
  return {
    explanation: fieldMaterial(input.explanation),
    relationshipType: input.relationshipType.toLowerCase(),
    sourceFactId: input.sourceFactId,
    targetFactId: input.targetFactId,
  };
}

function factRelationshipArchiveRequestMaterial(input: {
  id: string;
  expectedVersion: number;
}): Readonly<Record<string, CanonicalRequestMaterial>> {
  return {
    expectedVersion: input.expectedVersion,
    id: input.id,
  };
}

function encodeFactCreateOutcome(result: FactOutcome): string {
  return JSON.stringify({
    code: result.code,
    currentVersion: result.currentVersion ?? null,
    issues: result.issues,
  });
}

function decodeFactCreateOutcome(value: string): FactOutcome {
  try {
    const parsed = JSON.parse(value) as {
      code?: unknown;
      currentVersion?: unknown;
      issues?: unknown;
    };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.issues) ||
      (parsed.code !== null && typeof parsed.code !== "string") ||
      (parsed.currentVersion !== null &&
        parsed.currentVersion !== undefined &&
        !Number.isInteger(parsed.currentVersion))
    ) {
      throw new Error("invalid outcome");
    }
    return {
      resource: null,
      issues: parsed.issues as ValidationIssue[],
      code: parsed.code as FactOutcome["code"],
      ...(parsed.currentVersion === undefined || parsed.currentVersion === null
        ? {}
        : { currentVersion: parsed.currentVersion as number }),
    };
  } catch {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored fact mutation result is invalid.",
    );
  }
}

function encodeSelectionOutcome(
  result: MutationOutcome<PersonFieldSelectionRow>,
): string {
  return JSON.stringify({
    code: result.code,
    currentVersion: result.currentVersion ?? null,
    issues: result.issues,
  });
}

function decodeSelectionOutcome(
  value: string,
): MutationOutcome<PersonFieldSelectionRow> {
  try {
    const parsed = JSON.parse(value) as {
      code?: unknown;
      currentVersion?: unknown;
      issues?: unknown;
    };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.issues) ||
      (parsed.code !== null && typeof parsed.code !== "string") ||
      (parsed.currentVersion !== null &&
        parsed.currentVersion !== undefined &&
        !Number.isInteger(parsed.currentVersion))
    ) {
      throw new Error("invalid outcome");
    }
    return {
      resource: null,
      issues: parsed.issues as ValidationIssue[],
      code: parsed.code as MutationOutcome<PersonFieldSelectionRow>["code"],
      ...(parsed.currentVersion === undefined || parsed.currentVersion === null
        ? {}
        : { currentVersion: parsed.currentVersion as number }),
    };
  } catch {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored fact selection result is invalid.",
    );
  }
}

function versionIssues(value: number): ValidationIssue[] {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
    ? []
    : [
        {
          path: ["expectedVersion"],
          code: "INVALID_VERSION",
          message: "A positive version is required.",
        },
      ];
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString(
    "base64url",
  );
}

const decode = decodeResearchCursor;

function factSnapshot(row: FactRow): Record<string, unknown> {
  return {
    id: row.id,
    personId: row.personId,
    factDefinitionId: row.factDefinitionId,
    namespace: row.namespace,
    fieldKey: row.fieldKey,
    label: row.label,
    valueType: row.valueType,
    valueText: row.valueText,
    valueDecimal: row.valueDecimal,
    valueBoolean: row.valueBoolean,
    valueDateStart: row.valueDateStart,
    valueDateEnd: row.valueDateEnd,
    valueTimestamp: row.valueTimestamp?.toISOString() ?? null,
    valueJson: row.valueJson,
    referencedPersonId: row.referencedPersonId,
    placeId: row.placeId,
    fileId: row.fileId,
    unit: row.unit,
    language: row.language,
    state: row.state,
    confidence: row.confidence,
    confidenceMethod: row.confidenceMethod,
    confidenceExplanation: row.confidenceExplanation,
    sensitivity: row.sensitivity,
    reviewState: row.reviewState,
    temporalSemantics: row.temporalSemantics,
    validEarliestAt: row.validEarliestAt?.toISOString() ?? null,
    validLatestAt: row.validLatestAt?.toISOString() ?? null,
    observedAt: row.observedAt?.toISOString() ?? null,
    assertedAt: row.assertedAt.toISOString(),
    temporalPrecision: row.temporalPrecision,
    supersedesFactId: row.supersedesFactId,
    version: row.version,
  };
}

export function createFactsService(
  context: ResearchServiceContext,
  runtime?: FactServiceRuntime,
) {
  const repository = createFactsRepository(context.database);
  const peopleRepository = createPeopleRepository(context.database);
  const audit = createAuditService(context);
  const factVisibility = resourceVisibilitySql(context, {
    resourceKind: "fact",
    id: facts.id,
    sensitivity: facts.sensitivity,
  });
  const personVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: people.id,
    sensitivity: people.sensitivity,
  });
  const sourceFactRelationshipVisibility = resourceVisibilitySql(context, {
    resourceKind: "fact",
    id: sourceFactForRelationship.id,
    sensitivity: sourceFactForRelationship.sensitivity,
  });
  const targetFactRelationshipVisibility = resourceVisibilitySql(context, {
    resourceKind: "fact",
    id: targetFactForRelationship.id,
    sensitivity: targetFactForRelationship.sensitivity,
  });

  async function visibleFactIds(
    rows: readonly FactRow[],
  ): Promise<ReadonlySet<string>> {
    return visibleResourceIds(context.database, context, {
      resourceKind: "fact",
      resources: rows.map((row) => ({
        id: row.id,
        sensitivity: row.sensitivity,
      })),
    });
  }

  async function visibleFact(row: FactRow): Promise<boolean> {
    return (await visibleFactIds([row])).has(row.id);
  }

  async function requireVisiblePerson(id: string): Promise<void> {
    const person = await peopleRepository.getById({
      workspaceId: context.workspaceId,
      id,
    });
    if (
      !person ||
      !(await canAccessResource(context.database, context, {
        id: person.id,
        resourceKind: "person",
        sensitivity: person.sensitivity,
      }))
    ) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
  }

  async function replayFactRelationship(
    responseReference: ResearchResponseReference,
  ): Promise<FactRelationshipRow> {
    const relationshipId = responseReference.relationshipId;
    if (typeof relationshipId !== "string" || !UUID.test(relationshipId)) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    const row = await repository.getFactRelationship({
      workspaceId: context.workspaceId,
      id: relationshipId,
      includeDeleted: true,
    });
    if (!row) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    const [source, target] = await Promise.all([
      repository.getFact({
        workspaceId: context.workspaceId,
        id: row.sourceFactId,
      }),
      repository.getFact({
        workspaceId: context.workspaceId,
        id: row.targetFactId,
      }),
    ]);
    if (
      !source ||
      !target ||
      !(await visibleFact(source)) ||
      !(await visibleFact(target))
    ) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    return row;
  }

  async function replaySelection(
    responseReference: ResearchResponseReference,
  ): Promise<PersonFieldSelectionRow> {
    const selectionId = responseReference.selectionId;
    const personId = responseReference.personId;
    const namespace = responseReference.namespace;
    const fieldKey = responseReference.fieldKey;
    const version = responseReference.version;
    if (
      typeof selectionId !== "string" ||
      !UUID.test(selectionId) ||
      typeof personId !== "string" ||
      !UUID.test(personId) ||
      typeof namespace !== "string" ||
      typeof fieldKey !== "string" ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    await requireVisiblePerson(personId);
    const row = await repository.getSelection({
      workspaceId: context.workspaceId,
      personId,
      namespace,
      fieldKey,
    });
    if (!row || row.id !== selectionId)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    if (row.version !== version)
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation response is no longer current.",
      );
    const fact = await repository.getFact({
      workspaceId: context.workspaceId,
      id: row.factId,
    });
    if (!fact || !(await visibleFact(fact)))
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    return row;
  }

  return {
    async redactRevisionSnapshot(
      snapshot: unknown,
    ): Promise<Record<string, unknown> | null> {
      return (await this.redactRevisionSnapshots([snapshot]))[0] ?? null;
    },
    async redactRevisionSnapshots(
      snapshots: readonly unknown[],
    ): Promise<readonly (Record<string, unknown> | null)[]> {
      const redacted = snapshots.map((snapshot) =>
        snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
          ? (structuredClone(snapshot) as Record<string, unknown>)
          : null,
      );
      const collect = (keys: readonly string[]) => [
        ...new Set(
          redacted.flatMap((snapshot) =>
            snapshot
              ? keys
                  .map((key) => snapshot[key])
                  .filter((value): value is string => typeof value === "string")
              : [],
          ),
        ),
      ];
      const personIds = collect(["personId", "referencedPersonId"]);
      const fileIds = collect(["fileId"]);
      const supersedesIds = collect(["supersedesFactId"]);
      const visiblePeople = context.permissions.has("person:read")
        ? await peopleRepository.getByIds({
            workspaceId: context.workspaceId,
            ids: personIds,
          })
        : [];
      const visiblePersonIds = await visibleResourceIds(
        context.database,
        context,
        {
          resourceKind: "person",
          resources: visiblePeople.map((row) => ({
            id: row.id,
            sensitivity: row.sensitivity,
          })),
        },
      );
      const visibleFiles = context.permissions.has("file:read")
        ? await repository.getResourceReferences({
            workspaceId: context.workspaceId,
            kind: "file",
            ids: fileIds,
          })
        : [];
      const visibleFileIds = await visibleResourceIds(
        context.database,
        context,
        { resourceKind: "file", resources: visibleFiles },
      );
      const visibleSupersedes = context.permissions.has("fact:read")
        ? await repository.getFactsByIds({
            workspaceId: context.workspaceId,
            ids: supersedesIds,
            visibility: factVisibility,
          })
        : [];
      const visibleSupersedesIds = new Set(
        visibleSupersedes.map((row) => row.id),
      );
      return redacted.map((snapshot) => {
        if (!snapshot) return null;
        for (const key of ["personId", "referencedPersonId"] as const)
          if (
            typeof snapshot[key] === "string" &&
            !visiblePersonIds.has(snapshot[key])
          )
            snapshot[key] = null;
        if (typeof snapshot.placeId === "string") snapshot.placeId = null;
        if (
          typeof snapshot.fileId === "string" &&
          !visibleFileIds.has(snapshot.fileId)
        )
          snapshot.fileId = null;
        if (
          typeof snapshot.supersedesFactId === "string" &&
          !visibleSupersedesIds.has(snapshot.supersedesFactId)
        )
          snapshot.supersedesFactId = null;
        return snapshot;
      });
    },
    async canReadReference(
      kind: "person" | "place" | "file",
      id: string,
    ): Promise<boolean> {
      const row = await repository.getResourceReference({
        workspaceId: context.workspaceId,
        kind,
        id,
      });
      return Boolean(
        row &&
        (await canAccessResource(context.database, context, {
          id: row.id,
          resourceKind: kind,
          sensitivity: row.sensitivity,
        })),
      );
    },
    async getDefinition(id: string) {
      return repository.getDefinition({ workspaceId: context.workspaceId, id });
    },
    async getDefinitionsByIds(ids: readonly string[]) {
      const rows = await repository.getDefinitionsByIds({
        workspaceId: context.workspaceId,
        ids,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listDefinitions(input: {
      first?: number | null;
      after?: string | null;
      namespace?: string | null;
      fieldKey?: string | null;
      category?: string | null;
      allowedValueType?: string | null;
      cardinality?: string | null;
      searchable?: boolean | null;
      filterable?: boolean | null;
      graphable?: boolean | null;
      defaultSensitivity?: string | null;
      state?: string | null;
    }): Promise<Connection<FactDefinitionRow>> {
      const page = normalizePagination(input);
      const namespace = input.namespace
        ? normalizeNamespaceKey(input.namespace, ["filter", "namespace"])
        : { value: null, issues: [] as ValidationIssue[] };
      const fieldKey = input.fieldKey
        ? normalizeNamespaceKey(input.fieldKey, ["filter", "fieldKey"])
        : { value: null, issues: [] as ValidationIssue[] };
      const category = input.category
        ? normalizeHumanText(input.category, {
            path: ["filter", "category"],
            min: 1,
            max: 100,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      if (
        namespace.issues.length ||
        fieldKey.issues.length ||
        category.issues.length
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The fact definition filter is invalid.",
        );
      const decoded = decode(page.after, "fact-definition-key-asc");
      const cursor =
        decoded &&
        typeof decoded.n === "string" &&
        typeof decoded.k === "string"
          ? { namespace: decoded.n, key: decoded.k, id: decoded.i as string }
          : null;
      if (decoded && !cursor)
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const rows = await repository.listDefinitions({
        workspaceId: context.workspaceId,
        limit: page.first + 1,
        cursor,
        namespace: namespace.value,
        fieldKey: fieldKey.value,
        category: category.value,
        allowedValueType: input.allowedValueType as
          FactDefinitionRow["allowedValueType"] | null | undefined,
        cardinality: input.cardinality as
          FactDefinitionRow["cardinality"] | null | undefined,
        searchable: input.searchable,
        filterable: input.filterable,
        graphable: input.graphable,
        defaultSensitivity: input.defaultSensitivity as
          FactDefinitionRow["defaultSensitivity"] | null | undefined,
        state: input.state as FactDefinitionRow["state"] | null | undefined,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encode({
                o: "fact-definition-key-asc",
                n: last.namespace,
                k: last.fieldKey,
                i: last.id,
              })
            : null,
        },
      };
    },
    async createDefinition(input: {
      namespace: string;
      fieldKey: string;
      label: string;
      description?: string | null;
      category?: string | null;
      allowedValueType: string;
      cardinality?: string | null;
      validationSchema?: unknown;
      enumerationMetadata?: unknown;
      searchable?: boolean | null;
      filterable?: boolean | null;
      graphable?: boolean | null;
      defaultSensitivity?: string | null;
      state?: string | null;
    }): Promise<DefinitionOutcome> {
      const namespace = normalizeNamespaceKey(input.namespace, ["namespace"]);
      const fieldKey = normalizeNamespaceKey(input.fieldKey, ["fieldKey"]);
      const label = normalizeHumanText(input.label, {
        path: ["label"],
        min: 1,
        max: 300,
      });
      const description =
        input.description == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.description, {
              path: ["description"],
              max: 20_000,
              allowLineBreaks: true,
            });
      const category =
        input.category == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.category, {
              path: ["category"],
              min: 1,
              max: 200,
            });
      const issues = [
        ...namespace.issues,
        ...fieldKey.issues,
        ...label.issues,
        ...description.issues,
        ...category.issues,
      ];
      const valueTypes = [
        "text",
        "rich_text",
        "integer",
        "decimal",
        "boolean",
        "date",
        "date_range",
        "timestamp",
        "duration",
        "quantity",
        "uri",
        "json",
        "person_reference",
        "place_reference",
        "file_reference",
      ];
      const allowedValueType = input.allowedValueType.toLowerCase();
      const cardinality = (input.cardinality ?? "one").toLowerCase();
      const state = (input.state ?? "active").toLowerCase();
      const defaultSensitivity = (
        input.defaultSensitivity ?? "internal"
      ).toLowerCase();
      if (!valueTypes.includes(allowedValueType))
        issues.push({
          path: ["allowedValueType"],
          code: "INVALID_ENUM",
          message: "Invalid fact value type.",
        });
      if (!["one", "many"].includes(cardinality))
        issues.push({
          path: ["cardinality"],
          code: "INVALID_ENUM",
          message: "Invalid cardinality.",
        });
      if (!["draft", "active", "deprecated", "archived"].includes(state))
        issues.push({
          path: ["state"],
          code: "INVALID_ENUM",
          message: "Invalid definition state.",
        });
      if (
        !["public", "internal", "confidential", "restricted"].includes(
          defaultSensitivity,
        )
      )
        issues.push({
          path: ["defaultSensitivity"],
          code: "INVALID_ENUM",
          message: "Invalid sensitivity.",
        });
      const validationSchema =
        input.validationSchema == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : validateBoundedJson(input.validationSchema, {
              objectOnly: true,
              path: ["validationSchema"],
            });
      const enumerationMetadata =
        input.enumerationMetadata == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : validateBoundedJson(input.enumerationMetadata, {
              objectOnly: true,
              path: ["enumerationMetadata"],
            });
      issues.push(...validationSchema.issues, ...enumerationMetadata.issues);
      if (issues.length > 0) return invalid(issues);
      const id = newId();
      try {
        const row = await writeTransaction(context, async (transaction) => {
          const scoped = createFactsRepository(
            transaction as unknown as typeof context.database,
          );
          const created = await scoped.createDefinition({
            workspaceId: context.workspaceId,
            value: {
              id,
              namespace: namespace.value!,
              fieldKey: fieldKey.value!,
              label: label.value!,
              description: description.value,
              category: category.value,
              allowedValueType:
                allowedValueType as FactDefinitionRow["allowedValueType"],
              cardinality: cardinality as FactDefinitionRow["cardinality"],
              validationSchema: validationSchema.value,
              enumerationMetadata: enumerationMetadata.value,
              searchable: input.searchable ?? false,
              filterable: input.filterable ?? false,
              graphable: input.graphable ?? false,
              defaultSensitivity:
                defaultSensitivity as FactDefinitionRow["defaultSensitivity"],
              state: state as FactDefinitionRow["state"],
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            },
          });
          await audit.write(transaction as unknown as typeof context.database, {
            action: "factDefinition.create",
            resourceKind: "factDefinition",
            resourceId: created.id,
            changedFields: [
              "namespace",
              "fieldKey",
              "label",
              "allowedValueType",
              "cardinality",
              "state",
            ],
            metadata: { state: created.state, version: created.version },
          });
          await applySearchIndexMaintenance(context, transaction, [
            {
              action: "upsert",
              sourceId: created.id,
              sourceKind: "fact_definition",
              sourceVersion: created.version,
              workspaceId: context.workspaceId,
            },
          ]);
          return created;
        });
        return { resource: row, issues: [], code: null };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return conflict();
        throw error;
      }
    },
    async updateDefinition(input: {
      id: string;
      expectedVersion: number;
      label?: string | null;
      description?: string | null;
      category?: string | null;
      validationSchema?: unknown;
      state?: string | null;
    }): Promise<DefinitionOutcome> {
      const issues = versionIssues(input.expectedVersion);
      const current = await repository.getDefinition({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changed: string[] = [];
      for (const [key, value, max] of [
        ["label", input.label, 300],
        ["description", input.description, 20_000],
        ["category", input.category, 200],
      ] as const) {
        if (value === undefined) continue;
        if (value === null && key !== "label") patch[key] = null;
        else {
          const normalized = normalizeHumanText(value, {
            path: [key],
            min: 1,
            max,
            allowLineBreaks: key === "description",
          });
          if (normalized.issues.length > 0) issues.push(...normalized.issues);
          else patch[key] = normalized.value;
        }
        changed.push(key);
      }
      if (input.validationSchema !== undefined) {
        if (input.validationSchema === null) patch.validationSchema = null;
        else {
          const checked = validateBoundedJson(input.validationSchema, {
            objectOnly: true,
            path: ["validationSchema"],
          });
          if (checked.issues.length > 0) issues.push(...checked.issues);
          else patch.validationSchema = checked.value;
        }
        changed.push("validationSchema");
      }
      if (input.state !== undefined) {
        const state = input.state?.toLowerCase();
        if (
          !state ||
          !["draft", "active", "deprecated", "archived"].includes(state)
        )
          issues.push({
            path: ["state"],
            code: "INVALID_ENUM",
            message: "Invalid definition state.",
          });
        else patch.state = state;
        changed.push("state");
      }
      if (issues.length > 0) return invalid(issues);
      const row = await writeTransaction(context, async (transaction) => {
        const scoped = createFactsRepository(
          transaction as unknown as typeof context.database,
        );
        const updated = await scoped.updateDefinitionIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "factDefinition.update",
          resourceKind: "factDefinition",
          resourceId: updated.id,
          changedFields: changed,
          metadata: { state: updated.state, version: updated.version },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "fact_definition",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      if (!row) return conflict(current.version);
      return { resource: row, issues: [], code: null };
    },
    async get(id: string): Promise<FactRow | null> {
      const row = await repository.getFact({
        workspaceId: context.workspaceId,
        id,
        visibility: factVisibility,
      });
      return row;
    },
    async getByIds(ids: readonly string[]) {
      const rows = await repository.getFactsByIds({
        workspaceId: context.workspaceId,
        ids,
        visibility: factVisibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listForPeople(
      keys: readonly {
        personId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<FactRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decode(key.after, "facts-asserted-desc");
        const cursor =
          decoded && typeof decoded.t === "string"
            ? { assertedAt: new Date(decoded.t), id: decoded.i as string }
            : null;
        if (cursor && Number.isNaN(cursor.assertedAt.getTime()))
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return { pageKey, personId: key.personId, cursor };
      });
      const chunkSize = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listFactsForPeople({
        workspaceId: context.workspaceId,
        pages,
        limitPerPerson: chunkSize,
        visibility: factVisibility,
        personVisibility,
      });
      const grouped = new Map<number, FactRow[]>();
      for (const row of rows)
        grouped.set(row.pageKey, [...(grouped.get(row.pageKey) ?? []), row]);
      return keys.map((key, pageKey) => {
        const values = grouped.get(pageKey) ?? [];
        const nodes = values.slice(0, key.first);
        const last = nodes.at(-1);
        return {
          nodes,
          pageInfo: {
            hasNextPage: values.length > key.first,
            endCursor: last
              ? encode({
                  o: "facts-asserted-desc",
                  t: last.assertedAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async listSelectionsForPeople(
      keys: readonly {
        personId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<PersonFieldSelectionRow>[]> {
      if (keys.length === 0) return [];
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decode(key.after, "person-field-selection-key-asc");
        return {
          pageKey,
          personId: key.personId,
          cursor: decoded
            ? {
                namespace: decoded.n as string,
                fieldKey: decoded.k as string,
                id: decoded.i as string,
              }
            : null,
        };
      });
      const chunkSize = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listSelectionsForPeople({
        workspaceId: context.workspaceId,
        pages,
        limitPerPerson: chunkSize,
        factVisibility,
        personVisibility,
      });
      const grouped = new Map<number, PersonFieldSelectionRow[]>();
      for (const row of rows) {
        grouped.set(row.pageKey, [...(grouped.get(row.pageKey) ?? []), row]);
      }
      return keys.map((key, pageKey) => {
        const values = grouped.get(pageKey) ?? [];
        const nodes = values.slice(0, key.first);
        const last = nodes.at(-1);
        return {
          nodes,
          pageInfo: {
            hasNextPage: values.length > key.first,
            endCursor: last
              ? encode({
                  o: "person-field-selection-key-asc",
                  n: last.namespace,
                  k: last.fieldKey,
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async listRevisionsForFacts(
      keys: readonly {
        factId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<FactRevisionRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decode(key.after, "fact-revision-desc");
        const cursor =
          decoded && typeof decoded.r === "number"
            ? { revision: decoded.r, id: decoded.i as string }
            : null;
        if (decoded && !cursor)
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return { pageKey, factId: key.factId, cursor };
      });
      const factIds = [...new Set(keys.map((key) => key.factId))];
      const visibleFacts = await repository.getFactsByIds({
        workspaceId: context.workspaceId,
        ids: factIds,
        visibility: factVisibility,
      });
      const visibleIds = new Set(visibleFacts.map((row) => row.id));
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listRevisionsForFacts({
        workspaceId: context.workspaceId,
        pages: pages.filter((page) => visibleIds.has(page.factId)),
        limitPerFact: limit,
      });
      const grouped = new Map<number, FactRevisionRow[]>();
      for (const row of rows)
        grouped.set(row.pageKey, [...(grouped.get(row.pageKey) ?? []), row]);
      return keys.map((key, pageKey) => {
        const values = grouped.get(pageKey) ?? [];
        const nodes = values.slice(0, key.first);
        const last = nodes.at(-1);
        return {
          nodes,
          pageInfo: {
            hasNextPage: values.length > key.first,
            endCursor: last
              ? encode({
                  o: "fact-revision-desc",
                  r: last.revision,
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async list(input: {
      first?: number | null;
      after?: string | null;
      personId?: string | null;
      definitionId?: string | null;
      namespace?: string | null;
      fieldKey?: string | null;
      state?: string | null;
      reviewState?: string | null;
      sensitivity?: string | null;
    }): Promise<Connection<FactRow>> {
      const page = normalizePagination(input);
      const namespace = input.namespace
        ? normalizeNamespaceKey(input.namespace, ["filter", "namespace"])
        : { value: null, issues: [] as ValidationIssue[] };
      const fieldKey = input.fieldKey
        ? normalizeNamespaceKey(input.fieldKey, ["filter", "fieldKey"])
        : { value: null, issues: [] as ValidationIssue[] };
      if (namespace.issues.length || fieldKey.issues.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The fact filter is invalid.",
        );
      const decoded = decode(page.after, "facts-asserted-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { assertedAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.assertedAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const chunkSize = Math.min(101, page.first + 1);
      const rows = await repository.listFacts({
        workspaceId: context.workspaceId,
        limit: chunkSize,
        cursor,
        personId: input.personId,
        definitionId: input.definitionId,
        namespace: namespace.value,
        fieldKey: fieldKey.value,
        state: input.state as FactRow["state"] | null | undefined,
        reviewState: input.reviewState as
          FactRow["reviewState"] | null | undefined,
        sensitivity: input.sensitivity as
          FactRow["sensitivity"] | null | undefined,
        visibility: factVisibility,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encode({
                o: "facts-asserted-desc",
                t: last.assertedAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async create(input: FactCreateInput): Promise<FactOutcome> {
      await requireVisiblePerson(input.personId);
      const definition = await repository.getDefinitionForUpdate({
        workspaceId: context.workspaceId,
        id: input.definitionId,
      });
      if (!definition || definition.state !== "active")
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const value = validateFactValue(definition.allowedValueType, input.value);
      const confidence = validateUnitDecimal(input.confidence ?? 1, {
        min: 0,
        max: 1,
        path: ["confidence"],
      });
      const temporal = validateTemporal({
        semantics: input.temporalSemantics ?? "unknown",
        precision: input.temporalPrecision ?? "unknown",
        earliest: input.validEarliestAt,
        latest: input.validLatestAt,
      });
      const issues = [
        ...value.issues,
        ...confidence.issues,
        ...temporal.issues,
      ];
      if (value.issues.length === 0) {
        const reference = value.value!;
        for (const [kind, id] of [
          ["person", reference.referencedPersonId],
          ["place", reference.placeId],
          ["file", reference.fileId],
        ] as const) {
          if (
            id &&
            !(await repository.resourceReferenceExists({
              workspaceId: context.workspaceId,
              kind,
              id,
            }))
          )
            issues.push({
              path: ["value"],
              code: "NOT_FOUND",
              message: "A referenced value is unavailable.",
            });
        }
        if (
          definition.validationSchema != null &&
          definition.allowedValueType === "json"
        ) {
          const schemaValidation = validateJsonSchema(
            `${context.workspaceId}:${definition.id}:${definition.version}`,
            definition.validationSchema,
            reference.valueJson,
          );
          if (
            schemaValidation.issues.some(
              (item) => item.code === "INVALID_STORED_SCHEMA",
            )
          )
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "The fact definition is not usable.",
            );
          issues.push(...schemaValidation.issues);
        }
      }
      const state = (input.state ?? "asserted").toLowerCase();
      const reviewState = (input.reviewState ?? "unreviewed").toLowerCase();
      const sensitivity = (
        input.sensitivity ?? definition.defaultSensitivity
      ).toLowerCase();
      if (
        ![
          "asserted",
          "corroborated",
          "disputed",
          "disproven",
          "superseded",
          "unknown",
        ].includes(state)
      )
        issues.push({
          path: ["state"],
          code: "INVALID_ENUM",
          message: "Invalid fact state.",
        });
      if (
        ![
          "unreviewed",
          "in_review",
          "accepted",
          "rejected",
          "needs_attention",
        ].includes(reviewState)
      )
        issues.push({
          path: ["reviewState"],
          code: "INVALID_ENUM",
          message: "Invalid review state.",
        });
      if (
        !["public", "internal", "confidential", "restricted"].includes(
          sensitivity,
        )
      )
        issues.push({
          path: ["sensitivity"],
          code: "INVALID_ENUM",
          message: "Invalid sensitivity.",
        });
      if (input.supersedesFactId) {
        const superseded = await repository.getFact({
          workspaceId: context.workspaceId,
          id: input.supersedesFactId,
        });
        if (!superseded || !(await visibleFact(superseded)))
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
      }
      if (issues.length > 0) return invalid(issues);
      const id = newId();
      const now = new Date();
      const row = await writeTransaction(context, async (transaction) => {
        const scoped = createFactsRepository(
          transaction as unknown as typeof context.database,
        );
        const created = await scoped.createFact({
          workspaceId: context.workspaceId,
          value: {
            id,
            personId: input.personId,
            factDefinitionId: definition.id,
            namespace: definition.namespace,
            fieldKey: definition.fieldKey,
            label: definition.label,
            valueType: definition.allowedValueType,
            ...value.value!,
            language: input.language?.trim() || null,
            state: state as FactRow["state"],
            confidence: confidence.value ?? "1",
            confidenceMethod: input.confidenceMethod?.trim() || null,
            confidenceExplanation: input.confidenceExplanation?.trim() || null,
            sensitivity: sensitivity as FactRow["sensitivity"],
            reviewState: reviewState as FactRow["reviewState"],
            temporalSemantics: temporal.value!
              .semantics as FactRow["temporalSemantics"],
            temporalPrecision: temporal.value!
              .precision as FactRow["temporalPrecision"],
            validEarliestAt: temporal.value!.earliest,
            validLatestAt: temporal.value!.latest,
            observedAt: input.observedAt ? new Date(input.observedAt) : null,
            assertedAt: now,
            supersedesFactId: input.supersedesFactId ?? null,
            createdAt: now,
            createdBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          },
        });
        await scoped.createRevision({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            factId: created.id,
            revision: 1,
            beforeSnapshot: null,
            afterSnapshot: factSnapshot(created),
            createdBy: context.actor.principalId,
          },
        });
        await audit.write(transaction as unknown as typeof context.database, {
          action: "fact.create",
          resourceKind: "fact",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: [
            "personId",
            "factDefinitionId",
            "value",
            "state",
            "confidence",
            "sensitivity",
            "reviewState",
            "temporal",
          ],
          metadata: {
            state: created.state,
            sensitivity: created.sensitivity,
            reviewState: created.reviewState,
            version: created.version,
          },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "fact",
            sourceVersion: created.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async createIdempotent(
      input: FactCreateInput & { idempotencyKey: string },
    ): Promise<FactOutcome> {
      if (!runtime?.idempotencyHmacKey) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Fact idempotency is not configured.",
        );
      }
      const createInput = {
        ...input,
      } as FactCreateInput & { idempotencyKey?: string };
      delete createInput.idempotencyKey;
      const derived = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + FACT_CREATE_IDEMPOTENCY_TTL_MS),
        idempotencyKey: input.idempotencyKey,
        operation: "fact.create.graphql",
        requestMaterial: factCreateRequestMaterial(createInput),
        secret: runtime.idempotencyHmacKey,
      });
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        derived,
        ["fact:create", "person:read"],
        async (scopedContext): Promise<FactCreateResponseReference> => {
          const result =
            await createFactsService(scopedContext).create(createInput);
          if (!result.resource) {
            return {
              factId: null,
              outcome: encodeFactCreateOutcome(result),
            };
          }
          return { factId: result.resource.id };
        },
      );
      const reference = executed.responseReference;
      if (typeof reference.outcome === "string") {
        return decodeFactCreateOutcome(reference.outcome);
      }
      if (
        typeof reference.factId !== "string" ||
        !UUID.test(reference.factId)
      ) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The stored fact mutation result is invalid.",
        );
      }
      const fact = await repository.getFact({
        id: reference.factId,
        workspaceId: context.workspaceId,
      });
      if (!fact || !(await visibleFact(fact))) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      }
      return { resource: fact, issues: [], code: null };
    },
    async revise(input: {
      id: string;
      expectedVersion: number;
      value?: FactValueInput | null;
      state?: string | null;
      confidence?: number | null;
      reviewState?: string | null;
      sensitivity?: string | null;
      changeReason?: string | null;
    }): Promise<FactOutcome> {
      const current = await repository.getFact({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current || !(await visibleFact(current)))
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const requestedVersionIssues = versionIssues(input.expectedVersion);
      if (requestedVersionIssues.length)
        return invalid<FactRow>(requestedVersionIssues);
      return writeTransaction(context, async (transaction) => {
        const scoped = createFactsRepository(
          transaction as unknown as typeof context.database,
        );
        const locked = await scoped.getFactForUpdate({
          workspaceId: context.workspaceId,
          id: input.id,
        });
        if (!locked)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        if (
          !(await canAccessResource(
            transaction as unknown as typeof context.database,
            context,
            {
              id: locked.id,
              resourceKind: "fact",
              sensitivity: locked.sensitivity,
            },
          ))
        )
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        if (locked.version !== input.expectedVersion)
          return conflict<FactRow>(locked.version);
        const definition = await scoped.getDefinitionForUpdate({
          workspaceId: context.workspaceId,
          id: locked.factDefinitionId,
        });
        if (!definition || definition.state !== "active")
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The fact definition is not usable.",
          );
        const issues: ValidationIssue[] = [];
        const patch: Record<string, unknown> = {
          updatedAt: new Date(),
          updatedBy: context.actor.principalId,
        };
        const changed: string[] = [];
        if (input.value != null) {
          const value = validateFactValue(
            definition.allowedValueType,
            input.value,
          );
          issues.push(...value.issues);
          if (value.issues.length === 0) {
            const columns = value.value!;
            for (const [kind, id] of [
              ["person", columns.referencedPersonId],
              ["place", columns.placeId],
              ["file", columns.fileId],
            ] as const) {
              if (!id) continue;
              const reference = await scoped.getResourceReference({
                workspaceId: context.workspaceId,
                kind,
                id,
              });
              if (
                !reference ||
                !(await canAccessResource(
                  transaction as unknown as typeof context.database,
                  context,
                  {
                    id: reference.id,
                    resourceKind: kind,
                    sensitivity: reference.sensitivity,
                  },
                ))
              )
                issues.push({
                  path: ["value"],
                  code: "NOT_FOUND",
                  message: "A referenced value is unavailable.",
                });
            }
            if (
              definition.validationSchema != null &&
              definition.allowedValueType === "json"
            ) {
              const schemaValidation = validateJsonSchema(
                `${context.workspaceId}:${definition.id}:${definition.version}`,
                definition.validationSchema,
                columns.valueJson,
              );
              if (
                schemaValidation.issues.some(
                  (item) => item.code === "INVALID_STORED_SCHEMA",
                )
              )
                throw createGraphQLError(
                  "PRECONDITION_FAILED",
                  "The fact definition is not usable.",
                );
              issues.push(...schemaValidation.issues);
            }
            if (issues.length === 0) Object.assign(patch, columns);
          }
          changed.push("value");
        }
        if (input.confidence !== undefined) {
          const confidence = validateUnitDecimal(input.confidence, {
            min: 0,
            max: 1,
            path: ["confidence"],
          });
          issues.push(...confidence.issues);
          if (confidence.issues.length === 0)
            patch.confidence = confidence.value;
          changed.push("confidence");
        }
        if (input.state !== undefined) {
          const state = input.state?.toLowerCase();
          if (
            !state ||
            ![
              "asserted",
              "corroborated",
              "disputed",
              "disproven",
              "superseded",
              "unknown",
            ].includes(state)
          )
            issues.push({
              path: ["state"],
              code: "INVALID_ENUM",
              message: "Invalid fact state.",
            });
          else patch.state = state;
          changed.push("state");
        }
        if (input.reviewState !== undefined) {
          const reviewState = input.reviewState?.toLowerCase();
          if (
            !reviewState ||
            ![
              "unreviewed",
              "in_review",
              "accepted",
              "rejected",
              "needs_attention",
            ].includes(reviewState)
          )
            issues.push({
              path: ["reviewState"],
              code: "INVALID_ENUM",
              message: "Invalid review state.",
            });
          else patch.reviewState = reviewState;
          changed.push("reviewState");
        }
        if (input.sensitivity !== undefined) {
          const sensitivity = input.sensitivity?.toLowerCase();
          if (
            !sensitivity ||
            !["public", "internal", "confidential", "restricted"].includes(
              sensitivity,
            )
          )
            issues.push({
              path: ["sensitivity"],
              code: "INVALID_ENUM",
              message: "Invalid sensitivity.",
            });
          else patch.sensitivity = sensitivity;
          changed.push("sensitivity");
        }
        const reason =
          input.changeReason == null
            ? { value: null, issues: [] as ValidationIssue[] }
            : normalizeHumanText(input.changeReason, {
                path: ["changeReason"],
                max: 4_000,
                allowLineBreaks: true,
              });
        issues.push(...reason.issues);
        if (issues.length > 0) return invalid<FactRow>(issues);
        const updated = await scoped.updateFactIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return conflict<FactRow>(locked.version);
        await scoped.createRevision({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            factId: updated.id,
            revision: updated.version,
            beforeSnapshot: factSnapshot(locked),
            afterSnapshot: factSnapshot(updated),
            changeReason: reason.value,
            createdBy: context.actor.principalId,
          },
        });
        await audit.write(transaction as unknown as typeof context.database, {
          action: "fact.revise",
          resourceKind: "fact",
          resourceId: updated.id,
          sensitivity: updated.sensitivity,
          changedFields: changed,
          metadata: {
            state: updated.state,
            sensitivity: updated.sensitivity,
            reviewState: updated.reviewState,
            version: updated.version,
          },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "fact",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return { resource: updated, issues: [], code: null };
      });
    },
    async reviseIdempotent(
      input: {
        id: string;
        expectedVersion: number;
        value?: FactValueInput | null;
        state?: string | null;
        confidence?: number | null;
        reviewState?: string | null;
        sensitivity?: string | null;
        changeReason?: string | null;
      } & { idempotencyKey: string },
    ): Promise<FactOutcome> {
      if (!runtime?.idempotencyHmacKey) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Fact revision idempotency is not configured.",
        );
      }
      const reviseInput = {
        id: input.id,
        expectedVersion: input.expectedVersion,
        value: input.value,
        state: input.state,
        confidence: input.confidence,
        reviewState: input.reviewState,
        sensitivity: input.sensitivity,
        changeReason: input.changeReason,
      };
      const idempotency = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + FACT_REVISE_IDEMPOTENCY_TTL_MS),
        idempotencyKey: input.idempotencyKey,
        operation: "fact.revise.graphql",
        requestMaterial: factReviseRequestMaterial(reviseInput),
        secret: runtime.idempotencyHmacKey,
      });
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        idempotency,
        ["fact:update"],
        async (scopedContext): Promise<FactReviseResponseReference> => {
          const result = await createFactsService(
            scopedContext,
            runtime,
          ).revise(reviseInput);
          if (!result.resource) {
            return { outcome: encodeFactReviseOutcome(result) };
          }
          return { factId: result.resource.id };
        },
      );
      const reference = executed.responseReference;
      if (typeof reference.outcome === "string") {
        return decodeFactReviseOutcome(reference.outcome);
      }
      if (
        typeof reference.factId !== "string" ||
        !UUID.test(reference.factId)
      ) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The stored fact revision result is invalid.",
        );
      }
      const fact = await repository.getFact({
        id: reference.factId,
        workspaceId: context.workspaceId,
      });
      if (!fact || !(await visibleFact(fact))) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      }
      return { resource: fact, issues: [], code: null };
    },
    async listRevisions(input: {
      factId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<FactRevisionRow>> {
      const fact = await repository.getFact({
        workspaceId: context.workspaceId,
        id: input.factId,
        visibility: factVisibility,
      });
      if (!fact)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const page = normalizePagination(input);
      const decoded = decode(page.after, "fact-revision-desc");
      const cursor =
        decoded && typeof decoded.r === "number"
          ? { revision: decoded.r, id: decoded.i as string }
          : null;
      const rows = await repository.listRevisions({
        workspaceId: context.workspaceId,
        factId: input.factId,
        limit: page.first + 1,
        cursor,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encode({ o: "fact-revision-desc", r: last.revision, i: last.id })
            : null,
        },
      };
    },
    async selectField(input: {
      personId: string;
      namespace: string;
      fieldKey: string;
      factId: string;
      expectedVersion?: number | null;
      selectionReason?: string | null;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<PersonFieldSelectionRow>> {
      await requireVisiblePerson(input.personId);
      const fact = await repository.getFact({
        workspaceId: context.workspaceId,
        id: input.factId,
      });
      if (!fact || !(await visibleFact(fact)))
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const namespace = normalizeNamespaceKey(input.namespace);
      const fieldKey = normalizeNamespaceKey(input.fieldKey);
      const selectionReason =
        input.selectionReason == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.selectionReason, {
              path: ["selectionReason"],
              max: 4_000,
              allowLineBreaks: true,
            });
      const issues = [
        ...namespace.issues,
        ...fieldKey.issues,
        ...selectionReason.issues,
      ];
      if (
        fact.personId !== input.personId ||
        fact.namespace !== namespace.value ||
        fact.fieldKey !== fieldKey.value
      )
        issues.push({
          path: ["factId"],
          code: "MISMATCH",
          message: "The fact does not match the selected field.",
        });
      if (issues.length > 0) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = runtime?.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Fact selection idempotency is not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + FACT_SELECT_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "fact.select.graphql",
          requestMaterial: {
            expectedVersion: fieldMaterial(input.expectedVersion),
            factId: input.factId,
            fieldKey: fieldKey.value!,
            namespace: namespace.value!,
            personId: input.personId,
            selectionReason: fieldMaterial(
              input.selectionReason === undefined
                ? undefined
                : selectionReason.value,
            ),
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["fact:select", "person:update"],
          async (scopedContext): Promise<SelectionResponseReference> => {
            const outcome = await createFactsService(
              scopedContext,
              runtime,
            ).selectField({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              return { outcome: encodeSelectionOutcome(outcome) };
            }
            return {
              fieldKey: outcome.resource.fieldKey,
              namespace: outcome.resource.namespace,
              personId: outcome.resource.personId,
              selectionId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        if (typeof executed.responseReference.outcome === "string") {
          return decodeSelectionOutcome(executed.responseReference.outcome);
        }
        return {
          resource: await replaySelection(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const existing = await repository.getSelection({
        workspaceId: context.workspaceId,
        personId: input.personId,
        namespace: namespace.value!,
        fieldKey: fieldKey.value!,
      });
      if (
        (!existing && input.expectedVersion != null) ||
        (existing && input.expectedVersion == null)
      )
        return conflict(existing?.version);
      const now = new Date();
      try {
        const row = await writeTransaction(context, async (transaction) => {
          const scoped = createFactsRepository(
            transaction as unknown as typeof context.database,
          );
          const selected = existing
            ? await scoped.updateSelectionIfVersion({
                workspaceId: context.workspaceId,
                id: existing.id,
                expectedVersion: input.expectedVersion!,
                patch: {
                  factId: fact.id,
                  selectedBy: context.actor.principalId,
                  selectionReason: selectionReason.value,
                  updatedAt: now,
                  updatedBy: context.actor.principalId,
                },
              })
            : await scoped.createSelection({
                workspaceId: context.workspaceId,
                value: {
                  id: newId(),
                  personId: input.personId,
                  namespace: namespace.value!,
                  fieldKey: fieldKey.value!,
                  factId: fact.id,
                  selectedBy: context.actor.principalId,
                  selectionReason: selectionReason.value,
                  createdAt: now,
                  createdBy: context.actor.principalId,
                  updatedAt: now,
                  updatedBy: context.actor.principalId,
                },
              });
          if (!selected) return null;
          await audit.write(transaction as unknown as typeof context.database, {
            action: "fact.select",
            resourceKind: "personFieldSelection",
            resourceId: selected.id,
            changedFields: ["factId", "selectionReason"],
            metadata: { version: selected.version },
          });
          return selected;
        });
        return row
          ? { resource: row, issues: [], code: null }
          : conflict(existing?.version);
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          return conflict(existing?.version);
        throw error;
      }
    },
    async createRelationship(input: {
      sourceFactId: string;
      targetFactId: string;
      relationshipType: string;
      explanation?: string | null;
    }): Promise<MutationOutcome<FactRelationshipRow>> {
      const [source, target] = await Promise.all([
        repository.getFact({
          workspaceId: context.workspaceId,
          id: input.sourceFactId,
        }),
        repository.getFact({
          workspaceId: context.workspaceId,
          id: input.targetFactId,
        }),
      ]);
      if (
        !source ||
        !target ||
        !(await visibleFact(source)) ||
        !(await visibleFact(target))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const type = input.relationshipType.toLowerCase();
      if (
        source.id === target.id ||
        ![
          "supports",
          "contradicts",
          "duplicates",
          "supersedes",
          "derived_from",
        ].includes(type)
      )
        return invalid([
          {
            path: ["relationshipType"],
            code: "INVALID_RELATIONSHIP",
            message: "Invalid fact relationship.",
          },
        ]);
      const now = new Date();
      const id = newId();
      const row = await writeTransaction(context, async (transaction) => {
        const scoped = createFactsRepository(
          transaction as unknown as typeof context.database,
        );
        const created = await scoped.createFactRelationship({
          workspaceId: context.workspaceId,
          value: {
            id,
            sourceFactId: source.id,
            targetFactId: target.id,
            relationshipType: type as FactRelationshipRow["relationshipType"],
            explanation: input.explanation?.trim() || null,
            createdAt: now,
            createdBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          },
        });
        await audit.write(transaction as unknown as typeof context.database, {
          action: "fact.relationship.create",
          resourceKind: "factRelationship",
          resourceId: created.id,
          changedFields: ["sourceFactId", "targetFactId", "relationshipType"],
        });
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async createRelationshipIdempotent(
      input: {
        sourceFactId: string;
        targetFactId: string;
        relationshipType: string;
        explanation?: string | null;
      } & { idempotencyKey: string },
    ): Promise<MutationOutcome<FactRelationshipRow>> {
      if (!runtime?.idempotencyHmacKey) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Fact relationship idempotency is not configured.",
        );
      }
      const relationshipInput = {
        sourceFactId: input.sourceFactId,
        targetFactId: input.targetFactId,
        relationshipType: input.relationshipType,
        explanation: input.explanation,
      };
      const idempotency = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(
          Date.now() + FACT_RELATIONSHIP_CREATE_IDEMPOTENCY_TTL_MS,
        ),
        idempotencyKey: input.idempotencyKey,
        operation: "fact.relationship.create.graphql",
        requestMaterial:
          factRelationshipCreateRequestMaterial(relationshipInput),
        secret: runtime.idempotencyHmacKey,
      });
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        idempotency,
        ["fact:update"],
        async (scopedContext): Promise<FactRelationshipResponseReference> => {
          const result = await createFactsService(
            scopedContext,
            runtime,
          ).createRelationship(relationshipInput);
          if (!result.resource) {
            return {
              outcome: JSON.stringify({
                code: result.code,
                currentVersion: result.currentVersion ?? null,
                issues: result.issues,
              }),
            };
          }
          return { relationshipId: result.resource.id };
        },
      );
      const reference = executed.responseReference;
      if (typeof reference.outcome === "string") {
        try {
          const parsed = JSON.parse(reference.outcome) as {
            code?: unknown;
            currentVersion?: unknown;
            issues?: unknown;
          };
          if (
            !parsed ||
            !Array.isArray(parsed.issues) ||
            (parsed.code !== null && typeof parsed.code !== "string") ||
            (parsed.currentVersion !== null &&
              parsed.currentVersion !== undefined &&
              !Number.isInteger(parsed.currentVersion))
          )
            throw new Error("invalid outcome");
          return {
            resource: null,
            issues: parsed.issues as ValidationIssue[],
            code: parsed.code as MutationOutcome<FactRelationshipRow>["code"],
            ...(parsed.currentVersion == null
              ? {}
              : { currentVersion: parsed.currentVersion as number }),
          };
        } catch {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The stored fact relationship result is invalid.",
          );
        }
      }
      return {
        resource: await replayFactRelationship(reference),
        issues: [],
        code: null,
      };
    },
    async archiveRelationship(input: {
      id: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<FactRelationshipRow>> {
      const current = await repository.getFactRelationship({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const [source, target] = await Promise.all([
        repository.getFact({
          workspaceId: context.workspaceId,
          id: current.sourceFactId,
        }),
        repository.getFact({
          workspaceId: context.workspaceId,
          id: current.targetFactId,
        }),
      ]);
      if (
        !source ||
        !target ||
        !(await visibleFact(source)) ||
        !(await visibleFact(target))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const issues = versionIssues(input.expectedVersion);
      if (issues.length) return invalid(issues);
      const row = await writeTransaction(context, async (transaction) => {
        const scoped = createFactsRepository(
          transaction as unknown as typeof context.database,
        );
        const archived = await scoped.archiveFactRelationship({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actorId: context.actor.principalId,
        });
        if (!archived) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "fact.relationship.archive",
          resourceKind: "factRelationship",
          resourceId: archived.id,
          changedFields: ["deletedAt"],
          metadata: { version: archived.version },
        });
        return archived;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async archiveRelationshipIdempotent(
      input: { id: string; expectedVersion: number } & {
        idempotencyKey: string;
      },
    ): Promise<MutationOutcome<FactRelationshipRow>> {
      if (!runtime?.idempotencyHmacKey) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Fact relationship idempotency is not configured.",
        );
      }
      const archiveInput = {
        id: input.id,
        expectedVersion: input.expectedVersion,
      };
      const idempotency = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(
          Date.now() + FACT_RELATIONSHIP_ARCHIVE_IDEMPOTENCY_TTL_MS,
        ),
        idempotencyKey: input.idempotencyKey,
        operation: "fact.relationship.archive.graphql",
        requestMaterial: factRelationshipArchiveRequestMaterial(archiveInput),
        secret: runtime.idempotencyHmacKey,
      });
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        idempotency,
        ["fact:update"],
        async (scopedContext): Promise<FactRelationshipResponseReference> => {
          const result = await createFactsService(
            scopedContext,
            runtime,
          ).archiveRelationship(archiveInput);
          if (!result.resource) {
            return {
              outcome: JSON.stringify({
                code: result.code,
                currentVersion: result.currentVersion ?? null,
                issues: result.issues,
              }),
            };
          }
          return { relationshipId: result.resource.id };
        },
      );
      const reference = executed.responseReference;
      if (typeof reference.outcome === "string") {
        try {
          const parsed = JSON.parse(reference.outcome) as {
            code?: unknown;
            currentVersion?: unknown;
            issues?: unknown;
          };
          if (
            !parsed ||
            !Array.isArray(parsed.issues) ||
            (parsed.code !== null && typeof parsed.code !== "string") ||
            (parsed.currentVersion !== null &&
              parsed.currentVersion !== undefined &&
              !Number.isInteger(parsed.currentVersion))
          )
            throw new Error("invalid outcome");
          return {
            resource: null,
            issues: parsed.issues as ValidationIssue[],
            code: parsed.code as MutationOutcome<FactRelationshipRow>["code"],
            ...(parsed.currentVersion == null
              ? {}
              : { currentVersion: parsed.currentVersion as number }),
          };
        } catch {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The stored fact relationship result is invalid.",
          );
        }
      }
      return {
        resource: await replayFactRelationship(reference),
        issues: [],
        code: null,
      };
    },
    async listRelationships(input: {
      factId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<FactRelationshipRow>> {
      const fact = await repository.getFact({
        workspaceId: context.workspaceId,
        id: input.factId,
      });
      if (!fact || !(await visibleFact(fact)))
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const page = normalizePagination(input);
      const decoded = decode(page.after, "fact-relationship-created-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const rows = await repository.listFactRelationships({
        workspaceId: context.workspaceId,
        factId: input.factId,
        limit: page.first + 1,
        cursor,
        sourceVisibility: sourceFactRelationshipVisibility,
        targetVisibility: targetFactRelationshipVisibility,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encode({
                o: "fact-relationship-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async listRelationshipsForFacts(
      keys: readonly {
        factId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<FactRelationshipRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decode(key.after, "fact-relationship-created-desc");
        const cursor =
          decoded && typeof decoded.t === "string"
            ? { createdAt: new Date(decoded.t), id: decoded.i as string }
            : null;
        if (cursor && Number.isNaN(cursor.createdAt.getTime()))
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return { pageKey, factId: key.factId, cursor };
      });
      const factIds = [...new Set(keys.map((key) => key.factId))];
      const visibleFacts = await repository.getFactsByIds({
        workspaceId: context.workspaceId,
        ids: factIds,
        visibility: factVisibility,
      });
      const visibleIds = new Set(visibleFacts.map((row) => row.id));
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listFactRelationshipsForFacts({
        workspaceId: context.workspaceId,
        pages: pages.filter((page) => visibleIds.has(page.factId)),
        limitPerFact: limit,
        sourceVisibility: sourceFactRelationshipVisibility,
        targetVisibility: targetFactRelationshipVisibility,
      });
      const grouped = new Map<number, FactRelationshipRow[]>();
      for (const row of rows)
        grouped.set(row.pageKey, [...(grouped.get(row.pageKey) ?? []), row]);
      return keys.map((key, pageKey) => {
        const values = grouped.get(pageKey) ?? [];
        const nodes = values.slice(0, key.first);
        const last = nodes.at(-1);
        return {
          nodes,
          pageInfo: {
            hasNextPage: values.length > key.first,
            endCursor: last
              ? encode({
                  o: "fact-relationship-created-desc",
                  t: last.createdAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
  };
}

export type FactsService = ReturnType<typeof createFactsService>;
