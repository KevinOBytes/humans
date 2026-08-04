import { and, count, eq, isNull, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { personAddresses, personContactPoints } from "@/db/schema/evidence";
import { addresses, contactPoints, places } from "@/db/schema/locations";
import { people } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import {
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  withResearchWriteTransaction,
} from "@/modules/audit/transactions";
import type { ValidationIssue } from "@/modules/facts/validation";
import type { Connection, MutationOutcome } from "@/modules/people/service";

import {
  decodeLocationCursor,
  encodeLocationCursor,
  normalizeAddress,
  openProtectedContact,
  prepareProtectedPhone,
  type ContactKind,
} from "./domain";
import {
  createLocationsRepository,
  type AddressRow,
  type ContactPointRow,
  type PersonAddressRow,
  type PersonContactRow,
  type PlaceRow,
} from "./repository";
import {
  createLocationMutations,
  type ArchiveContactInput,
  type CreateContactInput,
  type UpdateContactInput,
} from "./mutations";

type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export type ContactView = Readonly<{
  associationId: string;
  contactPointId: string;
  confidence: number;
  createdAt: Date;
  displayValue: string;
  isPrimary: boolean;
  evidenceId: string | null;
  kind: ContactKind;
  label: string | null;
  sensitivity: Sensitivity;
  usageKind: string;
  validFrom: Date | null;
  validUntil: Date | null;
  verificationState: string;
  version: number;
  contactVersion: number;
}>;

export type AddressView = Readonly<{
  addressId: string;
  associationId: string;
  addressKind: string;
  confidence: number;
  countryCode: string | null;
  createdAt: Date;
  isPrimary: boolean;
  latitude: number | null;
  line1: string | null;
  line2: string | null;
  locality: string | null;
  longitude: number | null;
  place: PlaceRow | null;
  postalCode: string | null;
  region: string | null;
  sensitivity: Sensitivity;
  state: string;
  temporalPrecision: string;
  unstructuredText: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  version: number;
  addressVersion: number;
  evidenceId: string | null;
}>;

export type LocationRuntime = Readonly<{
  blindIndexKey: string;
  cursorHmacKey: string;
  encryptionKey: string;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/u;
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

function conflict<T>(currentVersion?: number | null): MutationOutcome<T> {
  return {
    resource: null,
    issues: [],
    code: "CONFLICT",
    currentVersion: currentVersion ?? null,
  };
}

function notFound(): never {
  throw createGraphQLError(
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}

function decodeCursor(
  value: string,
  binding: Parameters<typeof decodeLocationCursor>[1],
) {
  try {
    return decodeLocationCursor(value, binding);
  } catch {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The location cursor is invalid.",
    );
  }
}

function normalizeText(
  value: string | null | undefined,
  path: string,
  max: number,
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
    Buffer.byteLength(normalized, "utf8") > max ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    return {
      value: null,
      issues: [issue(path, "INVALID_VALUE", "The value is invalid.")],
    };
  }
  return { value: normalized, issues: [] };
}

function validateCommon(input: {
  confidence?: number | null;
  idempotencyKey: string;
  sensitivity?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}) {
  const issues: ValidationIssue[] = [];
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
    issues.push(
      issue(
        "idempotencyKey",
        "INVALID_VALUE",
        "The idempotency key is invalid.",
      ),
    );
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    issues.push(
      issue(
        "confidence",
        "INVALID_VALUE",
        "Confidence must be between 0 and 1.",
      ),
    );
  const sensitivity = (input.sensitivity ?? "confidential").toLowerCase();
  if (!sensitivities.has(sensitivity as Sensitivity))
    issues.push(
      issue("sensitivity", "INVALID_ENUM", "The sensitivity is invalid."),
    );
  const validFrom = input.validFrom == null ? null : new Date(input.validFrom);
  const validUntil =
    input.validUntil == null ? null : new Date(input.validUntil);
  if (validFrom && Number.isNaN(validFrom.getTime()))
    issues.push(issue("validFrom", "INVALID_DATE", "The date is invalid."));
  if (validUntil && Number.isNaN(validUntil.getTime()))
    issues.push(issue("validUntil", "INVALID_DATE", "The date is invalid."));
  if (validFrom && validUntil && validUntil < validFrom)
    issues.push(
      issue("validUntil", "INVALID_RANGE", "The date range is invalid."),
    );
  return {
    confidence,
    issues,
    sensitivity: sensitivity as Sensitivity,
    validFrom,
    validUntil,
  };
}

export function contactView(
  row: PersonContactRow,
  encryptionKey: string,
): ContactView {
  let displayValue: string;
  try {
    const kind = row.contact.kind;
    if (kind !== "phone" && kind !== "email" && kind !== "other") {
      throw new Error("Unsupported protected contact kind");
    }
    displayValue = openProtectedContact({
      encryptionKey,
      kind,
      token: row.contact.encryptedDisplayValue,
    });
  } catch {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected contact data is unavailable.",
    );
  }
  return {
    associationId: row.association.id,
    contactPointId: row.contact.id,
    confidence: Number(row.association.confidence),
    contactVersion: row.contact.version,
    createdAt: row.association.createdAt,
    displayValue,
    isPrimary: row.association.isPrimary,
    evidenceId: row.association.evidenceId,
    kind: row.contact.kind as ContactKind,
    label: row.contact.label,
    sensitivity: row.contact.sensitivity,
    usageKind: row.association.usageKind,
    validFrom: row.association.validFrom,
    validUntil: row.association.validUntil,
    verificationState: row.contact.verificationState,
    version: row.association.version,
  };
}

