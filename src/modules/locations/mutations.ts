import { createHmac } from "node:crypto";

import { and, count, eq, isNull, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  evidenceItems,
  personAddresses,
  personContactPoints,
} from "@/db/schema/evidence";
import { addresses, contactPoints, places } from "@/db/schema/locations";
import { people } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  runResearchTransaction,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
import type { ValidationIssue } from "@/modules/facts/validation";
import type { MutationOutcome } from "@/modules/people/service";

import {
  prepareProtectedContact,
  normalizeAddress,
  type ContactKind,
  type PreparedContact,
} from "./domain";
import { createLocationsRepository } from "./repository";
import {
  addressView,
  contactView,
  type AddressView,
  type ContactView,
  type LocationRuntime,
} from "./service";
import type { PlaceRow } from "./repository";

type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export type CreateContactInput = Readonly<{
  confidence?: number | null;
  evidenceId?: string | null;
  idempotencyKey: string;
  isPrimary?: boolean | null;
  kind: ContactKind;
  label?: string | null;
  personId: string;
  sensitivity?: string | null;
  usageKind: string;
  validFrom?: string | null;
  validUntil?: string | null;
  value: string;
  verificationState?: string | null;
}>;

export type UpdateContactInput = Readonly<{
  associationId: string;
  confidence?: number | null;
  evidenceId?: string | null;
  expectedContactVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  isPrimary?: boolean | null;
  label?: string | null;
  sensitivity?: string | null;
  usageKind?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  value?: string | null;
  verificationState?: string | null;
}>;

export type ArchiveContactInput = Readonly<{
  associationId: string;
  expectedContactVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
}>;

export type CreatePlaceInput = Readonly<{
  countryCode?: string | null;
  idempotencyKey: string;
  kind: string;
  latitude?: number | null;
  locality?: string | null;
  longitude?: number | null;
  name: string;
  parentPlaceId?: string | null;
  region?: string | null;
  sensitivity?: string | null;
}>;

export type UpdatePlaceInput = Readonly<{
  countryCode?: string | null;
  expectedVersion: number;
  id: string;
  idempotencyKey: string;
  kind?: string | null;
  latitude?: number | null;
  locality?: string | null;
  longitude?: number | null;
  name?: string | null;
  parentPlaceId?: string | null;
  region?: string | null;
  sensitivity?: string | null;
}>;

export type ArchivePlaceInput = Readonly<{
  expectedVersion: number;
  id: string;
  idempotencyKey: string;
}>;

export type CreateAddressInput = Readonly<{
  addressKind: string;
  confidence?: number | null;
  countryCode?: string | null;
  evidenceId?: string | null;
  idempotencyKey: string;
  isPrimary?: boolean | null;
  latitude?: number | null;
  line1?: string | null;
  line2?: string | null;
  locality?: string | null;
  longitude?: number | null;
  personId: string;
  placeId?: string | null;
  postalCode?: string | null;
  region?: string | null;
  sensitivity?: string | null;
  state?: string | null;
  temporalPrecision?: string | null;
  unstructuredText?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}>;

export type UpdateAddressInput = Readonly<{
  addressKind?: string | null;
  associationId: string;
  confidence?: number | null;
  countryCode?: string | null;
  evidenceId?: string | null;
  expectedAddressVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  isPrimary?: boolean | null;
  latitude?: number | null;
  line1?: string | null;
  line2?: string | null;
  locality?: string | null;
  longitude?: number | null;
  placeId?: string | null;
  postalCode?: string | null;
  region?: string | null;
  sensitivity?: string | null;
  state?: string | null;
  temporalPrecision?: string | null;
  unstructuredText?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}>;

export type ArchiveAddressInput = Readonly<{
  associationId: string;
  expectedAddressVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
}>;

type MutationReference = ResearchResponseReference &
  Readonly<{
    associationId: string | null;
    code: "ARCHIVED" | "CONFLICT" | "NOT_VISIBLE" | null;
    currentVersion: number | null;
    resourceId: string | null;
  }>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]+$/u;
const ALLOWED_CODES = new Set([null, "ARCHIVED", "CONFLICT", "NOT_VISIBLE"]);
const sensitivities = new Set<Sensitivity>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path: [path], code, message };
}

function invalid<T>(issues: ValidationIssue[]): MutationOutcome<T> {
  return { resource: null, issues, code: "VALIDATION_FAILED" };
}

function notFound(): never {
  throw createGraphQLError(
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}

function normalizeText(
  value: string | null | undefined,
  path: string,
  maxBytes: number,
  required = false,
): { value: string | null; issues: ValidationIssue[] } {
  if (value == null) {
    return required
      ? {
          value: null,
          issues: [issue(path, "REQUIRED", "A value is required.")],
        }
      : { value: null, issues: [] };
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    !normalized ||
    !SAFE_TEXT.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > maxBytes
  ) {
    return {
      value: null,
      issues: [issue(path, "INVALID_VALUE", "The value is invalid.")],
    };
  }
  return { value: normalized, issues: [] };
}

function parseDate(
  value: string | null | undefined,
  path: string,
): { value: Date | null; issues: ValidationIssue[] } {
  if (value == null) return { value: null, issues: [] };
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? {
        value: null,
        issues: [issue(path, "INVALID_DATE", "The date is invalid.")],
      }
    : { value: parsed, issues: [] };
}

function temporalIssues(
  validFrom: Date | null,
  validUntil: Date | null,
): ValidationIssue[] {
  return validFrom && validUntil && validUntil < validFrom
    ? [issue("validUntil", "INVALID_RANGE", "The date range is invalid.")]
    : [];
}

function isEffectiveCurrent(
  validFrom: Date | null,
  validUntil: Date | null,
  now: Date,
): boolean {
  return validUntil === null && (validFrom === null || validFrom <= now);
}

function sensitivityValue(value: string | null | undefined): {
  value: Sensitivity;
  issues: ValidationIssue[];
} {
  const normalized = (value ?? "internal").toLowerCase();
  return sensitivities.has(normalized as Sensitivity)
    ? { value: normalized as Sensitivity, issues: [] }
    : {
        value: "internal",
        issues: [
          issue("sensitivity", "INVALID_ENUM", "The sensitivity is invalid."),
        ],
      };
}

function confidenceValue(value: number | null | undefined): {
  value: number;
  issues: ValidationIssue[];
} {
  const normalized = value ?? 1;
  return Number.isFinite(normalized) && normalized >= 0 && normalized <= 1
    ? { value: normalized, issues: [] }
    : {
        value: 1,
        issues: [
          issue(
            "confidence",
            "INVALID_VALUE",
            "Confidence must be between 0 and 1.",
          ),
        ],
      };
}

function countryCodeValue(value: string | null | undefined): {
  value: string | null;
  issues: ValidationIssue[];
} {
  if (value == null) return { value: null, issues: [] };
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z]{2}$/u.test(normalized)
    ? { value: normalized, issues: [] }
    : {
        value: null,
        issues: [
          issue("countryCode", "INVALID_VALUE", "The country code is invalid."),
        ],
      };
}

function coordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if ((latitude == null) !== (longitude == null)) {
    issues.push(
      issue(
        "latitude",
        "INVALID_COORDINATES",
        "Both coordinates are required.",
      ),
    );
  }
  if (
    latitude != null &&
    (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
  ) {
    issues.push(
      issue("latitude", "INVALID_COORDINATES", "The latitude is invalid."),
    );
  }
  if (
    longitude != null &&
    (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
  ) {
    issues.push(
      issue("longitude", "INVALID_COORDINATES", "The longitude is invalid."),
    );
  }
  return issues;
}

const TEMPORAL_PRECISIONS = new Set([
  "unknown",
  "instant",
  "second",
  "minute",
  "hour",
  "day",
  "month",
  "year",
  "range",
]);
const ADDRESS_STATES = new Set([
  "asserted",
  "disputed",
  "disproven",
  "superseded",
]);

function versions(...values: readonly { path: string; value: number }[]) {
  return values.flatMap(({ path, value }) =>
    Number.isInteger(value) && value > 0
      ? []
      : [issue(path, "INVALID_VERSION", "A positive version is required.")],
  );
}

function keyIssues(key: string): ValidationIssue[] {
  return IDEMPOTENCY_KEY.test(key)
    ? []
    : [
        issue(
          "idempotencyKey",
          "INVALID_VALUE",
          "The idempotency key is invalid.",
        ),
      ];
}

function requestDigest(secret: string, material: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("humans:location-request-material:v1\0", "utf8")
    .update(material, "utf8")
    .digest("hex");
}

function validateReference(value: unknown): MutationReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored mutation result is invalid.",
    );
  }
  const row = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(row).length !== 4 ||
    !(
      row.associationId === null ||
      (typeof row.associationId === "string" && UUID.test(row.associationId))
    ) ||
    !(
      row.resourceId === null ||
      (typeof row.resourceId === "string" && UUID.test(row.resourceId))
    ) ||
    !(
      row.currentVersion === null ||
      (typeof row.currentVersion === "number" &&
        Number.isInteger(row.currentVersion) &&
        row.currentVersion > 0)
    ) ||
    !ALLOWED_CODES.has(row.code as null | string)
  ) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored mutation result is invalid.",
    );
  }
  return row as MutationReference;
}