export function addressView(row: PersonAddressRow): AddressView {
  return {
    addressId: row.address.id,
    addressVersion: row.address.version,
    associationId: row.association.id,
    addressKind: row.association.addressKind,
    confidence: Number(row.association.confidence),
    evidenceId: row.association.evidenceId,
    countryCode: row.address.countryCode,
    createdAt: row.association.createdAt,
    isPrimary: row.association.isPrimary,
    latitude:
      row.address.latitude == null ? null : Number(row.address.latitude),
    line1: row.address.line1,
    line2: row.address.line2,
    locality: row.address.locality,
    longitude:
      row.address.longitude == null ? null : Number(row.address.longitude),
    place: row.place,
    postalCode: row.address.postalCode,
    region: row.address.region,
    sensitivity: row.address.sensitivity,
    state: row.association.state,
    temporalPrecision: row.association.temporalPrecision,
    unstructuredText: row.address.unstructuredText,
    validFrom: row.association.validFrom,
    validUntil: row.association.validUntil,
    version: row.association.version,
  };
}

function versionIssues(...values: readonly { path: string; value: number }[]) {
  return values.flatMap(({ path, value }) =>
    Number.isInteger(value) && value > 0
      ? []
      : [issue(path, "INVALID_VERSION", "A positive version is required.")],
  );
}

export function createLocationsService(
  context: ResearchServiceContext,
  runtime: LocationRuntime,
) {
  const repository = createLocationsRepository(context.database);
  const audit = createAuditService(context);
  const personVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: people.id,
    sensitivity: people.sensitivity,
  });
  const contactVisibility = resourceVisibilitySql(context, {
    resourceKind: "contactPoint",
    id: contactPoints.id,
    sensitivity: contactPoints.sensitivity,
  });
  const addressVisibility = resourceVisibilitySql(context, {
    resourceKind: "address",
    id: addresses.id,
    sensitivity: addresses.sensitivity,
  });
  const placeVisibility = resourceVisibilitySql(context, {
    resourceKind: "place",
    id: places.id,
    sensitivity: places.sensitivity,
  });
  const mutations = createLocationMutations(context, runtime);

  return {
    async getContactEditProjection(input: {
      associationId: string;
    }): Promise<ContactView> {
      if (!UUID.test(input.associationId)) notFound();
      const row = await repository.getPersonContactRow({
        associationId: input.associationId,
        contactVisibility,
        personVisibility,
        workspaceId: context.workspaceId,
      });
      if (!row) notFound();
      return contactView(row, runtime.encryptionKey);
    },

    async getAddressEditProjection(input: {
      associationId: string;
    }): Promise<AddressView> {
      if (!UUID.test(input.associationId)) notFound();
      const row = await repository.getPersonAddressRow({
        addressVisibility,
        associationId: input.associationId,
        personVisibility,
        placeVisibility,
        workspaceId: context.workspaceId,
      });
      if (!row) notFound();
      return addressView(row);
    },

    async listPersonContacts(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<ContactView>> {
      const page = normalizePagination(input);
      const cursor = page.after
        ? decodeCursor(page.after, {
            order: "person-contact-created-desc",
            parentId: input.personId,
            purpose: "person-contacts",
            secret: runtime.cursorHmacKey,
            workspaceId: context.workspaceId,
          })
        : null;
      const rows = await repository.listPersonContacts({
        after: cursor
          ? { createdAt: new Date(cursor.sort), id: cursor.id }
          : null,
        contactVisibility,
        limit: page.first + 1,
        personId: input.personId,
        personVisibility,
        workspaceId: context.workspaceId,
      });
      const selected = rows.slice(0, page.first);
      const nodes = selected.map((row) =>
        contactView(row, runtime.encryptionKey),
      );
      const last = selected.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeLocationCursor(
                {
                  id: last.association.id,
                  order: "person-contact-created-desc",
                  parentId: input.personId,
                  purpose: "person-contacts",
                  sort: last.association.createdAt.toISOString(),
                  workspaceId: context.workspaceId,
                },
                runtime.cursorHmacKey,
              )
            : null,
        },
      };
    },

    async listPersonAddresses(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<AddressView>> {
      const page = normalizePagination(input);
      const cursor = page.after
        ? decodeCursor(page.after, {
            order: "person-address-created-desc",
            parentId: input.personId,
            purpose: "person-addresses",
            secret: runtime.cursorHmacKey,
            workspaceId: context.workspaceId,
          })
        : null;
      const rows = await repository.listPersonAddresses({
        addressVisibility,
        after: cursor
          ? { createdAt: new Date(cursor.sort), id: cursor.id }
          : null,
        limit: page.first + 1,
        personId: input.personId,
        personVisibility,
        placeVisibility,
        workspaceId: context.workspaceId,
      });
      const selected = rows.slice(0, page.first);
      const last = selected.at(-1);
      return {
        nodes: selected.map(addressView),
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeLocationCursor(
                {
                  id: last.association.id,
                  order: "person-address-created-desc",
                  parentId: input.personId,
                  purpose: "person-addresses",
                  sort: last.association.createdAt.toISOString(),
                  workspaceId: context.workspaceId,
                },
                runtime.cursorHmacKey,
              )
            : null,
        },
      };
    },

    async listPlaces(input: { first?: number | null; after?: string | null }) {
      const page = normalizePagination(input);
      let after: { name: string; id: string } | null = null;
      if (page.after) {
        const cursor = decodeCursor(page.after, {
          order: "place-name-asc",
          parentId: context.workspaceId,
          purpose: "places",
          secret: runtime.cursorHmacKey,
          workspaceId: context.workspaceId,
        });
        after = { name: cursor.sort, id: cursor.id };
      }
      const rows = await repository.listPlaces({
        after,
        limit: page.first + 1,
        visibility: placeVisibility,
        workspaceId: context.workspaceId,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeLocationCursor(
                {
                  id: last.id,
                  order: "place-name-asc",
                  parentId: context.workspaceId,
                  purpose: "places",
                  sort: last.sortKey,
                  workspaceId: context.workspaceId,
                },
                runtime.cursorHmacKey,
              )
            : null,
        },
      };
    },

    async legacyCreatePhone(input: {
      confidence?: number | null;
      idempotencyKey: string;
      isPrimary?: boolean | null;
      label?: string | null;
      personId: string;
      sensitivity?: string | null;
      usageKind: string;
      validFrom?: string | null;
      validUntil?: string | null;
      value: string;
      verificationState?: string | null;
    }): Promise<MutationOutcome<ContactView>> {
      const common = validateCommon(input);
      const label = normalizeText(input.label, "label", 120);
      const usage = normalizeText(input.usageKind, "usageKind", 64, true);
      const verification = (
        input.verificationState ?? "unverified"
      ).toLowerCase();
      const issues = [...common.issues, ...label.issues, ...usage.issues];
      if (!["unverified", "verified", "invalid"].includes(verification))
        issues.push(
          issue(
            "verificationState",
            "INVALID_ENUM",
            "The verification state is invalid.",
          ),
        );
      let prepared: ReturnType<typeof prepareProtectedPhone> | null = null;
      try {
        prepared = prepareProtectedPhone({
          blindIndexKey: runtime.blindIndexKey,
          encryptionKey: runtime.encryptionKey,
          value: input.value,
          workspaceId: context.workspaceId,
        });
      } catch {
        issues.push(
          issue("value", "INVALID_PHONE", "The phone number is invalid."),
        );
      }
      if (issues.length || !prepared) return invalid(issues);
      const contactId = newId();
      const associationId = newId();
      const row = await withResearchWriteTransaction(
        context,
        async (database) => {
          const scoped = createLocationsRepository(database);
          const person = await scoped.lockVisiblePerson({
            id: input.personId,
            visibility: personVisibility,
            workspaceId: context.workspaceId,
          });
          if (!person) return notFound();
          const now = new Date();
          if (input.isPrimary)
            await scoped.clearContactPrimary({
              actorId: context.actor.principalId,
              now,
              personId: input.personId,
              usageKind: usage.value!,
              workspaceId: context.workspaceId,
            });
          const [contact] = await database
            .insert(contactPoints)
            .values({
              id: contactId,
              workspaceId: context.workspaceId,
              kind: "phone",
              encryptedDisplayValue: prepared.encryptedValue,
              blindIndex: prepared.blindIndex,
              blindIndexVersion: 1,
              label: label.value,
              verificationState: verification,
              sensitivity: common.sensitivity,
              metadata: {},
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            })
            .returning();
          const [association] = await database
            .insert(personContactPoints)
            .values({
              id: associationId,
              workspaceId: context.workspaceId,
              personId: input.personId,
              contactPointId: contactId,
              usageKind: usage.value!,
              isPrimary: input.isPrimary ?? false,
              validFrom: common.validFrom,
              validUntil: common.validUntil,
              confidence: String(common.confidence),
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            })
            .returning();
          if (!contact || !association)
            throw new Error("Contact insert failed");
          await audit.write(database, {
            action: "contactPoint.create",
            resourceKind: "contactPoint",
            resourceId: contact.id,
            sensitivity: contact.sensitivity,
            changedFields: [
              "kind",
              "label",
              "verificationState",
              "sensitivity",
            ],
            metadata: {
              associationId: association.id,
              isPrimary: association.isPrimary,
              usageKind: association.usageKind,
              version: contact.version,
            },
          });
          await applySearchIndexMaintenance(context, database, [
            {
              action: "upsert",
              sourceId: person.id,
              sourceKind: "person",
              sourceVersion: person.version,
              workspaceId: context.workspaceId,
            },
          ]);
          return { association, contact };
        },
      );
      return {
        resource: contactView(row, runtime.encryptionKey),
        issues: [],
        code: null,
      };
    },

    async legacyUpdatePhone(input: {
      associationId: string;
      expectedVersion: number;
      expectedContactVersion: number;
      idempotencyKey: string;
      value?: string | null;
      label?: string | null;
      verificationState?: string | null;
      sensitivity?: string | null;
      usageKind?: string | null;
      isPrimary?: boolean | null;
      validFrom?: string | null;
      validUntil?: string | null;
      confidence?: number | null;
    }): Promise<MutationOutcome<ContactView>> {
      const common = validateCommon({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      const issues = [
        ...common.issues,
        ...versionIssues(
          { path: "expectedVersion", value: input.expectedVersion },
          {
            path: "expectedContactVersion",
            value: input.expectedContactVersion,
          },
        ),
      ];
      const label =
        input.label === undefined
          ? null
          : normalizeText(input.label, "label", 120);
      const usage =
        input.usageKind === undefined
          ? null
          : normalizeText(input.usageKind, "usageKind", 64, true);
      if (label) issues.push(...label.issues);
      if (usage) issues.push(...usage.issues);
      if (
        input.verificationState !== undefined &&
        !["unverified", "verified", "invalid"].includes(
          input.verificationState?.toLowerCase() ?? "",
        )
      )
        issues.push(
          issue(
            "verificationState",
            "INVALID_ENUM",
            "The verification state is invalid.",
          ),
        );
      let prepared: ReturnType<typeof prepareProtectedPhone> | null = null;
      if (input.value != null) {
        try {
          prepared = prepareProtectedPhone({
            blindIndexKey: runtime.blindIndexKey,
            encryptionKey: runtime.encryptionKey,
            value: input.value,
            workspaceId: context.workspaceId,
          });
        } catch {
          issues.push(
            issue("value", "INVALID_PHONE", "The phone number is invalid."),
          );
        }
      }
      if (issues.length) return invalid(issues);
      return withResearchWriteTransaction(context, async (database) => {
        const scoped = createLocationsRepository(database);
        const association = await scoped.getPersonContactAssociation({
          id: input.associationId,
          workspaceId: context.workspaceId,
          lock: true,
        });
        if (!association) return notFound();
        const person = await scoped.lockVisiblePerson({
          id: association.personId,
          visibility: personVisibility,
          workspaceId: context.workspaceId,
        });
        const contact = await scoped.getContact({
          id: association.contactPointId,
          visibility: contactVisibility,
          workspaceId: context.workspaceId,
          lock: true,
        });
        if (!person || !contact) return notFound();
        if (
          association.version !== input.expectedVersion ||
          contact.version !== input.expectedContactVersion
        )
          return conflict(Math.max(association.version, contact.version));
        const now = new Date();
        const nextUsage = usage?.value ?? association.usageKind;
        if (input.isPrimary ?? association.isPrimary)
          await scoped.clearContactPrimary({
            actorId: context.actor.principalId,
            exceptId: association.id,
            now,
            personId: association.personId,
            usageKind: nextUsage,
            workspaceId: context.workspaceId,
          });
        const [updatedContact] = await database
          .update(contactPoints)
          .set({
            ...(prepared
              ? {
                  encryptedDisplayValue: prepared.encryptedValue,
                  blindIndex: prepared.blindIndex,
                  blindIndexVersion: 1,
                }
              : {}),
            ...(label ? { label: label.value } : {}),
            ...(input.verificationState !== undefined
              ? { verificationState: input.verificationState?.toLowerCase() }
              : {}),
            ...(input.sensitivity !== undefined
              ? { sensitivity: common.sensitivity }
              : {}),
            updatedAt: now,
            updatedBy: context.actor.principalId,
            version: sql`${contactPoints.version} + 1`,
          })
          .where(
            and(
              eq(contactPoints.workspaceId, context.workspaceId),
              eq(contactPoints.id, contact.id),
              eq(contactPoints.version, input.expectedContactVersion),
              isNull(contactPoints.deletedAt),
            ),
          )
          .returning();
        const [updatedAssociation] = await database
          .update(personContactPoints)
          .set({
            ...(usage ? { usageKind: usage.value! } : {}),
            ...(input.isPrimary !== undefined
              ? { isPrimary: input.isPrimary ?? false }
              : {}),
            ...(input.validFrom !== undefined
              ? { validFrom: common.validFrom }
              : {}),
            ...(input.validUntil !== undefined
              ? { validUntil: common.validUntil }
              : {}),
            ...(input.confidence !== undefined
              ? { confidence: String(common.confidence) }
              : {}),
            updatedAt: now,
            updatedBy: context.actor.principalId,
            version: sql`${personContactPoints.version} + 1`,
          })
          .where(
            and(
              eq(personContactPoints.workspaceId, context.workspaceId),
              eq(personContactPoints.id, association.id),
              eq(personContactPoints.version, input.expectedVersion),
              isNull(personContactPoints.deletedAt),
            ),
          )
          .returning();
        if (!updatedContact || !updatedAssociation) return conflict();
        await audit.write(database, {
          action: "contactPoint.update",
          resourceKind: "contactPoint",
          resourceId: contact.id,
          sensitivity: updatedContact.sensitivity,
          changedFields: [
            "protectedValue",
            "label",
            "verificationState",
            "association",
          ],
          metadata: {
            associationId: updatedAssociation.id,
            isPrimary: updatedAssociation.isPrimary,
            usageKind: updatedAssociation.usageKind,
            version: updatedContact.version,
          },
        });
        await applySearchIndexMaintenance(context, database, [
          {
            action: "upsert",
            sourceId: person.id,
            sourceKind: "person",
            sourceVersion: person.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return {
          resource: contactView(
            { association: updatedAssociation, contact: updatedContact },
            runtime.encryptionKey,
          ),
          issues: [],
          code: null,
        };
      });
    },

    async legacyArchivePhone(input: {
      associationId: string;
      expectedVersion: number;
      expectedContactVersion: number;
      idempotencyKey: string;
    }): Promise<MutationOutcome<ContactView>> {
      const common = validateCommon(input);
      const issues = [
        ...common.issues,
        ...versionIssues(
          { path: "expectedVersion", value: input.expectedVersion },
          {
            path: "expectedContactVersion",
            value: input.expectedContactVersion,
          },
        ),
      ];
      if (issues.length) return invalid(issues);
      return withResearchWriteTransaction(context, async (database) => {
        const scoped = createLocationsRepository(database);
        const association = await scoped.getPersonContactAssociation({
          id: input.associationId,
          workspaceId: context.workspaceId,
          lock: true,
        });
        if (!association) return notFound();
        const person = await scoped.lockVisiblePerson({
          id: association.personId,
          visibility: personVisibility,
          workspaceId: context.workspaceId,
        });
        const contact = await scoped.getContact({
          id: association.contactPointId,
          visibility: contactVisibility,
          workspaceId: context.workspaceId,
          lock: true,
        });
        if (!person || !contact) return notFound();
        if (
          association.version !== input.expectedVersion ||
          contact.version !== input.expectedContactVersion
        )
          return conflict(Math.max(association.version, contact.version));
        const now = new Date();
        const [archivedAssociation] = await database
          .update(personContactPoints)
          .set({
            deletedAt: now,
            deletedBy: context.actor.principalId,
            isPrimary: false,
            updatedAt: now,
            updatedBy: context.actor.principalId,
            version: sql`${personContactPoints.version} + 1`,
          })
          .where(
            and(
              eq(personContactPoints.workspaceId, context.workspaceId),
              eq(personContactPoints.id, association.id),
              eq(personContactPoints.version, input.expectedVersion),
              isNull(personContactPoints.deletedAt),
            ),
          )
          .returning();
        if (!archivedAssociation) return conflict();
        const [remaining] = await database
          .select({ total: count() })
          .from(personContactPoints)
          .where(
            and(
              eq(personContactPoints.workspaceId, context.workspaceId),
              eq(personContactPoints.contactPointId, contact.id),
              isNull(personContactPoints.deletedAt),
            ),
          );
        let archivedContact: ContactPointRow = contact;
        if ((remaining?.total ?? 0) === 0) {
          const [value] = await database
            .update(contactPoints)
            .set({
              deletedAt: now,
              deletedBy: context.actor.principalId,
              updatedAt: now,
              updatedBy: context.actor.principalId,
              version: sql`${contactPoints.version} + 1`,
            })
            .where(
              and(
                eq(contactPoints.workspaceId, context.workspaceId),
                eq(contactPoints.id, contact.id),
                eq(contactPoints.version, input.expectedContactVersion),
                isNull(contactPoints.deletedAt),
              ),
            )
            .returning();
          if (!value) return conflict();
          archivedContact = value;
        }
        await audit.write(database, {
          action: "contactPoint.archive",
          resourceKind: "contactPoint",
          resourceId: contact.id,
          sensitivity: contact.sensitivity,
          changedFields: ["association.deletedAt", "deletedAt"],
          metadata: {
            associationId: association.id,
            version: archivedContact.version,
          },
        });
        await applySearchIndexMaintenance(context, database, [
          {
            action: "upsert",
            sourceId: person.id,
            sourceKind: "person",
            sourceVersion: person.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return {
          resource: contactView(
            { association: archivedAssociation, contact: archivedContact },
            runtime.encryptionKey,
          ),
          issues: [],
          code: null,
        };
      });
    },

    async legacyCreatePlace(input: {
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
    }): Promise<MutationOutcome<PlaceRow>> {
      const common = validateCommon({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      const name = normalizeText(input.name, "name", 300, true);
      const kind = normalizeText(input.kind, "kind", 64, true);
      const issues = [...common.issues, ...name.issues, ...kind.issues];
      if ((input.latitude == null) !== (input.longitude == null))
        issues.push(
          issue(
            "latitude",
            "INVALID_COORDINATES",
            "Both coordinates are required.",
          ),
        );
      if (
        input.latitude != null &&
        (!Number.isFinite(input.latitude) ||
          input.latitude < -90 ||
          input.latitude > 90)
      )
        issues.push(
          issue("latitude", "INVALID_COORDINATES", "The latitude is invalid."),
        );
      if (
        input.longitude != null &&
        (!Number.isFinite(input.longitude) ||
          input.longitude < -180 ||
          input.longitude > 180)
      )
        issues.push(
          issue(
            "longitude",
            "INVALID_COORDINATES",
            "The longitude is invalid.",
          ),
        );
      if (input.countryCode && !/^[A-Za-z]{2}$/u.test(input.countryCode.trim()))
        issues.push(
          issue("countryCode", "INVALID_VALUE", "The country code is invalid."),
        );
      if (input.parentPlaceId && !UUID.test(input.parentPlaceId))
        issues.push(
          issue("parentPlaceId", "INVALID_ID", "The parent place is invalid."),
        );
      if (issues.length) return invalid(issues);
      const id = newId();
      const row = await withResearchWriteTransaction(
        context,
        async (database) => {
          const scoped = createLocationsRepository(database);
          if (input.parentPlaceId) {
            const parent = await scoped.getPlace({
              id: input.parentPlaceId,
              visibility: placeVisibility,
              workspaceId: context.workspaceId,
              lock: true,
            });
            if (!parent) return notFound();
          }
          const [created] = await database
            .insert(places)
            .values({
              id,
              workspaceId: context.workspaceId,
              name: name.value!,
              kind: kind.value!,
              parentPlaceId: input.parentPlaceId,
              countryCode: input.countryCode?.trim().toUpperCase(),
              region: input.region?.trim(),
              locality: input.locality?.trim(),
              latitude:
                input.latitude == null ? null : input.latitude.toFixed(6),
              longitude:
                input.longitude == null ? null : input.longitude.toFixed(6),
              sensitivity: common.sensitivity,
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            })
            .returning();
          if (!created) throw new Error("Place insert failed");
          await audit.write(database, {
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
            ],
            metadata: { kind: created.kind, version: created.version },
          });
          return created;
        },
      );
      return { resource: row, issues: [], code: null };
    },

    async legacyCreateAddress(input: {
      addressKind: string;
      confidence?: number | null;
      countryCode?: string | null;
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
    }): Promise<MutationOutcome<AddressView>> {
      const common = validateCommon(input);
      const addressKind = normalizeText(
        input.addressKind,
        "addressKind",
        64,
        true,
      );
      const issues = [...common.issues, ...addressKind.issues];
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
      if (input.placeId && !UUID.test(input.placeId))
        issues.push(issue("placeId", "INVALID_ID", "The place is invalid."));
      if (
        input.temporalPrecision &&
        ![
          "unknown",
          "instant",
          "second",
          "minute",
          "hour",
          "day",
          "month",
          "year",
          "range",
        ].includes(input.temporalPrecision.toLowerCase())
      )
        issues.push(
          issue(
            "temporalPrecision",
            "INVALID_ENUM",
            "The temporal precision is invalid.",
          ),
        );
      if (
        input.state &&
        !["asserted", "disputed", "disproven", "superseded"].includes(
          input.state.toLowerCase(),
        )
      )
        issues.push(
          issue("state", "INVALID_ENUM", "The address state is invalid."),
        );
      if (issues.length || !normalized) return invalid(issues);
      const addressId = newId();
      const associationId = newId();
      const row = await withResearchWriteTransaction(
        context,
        async (database) => {
          const scoped = createLocationsRepository(database);
          const person = await scoped.lockVisiblePerson({
            id: input.personId,
            visibility: personVisibility,
            workspaceId: context.workspaceId,
          });
          if (!person) return notFound();
          let place: PlaceRow | null = null;
          if (input.placeId) {
            place = await scoped.getPlace({
              id: input.placeId,
              visibility: placeVisibility,
              workspaceId: context.workspaceId,
              lock: true,
            });
            if (!place) return notFound();
          }
          const now = new Date();
          if (input.isPrimary)
            await scoped.clearAddressPrimary({
              actorId: context.actor.principalId,
              addressKind: addressKind.value!,
              now,
              personId: input.personId,
              workspaceId: context.workspaceId,
            });
          const [address] = await database
            .insert(addresses)
            .values({
              id: addressId,
              workspaceId: context.workspaceId,
              placeId: place?.id,
              ...normalized.value,
              normalizedHash: normalized.normalizedHash,
              normalizedHashVersion: 1,
              sensitivity: common.sensitivity,
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            })
            .returning();
          const [association] = await database
            .insert(personAddresses)
            .values({
              id: associationId,
              workspaceId: context.workspaceId,
              personId: input.personId,
              addressId,
              addressKind: addressKind.value!,
              validFrom: common.validFrom,
              validUntil: common.validUntil,
              temporalPrecision: (input.temporalPrecision?.toLowerCase() ??
                "unknown") as
                | "unknown"
                | "instant"
                | "second"
                | "minute"
                | "hour"
                | "day"
                | "month"
                | "year"
                | "range",
              isPrimary: input.isPrimary ?? false,
              confidence: String(common.confidence),
              state: input.state?.toLowerCase() ?? "asserted",
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            })
            .returning();
          if (!address || !association)
            throw new Error("Address insert failed");
          await audit.write(database, {
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
              associationId: association.id,
              addressKind: association.addressKind,
              isPrimary: association.isPrimary,
              version: address.version,
            },
          });
          await applySearchIndexMaintenance(context, database, [
            {
              action: "upsert",
              sourceId: association.id,
              sourceKind: "person_address",
              sourceVersion: association.version,
              workspaceId: context.workspaceId,
            },
          ]);
          return { association, address, place };
        },
      );
      return { resource: addressView(row), issues: [], code: null };
    },

    async legacyArchiveAddress(input: {
      associationId: string;
      expectedVersion: number;
      expectedAddressVersion: number;
      idempotencyKey: string;
    }): Promise<MutationOutcome<AddressView>> {
      const common = validateCommon(input);
      const issues = [
        ...common.issues,
        ...versionIssues(
          { path: "expectedVersion", value: input.expectedVersion },
          {
            path: "expectedAddressVersion",
            value: input.expectedAddressVersion,
          },
        ),
      ];
      if (issues.length) return invalid(issues);
      return withResearchWriteTransaction(context, async (database) => {
        const scoped = createLocationsRepository(database);
        const association = await scoped.getPersonAddressAssociation({
          id: input.associationId,
          workspaceId: context.workspaceId,
          lock: true,
        });
        if (!association) return notFound();
        const person = await scoped.lockVisiblePerson({
          id: association.personId,
          visibility: personVisibility,
          workspaceId: context.workspaceId,
        });
        const address = await scoped.getAddress({
          id: association.addressId,
          visibility: addressVisibility,
          workspaceId: context.workspaceId,
          lock: true,
        });
        if (!person || !address) return notFound();
        if (
          association.version !== input.expectedVersion ||
          address.version !== input.expectedAddressVersion
        )
          return conflict(Math.max(association.version, address.version));
        const now = new Date();
        const [archivedAssociation] = await database
          .update(personAddresses)
          .set({
            deletedAt: now,
            deletedBy: context.actor.principalId,
            isPrimary: false,
            updatedAt: now,
            updatedBy: context.actor.principalId,
            version: sql`${personAddresses.version} + 1`,
          })
          .where(
            and(
              eq(personAddresses.workspaceId, context.workspaceId),
              eq(personAddresses.id, association.id),
              eq(personAddresses.version, input.expectedVersion),
              isNull(personAddresses.deletedAt),
            ),
          )
          .returning();
        if (!archivedAssociation) return conflict();
        const [remaining] = await database
          .select({ total: count() })
          .from(personAddresses)
          .where(
            and(
              eq(personAddresses.workspaceId, context.workspaceId),
              eq(personAddresses.addressId, address.id),
              isNull(personAddresses.deletedAt),
            ),
          );
        let archivedAddress: AddressRow = address;
        if ((remaining?.total ?? 0) === 0) {
          const [value] = await database
            .update(addresses)
            .set({
              deletedAt: now,
              deletedBy: context.actor.principalId,
              updatedAt: now,
              updatedBy: context.actor.principalId,
              version: sql`${addresses.version} + 1`,
            })
            .where(
              and(
                eq(addresses.workspaceId, context.workspaceId),
                eq(addresses.id, address.id),
                eq(addresses.version, input.expectedAddressVersion),
                isNull(addresses.deletedAt),
              ),
            )
            .returning();
          if (!value) return conflict();
          archivedAddress = value;
        }
        const place = address.placeId
          ? await scoped.getPlace({
              id: address.placeId,
              visibility: placeVisibility,
              workspaceId: context.workspaceId,
            })
          : null;
        await audit.write(database, {
          action: "address.archive",
          resourceKind: "address",
          resourceId: address.id,
          sensitivity: address.sensitivity,
          changedFields: ["association.deletedAt", "deletedAt"],
          metadata: {
            associationId: association.id,
            version: archivedAddress.version,
          },
        });
        await applySearchIndexMaintenance(context, database, [
          {
            action: "remove",
            sourceId: association.id,
            sourceKind: "person_address",
            sourceVersion: archivedAssociation.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return {
          resource: addressView({
            association: archivedAssociation,
            address: archivedAddress,
            place,
          }),
          issues: [],
          code: null,
        };
      });
    },
    ...mutations,
    createPhone(input: Omit<CreateContactInput, "kind">) {
      return mutations.createContact({ ...input, kind: "phone" });
    },
    updatePhone(input: UpdateContactInput) {
      return mutations.updateContact(input);
    },
    archivePhone(input: ArchiveContactInput) {
      return mutations.archiveContact(input);
    },
  };
}

export type LocationsService = ReturnType<typeof createLocationsService>;