async function visibleEvidence(
  context: ResearchServiceContext,
  evidenceId: string | null,
): Promise<boolean> {
  if (!evidenceId) return true;
  const [evidence] = await context.database
    .select({ id: evidenceItems.id, sensitivity: evidenceItems.sensitivity })
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, context.workspaceId),
        eq(evidenceItems.id, evidenceId),
        isNull(evidenceItems.deletedAt),
      ),
    )
    .limit(1)
    .for("share");
  return Boolean(
    evidence &&
    (await canAccessResource(context.database, context, {
      id: evidence.id,
      lockGrants: true,
      resourceKind: "evidence",
      sensitivity: evidence.sensitivity,
    })),
  );
}

export function createLocationMutations(
  context: ResearchServiceContext,
  runtime: LocationRuntime,
) {
  const permissionSet = {
    createContact: ["contactPoint:create", "contactPoint:read", "person:read"],
    updateContact: ["contactPoint:update", "contactPoint:read", "person:read"],
    archiveContact: ["contactPoint:delete", "contactPoint:read", "person:read"],
    createPlace: ["place:create", "place:read"],
    updatePlace: ["place:update", "place:read"],
    archivePlace: ["place:delete", "place:read"],
    createAddress: ["address:create", "address:read", "person:read"],
    updateAddress: ["address:update", "address:read", "person:read"],
    archiveAddress: ["address:delete", "address:read", "person:read"],
  } as const;

  function claim(
    operation: string,
    idempotencyKey: string,
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>,
  ) {
    return derivePrincipalResearchIdempotency(context, {
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      idempotencyKey,
      operation,
      requestMaterial,
      secret: runtime.blindIndexKey,
    });
  }

  async function contactOutcome(
    referenceValue: unknown,
    requiredPermissions: readonly string[],
  ): Promise<MutationOutcome<ContactView>> {
    const reference = validateReference(referenceValue);
    if (reference.code) {
      return {
        resource: null,
        issues: [],
        code: reference.code,
        currentVersion: reference.currentVersion,
      };
    }
    if (!reference.associationId || !reference.resourceId) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The stored mutation result is invalid.",
      );
    }
    return runResearchTransaction(
      context,
      { requiredPermissions },
      async (scopedContext) => {
        const repository = createLocationsRepository(scopedContext.database);
        const personVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        });
        const contactVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "contactPoint",
          id: contactPoints.id,
          sensitivity: contactPoints.sensitivity,
        });
        const row = await repository.getPersonContactRow({
          associationId: reference.associationId!,
          contactVisibility,
          personVisibility,
          workspaceId: scopedContext.workspaceId,
        });
        if (!row || row.contact.id !== reference.resourceId) {
          return { resource: null, issues: [], code: "NOT_FOUND" };
        }
        return {
          resource: contactView(row, runtime.encryptionKey),
          issues: [],
          code: null,
        };
      },
    );
  }

  async function placeOutcome(
    referenceValue: unknown,
    requiredPermissions: readonly string[],
  ): Promise<MutationOutcome<PlaceRow>> {
    const reference = validateReference(referenceValue);
    if (reference.code) {
      return {
        resource: null,
        issues: [],
        code: reference.code,
        currentVersion: reference.currentVersion,
      };
    }
    if (reference.associationId !== null || !reference.resourceId) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The stored mutation result is invalid.",
      );
    }
    return runResearchTransaction(
      context,
      { requiredPermissions },
      async (scopedContext) => {
        const repository = createLocationsRepository(scopedContext.database);
        const visibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "place",
          id: places.id,
          sensitivity: places.sensitivity,
        });
        const place = await repository.getPlace({
          id: reference.resourceId!,
          visibility,
          workspaceId: scopedContext.workspaceId,
        });
        return place
          ? { resource: place, issues: [], code: null }
          : { resource: null, issues: [], code: "NOT_FOUND" };
      },
    );
  }

  async function addressOutcome(
    referenceValue: unknown,
    requiredPermissions: readonly string[],
  ): Promise<MutationOutcome<AddressView>> {
    const reference = validateReference(referenceValue);
    if (reference.code) {
      return {
        resource: null,
        issues: [],
        code: reference.code,
        currentVersion: reference.currentVersion,
      };
    }
    if (!reference.associationId || !reference.resourceId) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The stored mutation result is invalid.",
      );
    }
    return runResearchTransaction(
      context,
      { requiredPermissions },
      async (scopedContext) => {
        const repository = createLocationsRepository(scopedContext.database);
        const row = await repository.getPersonAddressRow({
          addressVisibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "address",
            id: addresses.id,
            sensitivity: addresses.sensitivity,
          }),
          associationId: reference.associationId!,
          personVisibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "person",
            id: people.id,
            sensitivity: people.sensitivity,
          }),
          placeVisibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "place",
            id: places.id,
            sensitivity: places.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
        });
        if (!row || row.address.id !== reference.resourceId) {
          return { resource: null, issues: [], code: "NOT_FOUND" };
        }
        return { resource: addressView(row), issues: [], code: null };
      },
    );
  }

  async function parentWouldCycle(
    scopedContext: ResearchServiceContext,
    id: string,
    parentPlaceId: string | null,
  ): Promise<boolean> {
    let current = parentPlaceId;
    const seen = new Set<string>();
    while (current) {
      if (current === id || seen.has(current)) return true;
      seen.add(current);
      if (seen.size > 1_024) return true;
      const [row] = await scopedContext.database
        .select({ parentPlaceId: places.parentPlaceId })
        .from(places)
        .where(
          and(
            eq(places.workspaceId, scopedContext.workspaceId),
            eq(places.id, current),
            isNull(places.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return false;
      current = row.parentPlaceId;
    }
    return false;
  }

  async function createContact(
    input: CreateContactInput,
  ): Promise<MutationOutcome<ContactView>> {
    const label = normalizeText(input.label, "label", 120);
    const usage = normalizeText(input.usageKind, "usageKind", 64, true);
    const sensitivity = sensitivityValue(input.sensitivity);
    const confidence = confidenceValue(input.confidence);
    const validFrom = parseDate(input.validFrom, "validFrom");
    const validUntil = parseDate(input.validUntil, "validUntil");
    const verification = (
      input.verificationState ?? "unverified"
    ).toLowerCase();
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...label.issues,
      ...usage.issues,
      ...sensitivity.issues,
      ...confidence.issues,
      ...validFrom.issues,
      ...validUntil.issues,
      ...temporalIssues(validFrom.value, validUntil.value),
    ];
    if (!UUID.test(input.personId)) {
      issues.push(issue("personId", "INVALID_ID", "The person is invalid."));
    }
    if (input.evidenceId && !UUID.test(input.evidenceId)) {
      issues.push(
        issue("evidenceId", "INVALID_ID", "The evidence item is invalid."),
      );
    }
    if (!(["phone", "email", "other"] as const).includes(input.kind)) {
      issues.push(
        issue("kind", "INVALID_ENUM", "The contact kind is invalid."),
      );
    }
    if (!["unverified", "verified", "invalid"].includes(verification)) {
      issues.push(
        issue(
          "verificationState",
          "INVALID_ENUM",
          "The verification state is invalid.",
        ),
      );
    }
    const now = new Date();
    if (
      input.isPrimary &&
      !isEffectiveCurrent(validFrom.value, validUntil.value, now)
    ) {
      issues.push(
        issue(
          "isPrimary",
          "PRIMARY_REQUIRES_CURRENT",
          "Only a currently effective association can be primary.",
        ),
      );
    }
    let prepared: PreparedContact | null = null;
    try {
      prepared = prepareProtectedContact({
        blindIndexKey: runtime.blindIndexKey,
        encryptionKey: runtime.encryptionKey,
        kind: input.kind,
        value: input.value,
        workspaceId: context.workspaceId,
      });
    } catch {
      issues.push(
        issue("value", "INVALID_CONTACT", "The contact value is invalid."),
      );
    }
    if (issues.length || !prepared) return invalid(issues);
    const permissions = [
      ...permissionSet.createContact,
      ...(input.evidenceId ? ["evidence:read"] : []),
    ];
    const derived = claim("location.contact.create", input.idempotencyKey, {
      confidence: confidence.value,
      evidenceId: input.evidenceId ?? null,
      isPrimary: input.isPrimary ?? false,
      kind: input.kind,
      label: label.value,
      personId: input.personId,
      protectedValue: prepared.requestFingerprint,
      sensitivity: sensitivity.value,
      usageKind: usage.value!,
      validFrom: validFrom.value?.toISOString() ?? null,
      validUntil: validUntil.value?.toISOString() ?? null,
      verificationState: verification,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const personVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        });
        const person = await repository.lockVisiblePerson({
          id: input.personId,
          visibility: personVisibility,
          workspaceId: scopedContext.workspaceId,
        });
        if (!person) return notFound();
        if (
          input.evidenceId &&
          !(await visibleEvidence(scopedContext, input.evidenceId))
        ) {
          return notFound();
        }
        const transactionNow = new Date();
        const current = isEffectiveCurrent(
          validFrom.value,
          validUntil.value,
          transactionNow,
        );
        if (input.isPrimary && !current) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Only a currently effective association can be primary.",
          );
        }
        if (input.isPrimary && current) {
          await repository.clearContactPrimary({
            actorId: scopedContext.actor.principalId,
            now: transactionNow,
            personId: input.personId,
            usageKind: usage.value!,
            workspaceId: scopedContext.workspaceId,
          });
        }
        const contactId = newId();
        const associationId = newId();
        const [contact] = await scopedContext.database
          .insert(contactPoints)
          .values({
            id: contactId,
            workspaceId: scopedContext.workspaceId,
            kind: input.kind,
            encryptedDisplayValue: prepared!.encryptedValue,
            blindIndex: prepared!.blindIndex,
            blindIndexVersion: prepared!.blindIndexVersion,
            label: label.value,
            verificationState: verification,
            sensitivity: sensitivity.value,
            metadata: {},
            createdBy: scopedContext.actor.principalId,
            updatedBy: scopedContext.actor.principalId,
          })
          .returning();
        const [association] = await scopedContext.database
          .insert(personContactPoints)
          .values({
            id: associationId,
            workspaceId: scopedContext.workspaceId,
            personId: input.personId,
            contactPointId: contactId,
            usageKind: usage.value!,
            isPrimary: Boolean(input.isPrimary && current),
            validFrom: validFrom.value,
            validUntil: validUntil.value,
            confidence: String(confidence.value),
            evidenceId: input.evidenceId,
            createdBy: scopedContext.actor.principalId,
            updatedBy: scopedContext.actor.principalId,
          })
          .returning();
        if (!contact || !association) throw new Error("Contact insert failed");
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "contactPoint.create",
          resourceKind: "contactPoint",
          resourceId: contact.id,
          sensitivity: contact.sensitivity,
          changedFields: [
            "kind",
            "label",
            "verificationState",
            "sensitivity",
            "association",
          ],
          metadata: {
            evidenceLinked: Boolean(association.evidenceId),
            isPrimary: association.isPrimary,
            usageKind: association.usageKind,
            version: contact.version,
          },
        });
        await applySearchIndexMaintenance(
          scopedContext,
          scopedContext.database,
          [
            {
              action: "upsert",
              sourceId: person.id,
              sourceKind: "person",
              sourceVersion: person.version,
              workspaceId: scopedContext.workspaceId,
            },
          ],
        );
        const visible = await canAccessResource(
          scopedContext.database,
          scopedContext,
          {
            id: contact.id,
            lockGrants: true,
            resourceKind: "contactPoint",
            sensitivity: contact.sensitivity,
          },
        );
        return {
          associationId: association.id,
          resourceId: contact.id,
          code: visible ? null : "NOT_VISIBLE",
          currentVersion: null,
        };
      },
    );
    return contactOutcome(executed.responseReference, permissions);
  }

  async function updateContact(
    input: UpdateContactInput,
  ): Promise<MutationOutcome<ContactView>> {
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...versions(
        { path: "expectedVersion", value: input.expectedVersion },
        {
          path: "expectedContactVersion",
          value: input.expectedContactVersion,
        },
      ),
    ];
    const label =
      input.label === undefined
        ? undefined
        : normalizeText(input.label, "label", 120);
    const usage =
      input.usageKind === undefined
        ? undefined
        : normalizeText(input.usageKind, "usageKind", 64, true);
    const sensitivity =
      input.sensitivity === undefined
        ? undefined
        : sensitivityValue(input.sensitivity);
    const confidence =
      input.confidence === undefined
        ? undefined
        : confidenceValue(input.confidence);
    const validFrom =
      input.validFrom === undefined
        ? undefined
        : parseDate(input.validFrom, "validFrom");
    const validUntil =
      input.validUntil === undefined
        ? undefined
        : parseDate(input.validUntil, "validUntil");
    if (label) issues.push(...label.issues);
    if (usage) issues.push(...usage.issues);
    if (sensitivity) issues.push(...sensitivity.issues);
    if (confidence) issues.push(...confidence.issues);
    if (validFrom) issues.push(...validFrom.issues);
    if (validUntil) issues.push(...validUntil.issues);
    if (input.evidenceId && !UUID.test(input.evidenceId)) {
      issues.push(
        issue("evidenceId", "INVALID_ID", "The evidence item is invalid."),
      );
    }
    const verification = input.verificationState?.toLowerCase();
    if (
      input.verificationState !== undefined &&
      !["unverified", "verified", "invalid"].includes(verification ?? "")
    ) {
      issues.push(
        issue(
          "verificationState",
          "INVALID_ENUM",
          "The verification state is invalid.",
        ),
      );
    }
    if (issues.length) return invalid(issues);
    const permissions = [
      ...permissionSet.updateContact,
      ...(input.evidenceId ? ["evidence:read"] : []),
    ];
    const protectedValue =
      input.value == null
        ? null
        : requestDigest(
            runtime.blindIndexKey,
            input.value.normalize("NFKC").trim(),
          );
    const derived = claim("location.contact.update", input.idempotencyKey, {
      associationId: input.associationId,
      confidence: input.confidence ?? null,
      evidenceId:
        input.evidenceId === undefined ? "__unchanged__" : input.evidenceId,
      expectedContactVersion: input.expectedContactVersion,
      expectedVersion: input.expectedVersion,
      isPrimary: input.isPrimary ?? null,
      label:
        input.label === undefined ? "__unchanged__" : (label?.value ?? null),
      protectedValue,
      sensitivity: input.sensitivity ?? null,
      usageKind:
        input.usageKind === undefined
          ? "__unchanged__"
          : (usage?.value ?? null),
      validFrom:
        input.validFrom === undefined
          ? "__unchanged__"
          : (validFrom?.value?.toISOString() ?? null),
      validUntil:
        input.validUntil === undefined
          ? "__unchanged__"
          : (validUntil?.value?.toISOString() ?? null),
      verificationState: verification ?? null,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const preRead = await repository.getPersonContactAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
        });
        if (!preRead) return notFound();
        const personVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        });
        const person = await repository.lockVisiblePerson({
          id: preRead.personId,
          visibility: personVisibility,
          workspaceId: scopedContext.workspaceId,
        });
        const association = await repository.getPersonContactAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (
          !person ||
          !association ||
          association.personId !== preRead.personId
        ) {
          return notFound();
        }
        const contactVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "contactPoint",
          id: contactPoints.id,
          sensitivity: contactPoints.sensitivity,
        });
        const contact = await repository.getContact({
          id: association.contactPointId,
          visibility: contactVisibility,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (!contact) return notFound();
        if (
          association.version !== input.expectedVersion ||
          contact.version !== input.expectedContactVersion
        ) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: Math.max(association.version, contact.version),
          };
        }
        const nextFrom =
          input.validFrom === undefined
            ? association.validFrom
            : validFrom!.value;
        const nextUntil =
          input.validUntil === undefined
            ? association.validUntil
            : validUntil!.value;
        const intervalIssues = temporalIssues(nextFrom, nextUntil);
        if (intervalIssues.length) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The date range is invalid.",
          );
        }
        const now = new Date();
        const current = isEffectiveCurrent(nextFrom, nextUntil, now);
        const desiredPrimary = current
          ? (input.isPrimary ?? association.isPrimary)
          : false;
        if (input.isPrimary && !current) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Only a currently effective association can be primary.",
          );
        }
        if (
          input.evidenceId &&
          !(await visibleEvidence(scopedContext, input.evidenceId))
        ) {
          return notFound();
        }
        let prepared: PreparedContact | null = null;
        if (input.value != null) {
          try {
            prepared = prepareProtectedContact({
              blindIndexKey: runtime.blindIndexKey,
              encryptionKey: runtime.encryptionKey,
              kind: contact.kind as ContactKind,
              value: input.value,
              workspaceId: scopedContext.workspaceId,
            });
          } catch {
            throw createGraphQLError(
              "VALIDATION_FAILED",
              "The contact value is invalid.",
            );
          }
        }
        const nextUsage = usage?.value ?? association.usageKind;
        if (desiredPrimary && current) {
          await repository.clearContactPrimary({
            actorId: scopedContext.actor.principalId,
            exceptId: association.id,
            now,
            personId: association.personId,
            usageKind: nextUsage,
            workspaceId: scopedContext.workspaceId,
          });
        }
        const [updatedContact] = await scopedContext.database
          .update(contactPoints)
          .set({
            ...(prepared
              ? {
                  encryptedDisplayValue: prepared.encryptedValue,
                  blindIndex: prepared.blindIndex,
                  blindIndexVersion: prepared.blindIndexVersion,
                }
              : {}),
            ...(label !== undefined ? { label: label.value } : {}),
            ...(verification !== undefined
              ? { verificationState: verification }
              : {}),
            ...(sensitivity !== undefined
              ? { sensitivity: sensitivity.value }
              : {}),
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${contactPoints.version} + 1`,
          })
          .where(
            and(
              eq(contactPoints.workspaceId, scopedContext.workspaceId),
              eq(contactPoints.id, contact.id),
              eq(contactPoints.version, input.expectedContactVersion),
              isNull(contactPoints.deletedAt),
            ),
          )
          .returning();
        const [updatedAssociation] = await scopedContext.database
          .update(personContactPoints)
          .set({
            ...(usage !== undefined ? { usageKind: usage.value! } : {}),
            isPrimary: desiredPrimary,
            ...(input.validFrom !== undefined ? { validFrom: nextFrom } : {}),
            ...(input.validUntil !== undefined
              ? { validUntil: nextUntil }
              : {}),
            ...(confidence !== undefined
              ? { confidence: String(confidence.value) }
              : {}),
            ...(input.evidenceId !== undefined
              ? { evidenceId: input.evidenceId }
              : {}),
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${personContactPoints.version} + 1`,
          })
          .where(
            and(
              eq(personContactPoints.workspaceId, scopedContext.workspaceId),
              eq(personContactPoints.id, association.id),
              eq(personContactPoints.version, input.expectedVersion),
              isNull(personContactPoints.deletedAt),
            ),
          )
          .returning();
        if (!updatedContact || !updatedAssociation) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: null,
          };
        }
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "contactPoint.update",
          resourceKind: "contactPoint",
          resourceId: updatedContact.id,
          sensitivity: updatedContact.sensitivity,
          changedFields: [
            "protectedValue",
            "label",
            "verificationState",
            "sensitivity",
            "association",
          ],
          metadata: {
            evidenceLinked: Boolean(updatedAssociation.evidenceId),
            isPrimary: updatedAssociation.isPrimary,
            usageKind: updatedAssociation.usageKind,
            version: updatedContact.version,
          },
        });
        await applySearchIndexMaintenance(
          scopedContext,
          scopedContext.database,
          [
            {
              action: "upsert",
              sourceId: person.id,
              sourceKind: "person",
              sourceVersion: person.version,
              workspaceId: scopedContext.workspaceId,
            },
          ],
        );
        const visible = await canAccessResource(
          scopedContext.database,
          scopedContext,
          {
            id: updatedContact.id,
            lockGrants: true,
            resourceKind: "contactPoint",
            sensitivity: updatedContact.sensitivity,
          },
        );
        return {
          associationId: updatedAssociation.id,
          resourceId: updatedContact.id,
          code: visible ? null : "NOT_VISIBLE",
          currentVersion: null,
        };
      },
    );
    return contactOutcome(executed.responseReference, permissions);
  }

  async function archiveContact(
    input: ArchiveContactInput,
  ): Promise<MutationOutcome<ContactView>> {
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...versions(
        { path: "expectedVersion", value: input.expectedVersion },
        {
          path: "expectedContactVersion",
          value: input.expectedContactVersion,
        },
      ),
    ];
    if (issues.length) return invalid(issues);
    const permissions = permissionSet.archiveContact;
    const derived = claim("location.contact.archive", input.idempotencyKey, {
      associationId: input.associationId,
      expectedContactVersion: input.expectedContactVersion,
      expectedVersion: input.expectedVersion,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const preRead = await repository.getPersonContactAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
        });
        if (!preRead) return notFound();
        const personVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        });
        const person = await repository.lockVisiblePerson({
          id: preRead.personId,
          visibility: personVisibility,
          workspaceId: scopedContext.workspaceId,
        });
        const association = await repository.getPersonContactAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (
          !person ||
          !association ||
          association.personId !== preRead.personId
        ) {
          return notFound();
        }
        const contactVisibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "contactPoint",
          id: contactPoints.id,
          sensitivity: contactPoints.sensitivity,
        });
        const contact = await repository.getContact({
          id: association.contactPointId,
          visibility: contactVisibility,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (!contact) return notFound();
        if (
          association.version !== input.expectedVersion ||
          contact.version !== input.expectedContactVersion
        ) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: Math.max(association.version, contact.version),
          };
        }
        const now = new Date();
        const [archivedAssociation] = await scopedContext.database
          .update(personContactPoints)
          .set({
            deletedAt: now,
            deletedBy: scopedContext.actor.principalId,
            isPrimary: false,
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${personContactPoints.version} + 1`,
          })
          .where(
            and(
              eq(personContactPoints.workspaceId, scopedContext.workspaceId),
              eq(personContactPoints.id, association.id),
              eq(personContactPoints.version, input.expectedVersion),
              isNull(personContactPoints.deletedAt),
            ),
          )
          .returning();
        if (!archivedAssociation) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: null,
          };
        }
        const [remaining] = await scopedContext.database
          .select({ total: count() })
          .from(personContactPoints)
          .where(
            and(
              eq(personContactPoints.workspaceId, scopedContext.workspaceId),
              eq(personContactPoints.contactPointId, contact.id),
              isNull(personContactPoints.deletedAt),
            ),
          );
        let archivedVersion = contact.version;
        if ((remaining?.total ?? 0) === 0) {
          const [archived] = await scopedContext.database
            .update(contactPoints)
            .set({
              deletedAt: now,
              deletedBy: scopedContext.actor.principalId,
              updatedAt: now,
              updatedBy: scopedContext.actor.principalId,
              version: sql`${contactPoints.version} + 1`,
            })
            .where(
              and(
                eq(contactPoints.workspaceId, scopedContext.workspaceId),
                eq(contactPoints.id, contact.id),
                eq(contactPoints.version, input.expectedContactVersion),
                isNull(contactPoints.deletedAt),
              ),
            )
            .returning({ version: contactPoints.version });
          if (!archived) {
            return {
              associationId: null,
              resourceId: null,
              code: "CONFLICT",
              currentVersion: null,
            };
          }
          archivedVersion = archived.version;
        }
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "contactPoint.archive",
          resourceKind: "contactPoint",
          resourceId: contact.id,
          sensitivity: contact.sensitivity,
          changedFields: ["association.deletedAt", "deletedAt"],
          metadata: { version: archivedVersion },
        });
        await applySearchIndexMaintenance(
          scopedContext,
          scopedContext.database,
          [
            {
              action: "upsert",
              sourceId: person.id,
              sourceKind: "person",
              sourceVersion: person.version,
              workspaceId: scopedContext.workspaceId,
            },
          ],
        );
        return {
          associationId: archivedAssociation.id,
          resourceId: contact.id,
          code: "ARCHIVED",
          currentVersion: archivedVersion,
        };
      },
    );
    return contactOutcome(executed.responseReference, permissions);
  }

  async function createPlace(
    input: CreatePlaceInput,
  ): Promise<MutationOutcome<PlaceRow>> {
    const name = normalizeText(input.name, "name", 300, true);
    const kind = normalizeText(input.kind, "kind", 64, true);
    const region = normalizeText(input.region, "region", 300);
    const locality = normalizeText(input.locality, "locality", 300);
    const countryCode = countryCodeValue(input.countryCode);
    const sensitivity = sensitivityValue(input.sensitivity);
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...name.issues,
      ...kind.issues,
      ...region.issues,
      ...locality.issues,
      ...countryCode.issues,
      ...sensitivity.issues,
      ...coordinates(input.latitude, input.longitude),
    ];
    if (input.parentPlaceId && !UUID.test(input.parentPlaceId)) {
      issues.push(
        issue("parentPlaceId", "INVALID_ID", "The parent place is invalid."),
      );
    }
    if (issues.length) return invalid(issues);
    const permissions = permissionSet.createPlace;
    const derived = claim("location.place.create", input.idempotencyKey, {
      countryCode: countryCode.value,
      kind: kind.value!,
      latitude: input.latitude ?? null,
      locality: locality.value,
      longitude: input.longitude ?? null,
      name: name.value!,
      parentPlaceId: input.parentPlaceId ?? null,
      region: region.value,
      sensitivity: sensitivity.value,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const visibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "place",
          id: places.id,
          sensitivity: places.sensitivity,
        });
        if (input.parentPlaceId) {
          const parent = await repository.getPlace({
            id: input.parentPlaceId,
            visibility,
            workspaceId: scopedContext.workspaceId,
            lock: true,
          });
          if (!parent) return notFound();
        }
        const [created] = await scopedContext.database
          .insert(places)
          .values({
            id: newId(),
            workspaceId: scopedContext.workspaceId,
            name: name.value!,
            kind: kind.value!,
            parentPlaceId: input.parentPlaceId,
            countryCode: countryCode.value,
            region: region.value,
            locality: locality.value,
            latitude: input.latitude == null ? null : input.latitude.toFixed(6),
            longitude:
              input.longitude == null ? null : input.longitude.toFixed(6),
            sensitivity: sensitivity.value,
            createdBy: scopedContext.actor.principalId,
            updatedBy: scopedContext.actor.principalId,
          })
          .returning();
        if (!created) throw new Error("Place insert failed");
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "place.create",
          resourceKind: "place",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: [
            "name",
            "kind",
            "parentPlaceId",
            "countryCode",
            "region",
            "locality",
            "coordinates",
            "sensitivity",
          ],
          metadata: { kind: created.kind, version: created.version },
        });
        const visible = await canAccessResource(
          scopedContext.database,
          scopedContext,
          {
            id: created.id,
            lockGrants: true,
            resourceKind: "place",
            sensitivity: created.sensitivity,
          },
        );
        return {
          associationId: null,
          resourceId: created.id,
          code: visible ? null : "NOT_VISIBLE",
          currentVersion: null,
        };
      },
    );
    return placeOutcome(executed.responseReference, permissions);
  }

  async function updatePlace(
    input: UpdatePlaceInput,
  ): Promise<MutationOutcome<PlaceRow>> {
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...versions({ path: "expectedVersion", value: input.expectedVersion }),
    ];
    const name =
      input.name === undefined
        ? undefined
        : normalizeText(input.name, "name", 300, true);
    const kind =
      input.kind === undefined
        ? undefined
        : normalizeText(input.kind, "kind", 64, true);
    const region =
      input.region === undefined
        ? undefined
        : normalizeText(input.region, "region", 300);
    const locality =
      input.locality === undefined
        ? undefined
        : normalizeText(input.locality, "locality", 300);
    const countryCode =
      input.countryCode === undefined
        ? undefined
        : countryCodeValue(input.countryCode);
    const sensitivity =
      input.sensitivity === undefined
        ? undefined
        : sensitivityValue(input.sensitivity);
    for (const value of [
      name,
      kind,
      region,
      locality,
      countryCode,
      sensitivity,
    ]) {
      if (value) issues.push(...value.issues);
    }
    if (input.parentPlaceId && !UUID.test(input.parentPlaceId)) {
      issues.push(
        issue("parentPlaceId", "INVALID_ID", "The parent place is invalid."),
      );
    }
    if (input.latitude !== undefined || input.longitude !== undefined) {
      if ((input.latitude === undefined) !== (input.longitude === undefined)) {
        issues.push(
          issue(
            "latitude",
            "INVALID_COORDINATES",
            "Both coordinate fields must be updated together.",
          ),
        );
      } else {
        issues.push(...coordinates(input.latitude, input.longitude));
      }
    }
    if (issues.length) return invalid(issues);
    const permissions = permissionSet.updatePlace;
    const derived = claim("location.place.update", input.idempotencyKey, {
      countryCode:
        input.countryCode === undefined
          ? "__unchanged__"
          : (countryCode?.value ?? null),
      expectedVersion: input.expectedVersion,
      id: input.id,
      kind: input.kind === undefined ? "__unchanged__" : (kind?.value ?? null),
      latitude: input.latitude === undefined ? "__unchanged__" : input.latitude,
      locality:
        input.locality === undefined
          ? "__unchanged__"
          : (locality?.value ?? null),
      longitude:
        input.longitude === undefined ? "__unchanged__" : input.longitude,
      name: input.name === undefined ? "__unchanged__" : (name?.value ?? null),
      parentPlaceId:
        input.parentPlaceId === undefined
          ? "__unchanged__"
          : input.parentPlaceId,
      region:
        input.region === undefined ? "__unchanged__" : (region?.value ?? null),
      sensitivity: input.sensitivity ?? "__unchanged__",
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const visibility = resourceVisibilitySql(scopedContext, {
          resourceKind: "place",
          id: places.id,
          sensitivity: places.sensitivity,
        });
        const current = await repository.getPlace({
          id: input.id,
          visibility,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (!current) return notFound();
        if (current.version !== input.expectedVersion) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: current.version,
          };
        }
        const nextParent =
          input.parentPlaceId === undefined
            ? current.parentPlaceId
            : input.parentPlaceId;
        if (nextParent) {
          const parent = await repository.getPlace({
            id: nextParent,
            visibility,
            workspaceId: scopedContext.workspaceId,
            lock: true,
          });
          if (!parent) return notFound();
        }
        if (await parentWouldCycle(scopedContext, current.id, nextParent)) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The parent place would create a cycle.",
          );
        }
        const now = new Date();
        const [updated] = await scopedContext.database
          .update(places)
          .set({
            ...(name !== undefined ? { name: name.value! } : {}),
            ...(kind !== undefined ? { kind: kind.value! } : {}),
            ...(input.parentPlaceId !== undefined
              ? { parentPlaceId: input.parentPlaceId }
              : {}),
            ...(countryCode !== undefined
              ? { countryCode: countryCode.value }
              : {}),
            ...(region !== undefined ? { region: region.value } : {}),
            ...(locality !== undefined ? { locality: locality.value } : {}),
            ...(input.latitude !== undefined
              ? {
                  latitude:
                    input.latitude == null ? null : input.latitude.toFixed(6),
                  longitude:
                    input.longitude == null ? null : input.longitude.toFixed(6),
                }
              : {}),
            ...(sensitivity !== undefined
              ? { sensitivity: sensitivity.value }
              : {}),
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${places.version} + 1`,
          })
          .where(
            and(
              eq(places.workspaceId, scopedContext.workspaceId),
              eq(places.id, current.id),
              eq(places.version, input.expectedVersion),
              isNull(places.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: null,
          };
        }
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "place.update",
          resourceKind: "place",
          resourceId: updated.id,
          sensitivity: updated.sensitivity,
          changedFields: [
            "name",
            "kind",
            "parentPlaceId",
            "countryCode",
            "region",
            "locality",
            "coordinates",
            "sensitivity",
          ],
          metadata: { kind: updated.kind, version: updated.version },
        });
        const visible = await canAccessResource(
          scopedContext.database,
          scopedContext,
          {
            id: updated.id,
            lockGrants: true,
            resourceKind: "place",
            sensitivity: updated.sensitivity,
          },
        );
        return {
          associationId: null,
          resourceId: updated.id,
          code: visible ? null : "NOT_VISIBLE",
          currentVersion: null,
        };
      },
    );
    return placeOutcome(executed.responseReference, permissions);
  }

  async function archivePlace(
    input: ArchivePlaceInput,
  ): Promise<MutationOutcome<PlaceRow>> {
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...versions({ path: "expectedVersion", value: input.expectedVersion }),
    ];
    if (issues.length) return invalid(issues);
    const permissions = permissionSet.archivePlace;
    const derived = claim("location.place.archive", input.idempotencyKey, {
      expectedVersion: input.expectedVersion,
      id: input.id,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const current = await repository.getPlace({
          id: input.id,
          visibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "place",
            id: places.id,
            sensitivity: places.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (!current) return notFound();
        if (current.version !== input.expectedVersion) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: current.version,
          };
        }
        const [[child], [linked]] = await Promise.all([
          scopedContext.database
            .select({ total: count() })
            .from(places)
            .where(
              and(
                eq(places.workspaceId, scopedContext.workspaceId),
                eq(places.parentPlaceId, current.id),
                isNull(places.deletedAt),
              ),
            ),
          scopedContext.database
            .select({ total: count() })
            .from(addresses)
            .where(
              and(
                eq(addresses.workspaceId, scopedContext.workspaceId),
                eq(addresses.placeId, current.id),
                isNull(addresses.deletedAt),
              ),
            ),
        ]);
        if ((child?.total ?? 0) > 0 || (linked?.total ?? 0) > 0) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The place is still referenced.",
          );
        }
        const now = new Date();
        const [archived] = await scopedContext.database
          .update(places)
          .set({
            deletedAt: now,
            deletedBy: scopedContext.actor.principalId,
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${places.version} + 1`,
          })
          .where(
            and(
              eq(places.workspaceId, scopedContext.workspaceId),
              eq(places.id, current.id),
              eq(places.version, input.expectedVersion),
              isNull(places.deletedAt),
            ),
          )
          .returning({ id: places.id, version: places.version });
        if (!archived) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: null,
          };
        }
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "place.archive",
          resourceKind: "place",
          resourceId: current.id,
          sensitivity: current.sensitivity,
          changedFields: ["deletedAt"],
          metadata: { version: archived.version },
        });
        return {
          associationId: null,
          resourceId: archived.id,
          code: "ARCHIVED",
          currentVersion: archived.version,
        };
      },
    );
    return placeOutcome(executed.responseReference, permissions);
  }

  async function createAddress(
    input: CreateAddressInput,
  ): Promise<MutationOutcome<AddressView>> {
    const addressKind = normalizeText(
      input.addressKind,
      "addressKind",
      64,
      true,
    );
    const sensitivity = sensitivityValue(input.sensitivity);
    const confidence = confidenceValue(input.confidence);
    const validFrom = parseDate(input.validFrom, "validFrom");
    const validUntil = parseDate(input.validUntil, "validUntil");
    const precision = (input.temporalPrecision ?? "unknown").toLowerCase();
    const state = (input.state ?? "asserted").toLowerCase();
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...addressKind.issues,
      ...sensitivity.issues,
      ...confidence.issues,
      ...validFrom.issues,
      ...validUntil.issues,
      ...temporalIssues(validFrom.value, validUntil.value),
    ];
    if (!TEMPORAL_PRECISIONS.has(precision)) {
      issues.push(
        issue(
          "temporalPrecision",
          "INVALID_ENUM",
          "The temporal precision is invalid.",
        ),
      );
    }
    if (!ADDRESS_STATES.has(state)) {
      issues.push(
        issue("state", "INVALID_ENUM", "The address state is invalid."),
      );
    }
    if (!UUID.test(input.personId)) {
      issues.push(issue("personId", "INVALID_ID", "The person is invalid."));
    }
    if (input.placeId && !UUID.test(input.placeId)) {
      issues.push(issue("placeId", "INVALID_ID", "The place is invalid."));
    }
    if (input.evidenceId && !UUID.test(input.evidenceId)) {
      issues.push(
        issue("evidenceId", "INVALID_ID", "The evidence item is invalid."),
      );
    }
    const now = new Date();
    if (
      input.isPrimary &&
      !isEffectiveCurrent(validFrom.value, validUntil.value, now)
    ) {
      issues.push(
        issue(
          "isPrimary",
          "PRIMARY_REQUIRES_CURRENT",
          "Only a currently effective association can be primary.",
        ),
      );
    }
    let normalized: ReturnType<typeof normalizeAddress> | null = null;
    try {
      normalized = normalizeAddress({
        ...input,
        blindIndexKey: runtime.blindIndexKey,
        workspaceId: context.workspaceId,
      });
    } catch {
      issues.push(
        issue("address", "INVALID_ADDRESS", "The address is invalid."),
      );
    }
    if (issues.length || !normalized) return invalid(issues);
    const permissions = [
      ...permissionSet.createAddress,
      ...(input.placeId ? ["place:read"] : []),
      ...(input.evidenceId ? ["evidence:read"] : []),
    ];
    const derived = claim("location.address.create", input.idempotencyKey, {
      addressKind: addressKind.value!,
      confidence: confidence.value,
      evidenceId: input.evidenceId ?? null,
      isPrimary: input.isPrimary ?? false,
      normalizedAddress: normalized.normalizedHash,
      personId: input.personId,
      placeId: input.placeId ?? null,
      sensitivity: sensitivity.value,
      state,
      temporalPrecision: precision,
      validFrom: validFrom.value?.toISOString() ?? null,
      validUntil: validUntil.value?.toISOString() ?? null,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const person = await repository.lockVisiblePerson({
          id: input.personId,
          visibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "person",
            id: people.id,
            sensitivity: people.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
        });
        if (!person) return notFound();
        if (
          input.evidenceId &&
          !(await visibleEvidence(scopedContext, input.evidenceId))
        ) {
          return notFound();
        }
        let place: PlaceRow | null = null;
        if (input.placeId) {
          place = await repository.getPlace({
            id: input.placeId,
            visibility: resourceVisibilitySql(scopedContext, {
              resourceKind: "place",
              id: places.id,
              sensitivity: places.sensitivity,
            }),
            workspaceId: scopedContext.workspaceId,
            lock: true,
          });
          if (!place) return notFound();
        }
        const transactionNow = new Date();
        const current = isEffectiveCurrent(
          validFrom.value,
          validUntil.value,
          transactionNow,
        );
        if (input.isPrimary && !current) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Only a currently effective association can be primary.",
          );
        }
        if (input.isPrimary && current) {
          await repository.clearAddressPrimary({
            actorId: scopedContext.actor.principalId,
            addressKind: addressKind.value!,
            now: transactionNow,
            personId: input.personId,
            workspaceId: scopedContext.workspaceId,
          });
        }
        const addressId = newId();
        const associationId = newId();
        const [address] = await scopedContext.database
          .insert(addresses)
          .values({
            id: addressId,
            workspaceId: scopedContext.workspaceId,
            placeId: place?.id,
            ...normalized!.value,
            normalizedHash: normalized!.normalizedHash,
            normalizedHashVersion: 1,
            sensitivity: sensitivity.value,
            createdBy: scopedContext.actor.principalId,
            updatedBy: scopedContext.actor.principalId,
          })
          .returning();
        const [association] = await scopedContext.database
          .insert(personAddresses)
          .values({
            id: associationId,
            workspaceId: scopedContext.workspaceId,
            personId: input.personId,
            addressId,
            addressKind: addressKind.value!,
            validFrom: validFrom.value,
            validUntil: validUntil.value,
            temporalPrecision:
              precision as typeof personAddresses.$inferInsert.temporalPrecision,
            isPrimary: Boolean(input.isPrimary && current),
            confidence: String(confidence.value),
            state,
            evidenceId: input.evidenceId,
            createdBy: scopedContext.actor.principalId,
            updatedBy: scopedContext.actor.principalId,
          })
          .returning();
        if (!address || !association) throw new Error("Address insert failed");
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "address.create",
          resourceKind: "address",
          resourceId: address.id,
          sensitivity: address.sensitivity,
          changedFields: [
            "structuredAddress",
            "placeId",
            "sensitivity",
            "association",
          ],
          metadata: {
            addressKind: association.addressKind,
            evidenceLinked: Boolean(association.evidenceId),
            isPrimary: association.isPrimary,
            version: address.version,
          },
        });
        await applySearchIndexMaintenance(
          scopedContext,
          scopedContext.database,
          [
            {
              action: "upsert",
              sourceId: association.id,
              sourceKind: "person_address",
              sourceVersion: association.version,
              workspaceId: scopedContext.workspaceId,
            },
          ],
        );
        const visible = await canAccessResource(
          scopedContext.database,
          scopedContext,
          {
            id: address.id,
            lockGrants: true,
            resourceKind: "address",
            sensitivity: address.sensitivity,
          },
        );
        return {
          associationId: association.id,
          resourceId: address.id,
          code: visible ? null : "NOT_VISIBLE",
          currentVersion: null,
        };
      },
    );
    return addressOutcome(executed.responseReference, permissions);
  }

  async function updateAddress(
    input: UpdateAddressInput,
  ): Promise<MutationOutcome<AddressView>> {
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...versions(
        { path: "expectedVersion", value: input.expectedVersion },
        {
          path: "expectedAddressVersion",
          value: input.expectedAddressVersion,
        },
      ),
    ];
    const addressKind =
      input.addressKind === undefined
        ? undefined
        : normalizeText(input.addressKind, "addressKind", 64, true);
    const sensitivity =
      input.sensitivity === undefined
        ? undefined
        : sensitivityValue(input.sensitivity);
    const confidence =
      input.confidence === undefined
        ? undefined
        : confidenceValue(input.confidence);
    const validFrom =
      input.validFrom === undefined
        ? undefined
        : parseDate(input.validFrom, "validFrom");
    const validUntil =
      input.validUntil === undefined
        ? undefined
        : parseDate(input.validUntil, "validUntil");
    for (const value of [
      addressKind,
      sensitivity,
      confidence,
      validFrom,
      validUntil,
    ]) {
      if (value) issues.push(...value.issues);
    }
    const precision = input.temporalPrecision?.toLowerCase();
    if (precision !== undefined && !TEMPORAL_PRECISIONS.has(precision)) {
      issues.push(
        issue(
          "temporalPrecision",
          "INVALID_ENUM",
          "The temporal precision is invalid.",
        ),
      );
    }
    const state = input.state?.toLowerCase();
    if (state !== undefined && !ADDRESS_STATES.has(state)) {
      issues.push(
        issue("state", "INVALID_ENUM", "The address state is invalid."),
      );
    }
    if (input.placeId && !UUID.test(input.placeId)) {
      issues.push(issue("placeId", "INVALID_ID", "The place is invalid."));
    }
    if (input.evidenceId && !UUID.test(input.evidenceId)) {
      issues.push(
        issue("evidenceId", "INVALID_ID", "The evidence item is invalid."),
      );
    }
    if (issues.length) return invalid(issues);
    const permissions = [
      ...permissionSet.updateAddress,
      ...(input.placeId ? ["place:read"] : []),
      ...(input.evidenceId ? ["evidence:read"] : []),
    ];
    const addressPatchMaterial = requestDigest(
      runtime.blindIndexKey,
      JSON.stringify({
        countryCode:
          input.countryCode === undefined ? "__unchanged__" : input.countryCode,
        latitude:
          input.latitude === undefined ? "__unchanged__" : input.latitude,
        line1:
          input.line1 === undefined
            ? "__unchanged__"
            : input.line1?.normalize("NFKC"),
        line2:
          input.line2 === undefined
            ? "__unchanged__"
            : input.line2?.normalize("NFKC"),
        locality:
          input.locality === undefined
            ? "__unchanged__"
            : input.locality?.normalize("NFKC"),
        longitude:
          input.longitude === undefined ? "__unchanged__" : input.longitude,
        postalCode:
          input.postalCode === undefined
            ? "__unchanged__"
            : input.postalCode?.normalize("NFKC"),
        region:
          input.region === undefined
            ? "__unchanged__"
            : input.region?.normalize("NFKC"),
        unstructuredText:
          input.unstructuredText === undefined
            ? "__unchanged__"
            : input.unstructuredText?.normalize("NFKC"),
      }),
    );
    const derived = claim("location.address.update", input.idempotencyKey, {
      addressKind:
        input.addressKind === undefined
          ? "__unchanged__"
          : (addressKind?.value ?? null),
      addressPatch: addressPatchMaterial,
      associationId: input.associationId,
      confidence: input.confidence ?? null,
      evidenceId:
        input.evidenceId === undefined ? "__unchanged__" : input.evidenceId,
      expectedAddressVersion: input.expectedAddressVersion,
      expectedVersion: input.expectedVersion,
      isPrimary: input.isPrimary ?? null,
      placeId: input.placeId === undefined ? "__unchanged__" : input.placeId,
      sensitivity: input.sensitivity ?? "__unchanged__",
      state: state ?? "__unchanged__",
      temporalPrecision: precision ?? "__unchanged__",
      validFrom:
        input.validFrom === undefined
          ? "__unchanged__"
          : (validFrom?.value?.toISOString() ?? null),
      validUntil:
        input.validUntil === undefined
          ? "__unchanged__"
          : (validUntil?.value?.toISOString() ?? null),
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const preRead = await repository.getPersonAddressAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
        });
        if (!preRead) return notFound();
        const person = await repository.lockVisiblePerson({
          id: preRead.personId,
          visibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "person",
            id: people.id,
            sensitivity: people.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
        });
        const association = await repository.getPersonAddressAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (
          !person ||
          !association ||
          association.personId !== preRead.personId
        ) {
          return notFound();
        }
        const address = await repository.getAddress({
          id: association.addressId,
          visibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "address",
            id: addresses.id,
            sensitivity: addresses.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (!address) return notFound();
        if (
          association.version !== input.expectedVersion ||
          address.version !== input.expectedAddressVersion
        ) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: Math.max(association.version, address.version),
          };
        }
        const nextFrom =
          input.validFrom === undefined
            ? association.validFrom
            : validFrom!.value;
        const nextUntil =
          input.validUntil === undefined
            ? association.validUntil
            : validUntil!.value;
        if (temporalIssues(nextFrom, nextUntil).length) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The date range is invalid.",
          );
        }
        const now = new Date();
        const current = isEffectiveCurrent(nextFrom, nextUntil, now);
        const desiredPrimary = current
          ? (input.isPrimary ?? association.isPrimary)
          : false;
        if (input.isPrimary && !current) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Only a currently effective association can be primary.",
          );
        }
        if (
          input.evidenceId &&
          !(await visibleEvidence(scopedContext, input.evidenceId))
        ) {
          return notFound();
        }
        let place: PlaceRow | null = null;
        const nextPlaceId =
          input.placeId === undefined ? address.placeId : input.placeId;
        if (nextPlaceId) {
          place = await repository.getPlace({
            id: nextPlaceId,
            visibility: resourceVisibilitySql(scopedContext, {
              resourceKind: "place",
              id: places.id,
              sensitivity: places.sensitivity,
            }),
            workspaceId: scopedContext.workspaceId,
            lock: true,
          });
          if (!place) return notFound();
        }
        let normalized: ReturnType<typeof normalizeAddress>;
        try {
          normalized = normalizeAddress({
            blindIndexKey: runtime.blindIndexKey,
            workspaceId: scopedContext.workspaceId,
            line1: input.line1 === undefined ? address.line1 : input.line1,
            line2: input.line2 === undefined ? address.line2 : input.line2,
            locality:
              input.locality === undefined ? address.locality : input.locality,
            region: input.region === undefined ? address.region : input.region,
            postalCode:
              input.postalCode === undefined
                ? address.postalCode
                : input.postalCode,
            countryCode:
              input.countryCode === undefined
                ? address.countryCode
                : input.countryCode,
            unstructuredText:
              input.unstructuredText === undefined
                ? address.unstructuredText
                : input.unstructuredText,
            latitude:
              input.latitude === undefined
                ? address.latitude == null
                  ? null
                  : Number(address.latitude)
                : input.latitude,
            longitude:
              input.longitude === undefined
                ? address.longitude == null
                  ? null
                  : Number(address.longitude)
                : input.longitude,
          });
        } catch {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The address is invalid.",
          );
        }
        const nextKind = addressKind?.value ?? association.addressKind;
        if (desiredPrimary && current) {
          await repository.clearAddressPrimary({
            actorId: scopedContext.actor.principalId,
            addressKind: nextKind,
            exceptId: association.id,
            now,
            personId: association.personId,
            workspaceId: scopedContext.workspaceId,
          });
        }
        const [updatedAddress] = await scopedContext.database
          .update(addresses)
          .set({
            placeId: nextPlaceId,
            ...normalized.value,
            normalizedHash: normalized.normalizedHash,
            normalizedHashVersion: 1,
            ...(sensitivity !== undefined
              ? { sensitivity: sensitivity.value }
              : {}),
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${addresses.version} + 1`,
          })
          .where(
            and(
              eq(addresses.workspaceId, scopedContext.workspaceId),
              eq(addresses.id, address.id),
              eq(addresses.version, input.expectedAddressVersion),
              isNull(addresses.deletedAt),
            ),
          )
          .returning();
        const [updatedAssociation] = await scopedContext.database
          .update(personAddresses)
          .set({
            ...(addressKind !== undefined
              ? { addressKind: addressKind.value! }
              : {}),
            ...(input.validFrom !== undefined ? { validFrom: nextFrom } : {}),
            ...(input.validUntil !== undefined
              ? { validUntil: nextUntil }
              : {}),
            ...(precision !== undefined
              ? {
                  temporalPrecision:
                    precision as typeof personAddresses.$inferInsert.temporalPrecision,
                }
              : {}),
            isPrimary: desiredPrimary,
            ...(confidence !== undefined
              ? { confidence: String(confidence.value) }
              : {}),
            ...(state !== undefined ? { state } : {}),
            ...(input.evidenceId !== undefined
              ? { evidenceId: input.evidenceId }
              : {}),
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${personAddresses.version} + 1`,
          })
          .where(
            and(
              eq(personAddresses.workspaceId, scopedContext.workspaceId),
              eq(personAddresses.id, association.id),
              eq(personAddresses.version, input.expectedVersion),
              isNull(personAddresses.deletedAt),
            ),
          )
          .returning();
        if (!updatedAddress || !updatedAssociation) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: null,
          };
        }
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "address.update",
          resourceKind: "address",
          resourceId: updatedAddress.id,
          sensitivity: updatedAddress.sensitivity,
          changedFields: [
            "structuredAddress",
            "placeId",
            "sensitivity",
            "association",
          ],
          metadata: {
            addressKind: updatedAssociation.addressKind,
            evidenceLinked: Boolean(updatedAssociation.evidenceId),
            isPrimary: updatedAssociation.isPrimary,
            version: updatedAddress.version,
          },
        });
        await applySearchIndexMaintenance(
          scopedContext,
          scopedContext.database,
          [
            {
              action: "upsert",
              sourceId: updatedAssociation.id,
              sourceKind: "person_address",
              sourceVersion: updatedAssociation.version,
              workspaceId: scopedContext.workspaceId,
            },
          ],
        );
        const visible = await canAccessResource(
          scopedContext.database,
          scopedContext,
          {
            id: updatedAddress.id,
            lockGrants: true,
            resourceKind: "address",
            sensitivity: updatedAddress.sensitivity,
          },
        );
        return {
          associationId: updatedAssociation.id,
          resourceId: updatedAddress.id,
          code: visible ? null : "NOT_VISIBLE",
          currentVersion: null,
        };
      },
    );
    return addressOutcome(executed.responseReference, permissions);
  }

  async function archiveAddress(
    input: ArchiveAddressInput,
  ): Promise<MutationOutcome<AddressView>> {
    const issues = [
      ...keyIssues(input.idempotencyKey),
      ...versions(
        { path: "expectedVersion", value: input.expectedVersion },
        {
          path: "expectedAddressVersion",
          value: input.expectedAddressVersion,
        },
      ),
    ];
    if (issues.length) return invalid(issues);
    const permissions = permissionSet.archiveAddress;
    const derived = claim("location.address.archive", input.idempotencyKey, {
      associationId: input.associationId,
      expectedAddressVersion: input.expectedAddressVersion,
      expectedVersion: input.expectedVersion,
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      derived,
      permissions,
      async (scopedContext): Promise<MutationReference> => {
        const repository = createLocationsRepository(scopedContext.database);
        const preRead = await repository.getPersonAddressAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
        });
        if (!preRead) return notFound();
        const person = await repository.lockVisiblePerson({
          id: preRead.personId,
          visibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "person",
            id: people.id,
            sensitivity: people.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
        });
        const association = await repository.getPersonAddressAssociation({
          id: input.associationId,
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (
          !person ||
          !association ||
          association.personId !== preRead.personId
        ) {
          return notFound();
        }
        const address = await repository.getAddress({
          id: association.addressId,
          visibility: resourceVisibilitySql(scopedContext, {
            resourceKind: "address",
            id: addresses.id,
            sensitivity: addresses.sensitivity,
          }),
          workspaceId: scopedContext.workspaceId,
          lock: true,
        });
        if (!address) return notFound();
        if (
          association.version !== input.expectedVersion ||
          address.version !== input.expectedAddressVersion
        ) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: Math.max(association.version, address.version),
          };
        }
        const now = new Date();
        const [archivedAssociation] = await scopedContext.database
          .update(personAddresses)
          .set({
            deletedAt: now,
            deletedBy: scopedContext.actor.principalId,
            isPrimary: false,
            updatedAt: now,
            updatedBy: scopedContext.actor.principalId,
            version: sql`${personAddresses.version} + 1`,
          })
          .where(
            and(
              eq(personAddresses.workspaceId, scopedContext.workspaceId),
              eq(personAddresses.id, association.id),
              eq(personAddresses.version, input.expectedVersion),
              isNull(personAddresses.deletedAt),
            ),
          )
          .returning();
        if (!archivedAssociation) {
          return {
            associationId: null,
            resourceId: null,
            code: "CONFLICT",
            currentVersion: null,
          };
        }
        const [remaining] = await scopedContext.database
          .select({ total: count() })
          .from(personAddresses)
          .where(
            and(
              eq(personAddresses.workspaceId, scopedContext.workspaceId),
              eq(personAddresses.addressId, address.id),
              isNull(personAddresses.deletedAt),
            ),
          );
        let archivedVersion = address.version;
        if ((remaining?.total ?? 0) === 0) {
          const [archived] = await scopedContext.database
            .update(addresses)
            .set({
              deletedAt: now,
              deletedBy: scopedContext.actor.principalId,
              updatedAt: now,
              updatedBy: scopedContext.actor.principalId,
              version: sql`${addresses.version} + 1`,
            })
            .where(
              and(
                eq(addresses.workspaceId, scopedContext.workspaceId),
                eq(addresses.id, address.id),
                eq(addresses.version, input.expectedAddressVersion),
                isNull(addresses.deletedAt),
              ),
            )
            .returning({ version: addresses.version });
          if (!archived) {
            return {
              associationId: null,
              resourceId: null,
              code: "CONFLICT",
              currentVersion: null,
            };
          }
          archivedVersion = archived.version;
        }
        const audit = createAuditService(scopedContext);
        await audit.write(scopedContext.database, {
          action: "address.archive",
          resourceKind: "address",
          resourceId: address.id,
          sensitivity: address.sensitivity,
          changedFields: ["association.deletedAt", "deletedAt"],
          metadata: { version: archivedVersion },
        });
        await applySearchIndexMaintenance(
          scopedContext,
          scopedContext.database,
          [
            {
              action: "remove",
              sourceId: association.id,
              sourceKind: "person_address",
              sourceVersion: archivedAssociation.version,
              workspaceId: scopedContext.workspaceId,
            },
          ],
        );
        return {
          associationId: archivedAssociation.id,
          resourceId: address.id,
          code: "ARCHIVED",
          currentVersion: archivedVersion,
        };
      },
    );
    return addressOutcome(executed.responseReference, permissions);
  }

  return {
    archiveContact,
    archiveAddress,
    archivePlace,
    createContact,
    createAddress,
    createPlace,
    updateContact,
    updateAddress,
    updatePlace,
  };
}
