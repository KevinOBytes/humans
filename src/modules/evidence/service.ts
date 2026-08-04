import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { createGraphQLError } from "@/graphql/errors";
import { decodeResearchCursor, normalizePagination } from "@/graphql/limits";
import { newId } from "@/db/id";
import { evidenceItems, notes, sources } from "@/db/schema/evidence";
import { facts as factsTable } from "@/db/schema/facts";
import { people as peopleTable } from "@/db/schema/people";
import { relationships as relationshipsTable } from "@/db/schema/relationships";
import { files as filesTable } from "@/db/schema/files";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { createFactsRepository } from "@/modules/facts/repository";
import {
  normalizeHumanText,
  normalizeTagName,
  validateBoundedJson,
  validateChecksum,
  validateColor,
  validateHttpUrl,
  validateNoteContent,
  validateUnitDecimal,
  type ValidationIssue,
} from "@/modules/facts/validation";
import { createPeopleRepository } from "@/modules/people/repository";
import type { Connection, MutationOutcome } from "@/modules/people/service";
import { createRelationshipsRepository } from "@/modules/relationships/repository";
import {
  applySearchIndexMaintenance,
  withResearchWriteTransaction,
} from "@/modules/audit/transactions";

import {
  createEvidenceRepository,
  type EvidenceExcerptRow,
  type EvidenceItemRow,
  type FactEvidenceRow,
  type FactTagRow,
  type NoteRow,
  type PersonTagRow,
  type RelationshipEvidenceRow,
  type RelationshipTagRow,
  type SourceRow,
  type TagRow,
} from "./repository";

function invalid<T>(issues: ValidationIssue[]): MutationOutcome<T> {
  return { resource: null, issues, code: "VALIDATION_FAILED" };
}

function conflict<T>(version?: number): MutationOutcome<T> {
  return {
    resource: null,
    issues: [],
    code: "CONFLICT",
    currentVersion: version,
  };
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString(
    "base64url",
  );
}

const decodeCursor = decodeResearchCursor;

function sensitivity(value: string | null | undefined, fallback = "internal") {
  const normalized = (value ?? fallback).toLowerCase();
  return ["public", "internal", "confidential", "restricted"].includes(
    normalized,
  )
    ? {
        value: normalized as SourceRow["sensitivity"],
        issues: [] as ValidationIssue[],
      }
    : {
        value: null,
        issues: [
          {
            path: ["sensitivity"],
            code: "INVALID_ENUM",
            message: "Invalid sensitivity.",
          },
        ],
      };
}

function versionIssue(value: number): ValidationIssue[] {
  return Number.isInteger(value) && value > 0
    ? []
    : [
        {
          path: ["expectedVersion"],
          code: "INVALID_VERSION",
          message: "A positive version is required.",
        },
      ];
}

export function createEvidenceService(context: ResearchServiceContext) {
  const repository = createEvidenceRepository(context.database);
  const people = createPeopleRepository(context.database);
  const facts = createFactsRepository(context.database);
  const relationships = createRelationshipsRepository(context.database);
  const audit = createAuditService(context);
  const sourceVisibility = resourceVisibilitySql(context, {
    resourceKind: "source",
    id: sources.id,
    sensitivity: sources.sensitivity,
  });
  const evidenceVisibility = resourceVisibilitySql(context, {
    resourceKind: "evidence",
    id: evidenceItems.id,
    sensitivity: evidenceItems.sensitivity,
  });
  const noteVisibility = resourceVisibilitySql(context, {
    resourceKind: "note",
    id: notes.id,
    sensitivity: notes.sensitivity,
  });
  const personVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: peopleTable.id,
    sensitivity: peopleTable.sensitivity,
  });
  const factVisibility = resourceVisibilitySql(context, {
    resourceKind: "fact",
    id: factsTable.id,
    sensitivity: factsTable.sensitivity,
  });
  const relationshipVisibility = resourceVisibilitySql(context, {
    resourceKind: "relationship",
    id: relationshipsTable.id,
    sensitivity: relationshipsTable.sensitivity,
  });
  const fileVisibility = resourceVisibilitySql(context, {
    resourceKind: "file",
    id: filesTable.id,
    sensitivity: filesTable.sensitivity,
  });
  const noteSubjectVisibility = or(
    and(
      isNull(notes.personId),
      isNull(notes.factId),
      isNull(notes.relationshipId),
      isNull(notes.evidenceItemId),
    ),
    context.permissions.has("person:read")
      ? and(
          isNotNull(notes.personId),
          sql`EXISTS (SELECT 1 FROM ${peopleTable}
            WHERE ${peopleTable.workspaceId} = ${notes.workspaceId}
              AND ${peopleTable.id} = ${notes.personId}
              AND ${peopleTable.deletedAt} IS NULL
              AND ${personVisibility})`,
        )
      : undefined,
    context.permissions.has("fact:read")
      ? and(
          isNotNull(notes.factId),
          sql`EXISTS (SELECT 1 FROM ${factsTable}
            WHERE ${factsTable.workspaceId} = ${notes.workspaceId}
              AND ${factsTable.id} = ${notes.factId}
              AND ${factsTable.deletedAt} IS NULL
              AND ${factVisibility})`,
        )
      : undefined,
    context.permissions.has("relationship:read")
      ? and(
          isNotNull(notes.relationshipId),
          sql`EXISTS (SELECT 1 FROM ${relationshipsTable}
            WHERE ${relationshipsTable.workspaceId} = ${notes.workspaceId}
              AND ${relationshipsTable.id} = ${notes.relationshipId}
              AND ${relationshipsTable.deletedAt} IS NULL
              AND ${relationshipVisibility})`,
        )
      : undefined,
    context.permissions.has("evidence:read")
      ? and(
          isNotNull(notes.evidenceItemId),
          sql`EXISTS (SELECT 1 FROM ${evidenceItems}
            WHERE ${evidenceItems.workspaceId} = ${notes.workspaceId}
              AND ${evidenceItems.id} = ${notes.evidenceItemId}
              AND ${evidenceItems.deletedAt} IS NULL
              AND ${evidenceVisibility})`,
        )
      : undefined,
  );

  async function visible(
    kind: string,
    row: { id: string; sensitivity: SourceRow["sensitivity"] },
  ): Promise<boolean> {
    return canAccessResource(context.database, context, {
      id: row.id,
      resourceKind: kind,
      sensitivity: row.sensitivity,
    });
  }

  async function requireSource(id: string): Promise<SourceRow> {
    const row = await repository.getSource({
      workspaceId: context.workspaceId,
      id,
    });
    if (!row || !(await visible("source", row)))
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    return row;
  }

  async function requireEvidence(id: string): Promise<EvidenceItemRow> {
    const row = await repository.getEvidence({
      workspaceId: context.workspaceId,
      id,
    });
    if (!row || !(await visible("evidence", row)))
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    return row;
  }

  async function requireAvailableFile(id: string) {
    const [row] = await context.database
      .select()
      .from(filesTable)
      .where(
        and(
          eq(filesTable.workspaceId, context.workspaceId),
          eq(filesTable.id, id),
          isNull(filesTable.deletedAt),
          fileVisibility,
        ),
      )
      .limit(1);
    if (
      !row ||
      row.quarantineState !== "available" ||
      !["clean", "not_required"].includes(row.scanState)
    ) {
      throw createGraphQLError(
        row ? "PRECONDITION_FAILED" : "NOT_FOUND",
        row
          ? "The file is not available for attachment."
          : "The requested resource was not found.",
      );
    }
    return row;
  }

  async function subjectVisible(
    kind: "person" | "fact" | "relationship",
    id: string,
  ): Promise<boolean> {
    const row =
      kind === "person"
        ? await people.getById({ workspaceId: context.workspaceId, id })
        : kind === "fact"
          ? await facts.getFact({ workspaceId: context.workspaceId, id })
          : await relationships.get({ workspaceId: context.workspaceId, id });
    return Boolean(row && (await visible(kind, row)));
  }

  async function requireSubject(
    kind: "person" | "fact" | "relationship",
    id: string,
  ): Promise<void> {
    if (!(await subjectVisible(kind, id)))
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
  }

  function noteSubject(row: NoteRow): {
    kind: "person" | "fact" | "relationship" | "evidence";
    id: string;
  } | null {
    if (row.personId) return { kind: "person", id: row.personId };
    if (row.factId) return { kind: "fact", id: row.factId };
    if (row.relationshipId)
      return { kind: "relationship", id: row.relationshipId };
    if (row.evidenceItemId) return { kind: "evidence", id: row.evidenceItemId };
    return null;
  }

  async function noteSubjectAccessible(row: NoteRow): Promise<boolean> {
    const subject = noteSubject(row);
    if (!subject) return true;
    if (!context.permissions.has(`${subject.kind}:read`)) return false;
    return subject.kind === "evidence"
      ? Boolean(
          await repository
            .getEvidence({
              workspaceId: context.workspaceId,
              id: subject.id,
            })
            .then((evidence) =>
              evidence ? visible("evidence", evidence) : false,
            ),
        )
      : subjectVisible(subject.kind, subject.id);
  }

  async function requireNoteSubjectMutation(
    kind: "person" | "fact" | "relationship" | "evidence",
    id: string,
  ): Promise<void> {
    if (!context.permissions.has(`${kind}:read`))
      throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
    if (kind === "evidence") await requireEvidence(id);
    else await requireSubject(kind, id);
  }

  return {
    async canReadFile(id: string): Promise<boolean> {
      const row = await facts.getResourceReference({
        workspaceId: context.workspaceId,
        kind: "file",
        id,
      });
      return Boolean(
        row &&
        (await canAccessResource(context.database, context, {
          id: row.id,
          resourceKind: "file",
          sensitivity: row.sensitivity,
        })),
      );
    },
    async getSource(id: string) {
      const row = await repository.getSource({
        workspaceId: context.workspaceId,
        id,
        visibility: sourceVisibility,
      });
      return row;
    },
    async getSourcesByIds(ids: readonly string[]) {
      const rows = await repository.getSourcesByIds({
        workspaceId: context.workspaceId,
        ids,
        visibility: sourceVisibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listSources(input: {
      first?: number | null;
      after?: string | null;
      kind?: string | null;
      sensitivity?: string | null;
    }): Promise<Connection<SourceRow>> {
      const page = normalizePagination(input);
      const kind = input.kind
        ? normalizeHumanText(input.kind, {
            path: ["filter", "kind"],
            min: 1,
            max: 100,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      if (kind.issues.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The source filter is invalid.",
        );
      const decoded = decodeCursor(page.after, "source-created-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const chunkSize = Math.min(101, page.first + 1);
      const rows = await repository.listSources({
        workspaceId: context.workspaceId,
        limit: chunkSize,
        cursor,
        visibility: sourceVisibility,
        kind: kind.value,
        sensitivity: input.sensitivity as
          SourceRow["sensitivity"] | null | undefined,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeCursor({
                o: "source-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async createSource(input: {
      kind: string;
      title: string;
      publisher?: string | null;
      author?: string | null;
      canonicalUrl?: string | null;
      citation?: string | null;
      collectionMethod?: string | null;
      collectedAt?: string | null;
      reliability?: number | null;
      sensitivity?: string | null;
      metadata?: unknown;
      contentHash?: string | null;
    }): Promise<MutationOutcome<SourceRow>> {
      const kind = normalizeHumanText(input.kind, {
        path: ["kind"],
        min: 1,
        max: 100,
      });
      const title = normalizeHumanText(input.title, {
        path: ["title"],
        min: 1,
        max: 500,
      });
      const url = validateHttpUrl(input.canonicalUrl, ["canonicalUrl"]);
      const reliability = validateUnitDecimal(input.reliability, {
        min: 0,
        max: 1,
        path: ["reliability"],
      });
      const access = sensitivity(input.sensitivity);
      const metadata = validateBoundedJson(input.metadata ?? {}, {
        objectOnly: true,
        path: ["metadata"],
      });
      const issues = [
        ...kind.issues,
        ...title.issues,
        ...url.issues,
        ...reliability.issues,
        ...access.issues,
        ...metadata.issues,
      ];
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const created = await scoped.createSource({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            kind: kind.value!,
            title: title.value!,
            publisher: input.publisher?.trim() || null,
            author: input.author?.trim() || null,
            canonicalUrl: url.value,
            citation: input.citation?.trim() || null,
            collectionMethod: input.collectionMethod?.trim() || null,
            collectedAt: input.collectedAt ? new Date(input.collectedAt) : null,
            reliability: reliability.value,
            sensitivity: access.value!,
            metadata: metadata.value,
            contentHash: input.contentHash?.trim() || null,
            createdBy: context.actor.principalId,
            updatedBy: context.actor.principalId,
          },
        });
        await audit.write(tx as unknown as typeof context.database, {
          action: "source.create",
          resourceKind: "source",
          resourceId: created.id,
          changedFields: [
            "kind",
            "title",
            "canonicalUrl",
            "reliability",
            "sensitivity",
          ],
          sensitivity: created.sensitivity,
          metadata: { version: created.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "source",
            sourceVersion: created.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async updateSource(input: {
      id: string;
      expectedVersion: number;
      title?: string | null;
      publisher?: string | null;
      author?: string | null;
      canonicalUrl?: string | null;
      citation?: string | null;
      reliability?: number | null;
      sensitivity?: string | null;
      metadata?: unknown;
    }): Promise<MutationOutcome<SourceRow>> {
      const current = await requireSource(input.id);
      const issues = versionIssue(input.expectedVersion);
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changed: string[] = [];
      if (input.title !== undefined) {
        const value = normalizeHumanText(input.title, {
          path: ["title"],
          min: 1,
          max: 500,
        });
        issues.push(...value.issues);
        if (value.value) patch.title = value.value;
        changed.push("title");
      }
      for (const key of ["publisher", "author", "citation"] as const)
        if (input[key] !== undefined) {
          patch[key] = input[key]?.trim() || null;
          changed.push(key);
        }
      if (input.canonicalUrl !== undefined) {
        const value = validateHttpUrl(input.canonicalUrl, ["canonicalUrl"]);
        issues.push(...value.issues);
        if (!value.issues.length) patch.canonicalUrl = value.value;
        changed.push("canonicalUrl");
      }
      if (input.reliability !== undefined) {
        const value = validateUnitDecimal(input.reliability, {
          min: 0,
          max: 1,
          path: ["reliability"],
        });
        issues.push(...value.issues);
        if (!value.issues.length) patch.reliability = value.value;
        changed.push("reliability");
      }
      if (input.sensitivity !== undefined) {
        const value = sensitivity(input.sensitivity);
        issues.push(...value.issues);
        if (value.value) patch.sensitivity = value.value;
        changed.push("sensitivity");
      }
      if (input.metadata !== undefined) {
        const value = validateBoundedJson(input.metadata, {
          objectOnly: true,
          path: ["metadata"],
        });
        issues.push(...value.issues);
        if (!value.issues.length) patch.metadata = value.value;
        changed.push("metadata");
      }
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const updated = await scoped.updateSource({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "source.update",
          resourceKind: "source",
          resourceId: updated.id,
          changedFields: changed,
          sensitivity: updated.sensitivity,
          metadata: { version: updated.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "source",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async archiveSource(input: {
      id: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<SourceRow>> {
      const current = await requireSource(input.id);
      const issues = versionIssue(input.expectedVersion);
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        if (
          await scoped.hasActiveEvidenceForSource({
            workspaceId: context.workspaceId,
            sourceId: current.id,
          })
        ) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The source still has active evidence items.",
          );
        }
        const archived = await scoped.archiveSource({
          workspaceId: context.workspaceId,
          id: current.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          },
        });
        if (!archived) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "source.archive",
          resourceKind: "source",
          resourceId: archived.id,
          changedFields: ["deletedAt"],
          sensitivity: archived.sensitivity,
          metadata: { version: archived.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "remove",
            sourceId: archived.id,
            sourceKind: "source",
            sourceVersion: archived.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return archived;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async getEvidence(id: string) {
      const row = await repository.getEvidence({
        workspaceId: context.workspaceId,
        id,
        visibility: evidenceVisibility,
      });
      return row;
    },
    async getEvidenceByIds(ids: readonly string[]) {
      const rows = await repository.getEvidenceByIds({
        workspaceId: context.workspaceId,
        ids,
        visibility: evidenceVisibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listEvidence(input: {
      first?: number | null;
      after?: string | null;
      sourceId?: string | null;
      reviewState?: string | null;
      sensitivity?: string | null;
    }): Promise<Connection<EvidenceItemRow>> {
      const page = normalizePagination(input);
      const decoded = decodeCursor(page.after, "evidence-created-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const chunkSize = Math.min(101, page.first + 1);
      const rows = await repository.listEvidence({
        workspaceId: context.workspaceId,
        sourceId: input.sourceId,
        limit: chunkSize,
        cursor,
        visibility: evidenceVisibility,
        sourceVisibility,
        reviewState: input.reviewState,
        sensitivity: input.sensitivity as
          EvidenceItemRow["sensitivity"] | null | undefined,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeCursor({
                o: "evidence-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async createEvidence(input: {
      sourceId: string;
      fileId?: string | null;
      externalLocator?: string | null;
      extractedText?: string | null;
      capturedAt?: string | null;
      checksum: string;
      reviewState?: string | null;
      sensitivity?: string | null;
    }): Promise<MutationOutcome<EvidenceItemRow>> {
      await requireSource(input.sourceId);
      const file = input.fileId
        ? await requireAvailableFile(input.fileId)
        : null;
      const locator = validateHttpUrl(input.externalLocator, [
        "externalLocator",
      ]);
      const checksum = validateChecksum(input.checksum, ["checksum"]);
      const access = sensitivity(input.sensitivity);
      const reviewState = (input.reviewState ?? "unreviewed").toLowerCase();
      const issues = [...locator.issues, ...checksum.issues, ...access.issues];
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
      if (issues.length) return invalid(issues);
      const sensitivityRank = {
        public: 0,
        internal: 1,
        confidential: 2,
        restricted: 3,
      } as const;
      if (
        file &&
        access.value &&
        sensitivityRank[access.value] < sensitivityRank[file.sensitivity]
      ) {
        return invalid([
          {
            path: ["sensitivity"],
            code: "SENSITIVITY_TOO_LOW",
            message: "Evidence sensitivity cannot be lower than its file.",
          },
        ]);
      }
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const created = await scoped.createEvidence({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            sourceId: input.sourceId,
            fileId: input.fileId ?? null,
            externalLocator: locator.value,
            extractedText:
              input.extractedText?.normalize("NFKC").trim() || null,
            capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
            checksum: checksum.value!,
            reviewState,
            sensitivity: access.value!,
            createdBy: context.actor.principalId,
            updatedBy: context.actor.principalId,
          },
        });
        await audit.write(tx as unknown as typeof context.database, {
          action: "evidence.create",
          resourceKind: "evidence",
          resourceId: created.id,
          changedFields: [
            "sourceId",
            "externalLocator",
            "checksum",
            "reviewState",
            "sensitivity",
          ],
          sensitivity: created.sensitivity,
          metadata: { sourceId: created.sourceId, version: created.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "evidence_item",
            sourceVersion: created.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async updateEvidence(input: {
      id: string;
      expectedVersion: number;
      externalLocator?: string | null;
      extractedText?: string | null;
      capturedAt?: string | null;
      reviewState?: string | null;
      sensitivity?: string | null;
    }): Promise<MutationOutcome<EvidenceItemRow>> {
      const current = await requireEvidence(input.id);
      const issues = versionIssue(input.expectedVersion);
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changed: string[] = [];
      if (input.externalLocator !== undefined) {
        const value = validateHttpUrl(input.externalLocator, [
          "externalLocator",
        ]);
        issues.push(...value.issues);
        if (!value.issues.length) patch.externalLocator = value.value;
        changed.push("externalLocator");
      }
      if (input.extractedText !== undefined) {
        patch.extractedText =
          input.extractedText?.normalize("NFKC").trim() || null;
        changed.push("extractedText");
      }
      if (input.capturedAt !== undefined) {
        patch.capturedAt = input.capturedAt ? new Date(input.capturedAt) : null;
        changed.push("capturedAt");
      }
      if (input.reviewState !== undefined) {
        const state = input.reviewState?.toLowerCase();
        if (
          !state ||
          ![
            "unreviewed",
            "in_review",
            "accepted",
            "rejected",
            "needs_attention",
          ].includes(state)
        )
          issues.push({
            path: ["reviewState"],
            code: "INVALID_ENUM",
            message: "Invalid review state.",
          });
        else patch.reviewState = state;
        changed.push("reviewState");
      }
      if (input.sensitivity !== undefined) {
        const value = sensitivity(input.sensitivity);
        issues.push(...value.issues);
        if (value.value) patch.sensitivity = value.value;
        changed.push("sensitivity");
      }
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const updated = await scoped.updateEvidence({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "evidence.update",
          resourceKind: "evidence",
          resourceId: updated.id,
          changedFields: changed,
          sensitivity: updated.sensitivity,
          metadata: { version: updated.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "evidence_item",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async archiveEvidence(input: {
      id: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<EvidenceItemRow>> {
      const current = await requireEvidence(input.id);
      const issues = versionIssue(input.expectedVersion);
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const archived = await scoped.updateEvidence({
          workspaceId: context.workspaceId,
          id: current.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          },
        });
        if (!archived) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "evidence.archive",
          resourceKind: "evidence",
          resourceId: archived.id,
          changedFields: ["deletedAt"],
          sensitivity: archived.sensitivity,
          metadata: { version: archived.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "remove",
            sourceId: archived.id,
            sourceKind: "evidence_item",
            sourceVersion: archived.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return archived;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async attachFile(input: {
      evidenceItemId: string;
      fileId: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<EvidenceItemRow>> {
      const current = await requireEvidence(input.evidenceItemId);
      await requireSource(current.sourceId);
      const file = await requireAvailableFile(input.fileId);
      const issues = versionIssue(input.expectedVersion);
      const rank = {
        public: 0,
        internal: 1,
        confidential: 2,
        restricted: 3,
      } as const;
      if (rank[current.sensitivity] < rank[file.sensitivity]) {
        issues.push({
          path: ["fileId"],
          code: "SENSITIVITY_TOO_LOW",
          message: "Evidence sensitivity cannot be lower than its file.",
        });
      }
      if (issues.length) return invalid(issues);
      const updated = await withResearchWriteTransaction(
        context,
        async (database) => {
          const scoped = createEvidenceRepository(database);
          const row = await scoped.updateEvidence({
            workspaceId: context.workspaceId,
            id: current.id,
            expectedVersion: input.expectedVersion,
            patch: {
              fileId: file.id,
              updatedAt: new Date(),
              updatedBy: context.actor.principalId,
            },
          });
          if (!row) return null;
          await audit.write(database, {
            action: "evidence.file.attach",
            resourceKind: "evidence",
            resourceId: row.id,
            changedFields: ["fileId"],
            sensitivity: row.sensitivity,
            metadata: { fileId: file.id, version: row.version },
          });
          await applySearchIndexMaintenance(context, database, [
            {
              action: "upsert",
              sourceId: row.id,
              sourceKind: "evidence_item",
              sourceVersion: row.version,
              workspaceId: context.workspaceId,
            },
          ]);
          return row;
        },
      );
      return updated
        ? { resource: updated, issues: [], code: null }
        : conflict(current.version);
    },
    async createExcerpt(input: {
      evidenceItemId: string;
      pageNumber?: number | null;
      startOffset?: number | null;
      endOffset?: number | null;
      startTimeMs?: number | null;
      endTimeMs?: number | null;
      locator?: string | null;
      excerpt: string;
      language?: string | null;
      checksum: string;
      redactionState?: string | null;
    }): Promise<MutationOutcome<EvidenceExcerptRow>> {
      const evidence = await requireEvidence(input.evidenceItemId);
      const excerpt = normalizeHumanText(input.excerpt, {
        path: ["excerpt"],
        min: 1,
        max: 20_000,
        allowLineBreaks: true,
      });
      const checksum = validateChecksum(input.checksum, ["checksum"]);
      const issues = [...excerpt.issues, ...checksum.issues];
      if (
        input.pageNumber != null &&
        (!Number.isInteger(input.pageNumber) || input.pageNumber < 1)
      )
        issues.push({
          path: ["pageNumber"],
          code: "INVALID_RANGE",
          message: "Page number must be positive.",
        });
      if (
        input.startOffset != null &&
        input.endOffset != null &&
        input.endOffset < input.startOffset
      )
        issues.push({
          path: ["endOffset"],
          code: "INVALID_RANGE",
          message: "End offset precedes start offset.",
        });
      if (
        input.startTimeMs != null &&
        input.endTimeMs != null &&
        input.endTimeMs < input.startTimeMs
      )
        issues.push({
          path: ["endTimeMs"],
          code: "INVALID_RANGE",
          message: "End time precedes start time.",
        });
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const created = await scoped.createExcerpt({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            evidenceItemId: evidence.id,
            pageNumber: input.pageNumber ?? null,
            startOffset: input.startOffset ?? null,
            endOffset: input.endOffset ?? null,
            startTimeMs: input.startTimeMs ?? null,
            endTimeMs: input.endTimeMs ?? null,
            locator: input.locator?.trim() || null,
            excerpt: excerpt.value!,
            language: input.language?.trim() || null,
            checksum: checksum.value!,
            redactionState: input.redactionState?.toLowerCase() || "clear",
            createdBy: context.actor.principalId,
          },
        });
        await audit.write(tx as unknown as typeof context.database, {
          action: "evidence.excerpt.create",
          resourceKind: "evidenceExcerpt",
          resourceId: created.id,
          changedFields: [
            "evidenceItemId",
            "pageNumber",
            "locator",
            "checksum",
            "redactionState",
          ],
          sensitivity: evidence.sensitivity,
          metadata: { evidenceItemId: evidence.id },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "evidence_excerpt",
            sourceVersion: 1,
            workspaceId: context.workspaceId,
          },
        ]);
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async listExcerpts(input: {
      evidenceItemId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<EvidenceExcerptRow>> {
      await requireEvidence(input.evidenceItemId);
      const page = normalizePagination(input);
      const decoded = decodeCursor(page.after, "excerpt-created-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const rows = await repository.listExcerpts({
        workspaceId: context.workspaceId,
        evidenceItemId: input.evidenceItemId,
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
            ? encodeCursor({
                o: "excerpt-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async listExcerptsForEvidenceItems(
      keys: readonly {
        evidenceItemId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<EvidenceExcerptRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decodeCursor(key.after, "excerpt-created-desc");
        const cursor =
          decoded && typeof decoded.t === "string"
            ? { createdAt: new Date(decoded.t), id: decoded.i as string }
            : null;
        if (cursor && Number.isNaN(cursor.createdAt.getTime()))
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return { pageKey, evidenceItemId: key.evidenceItemId, cursor };
      });
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listExcerptsForEvidenceItems({
        workspaceId: context.workspaceId,
        pages,
        limitPerEvidenceItem: limit,
        evidenceVisibility,
      });
      const grouped = new Map<number, EvidenceExcerptRow[]>();
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
              ? encodeCursor({
                  o: "excerpt-created-desc",
                  t: last.createdAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async linkFact(input: {
      factId: string;
      evidenceItemId: string;
      excerpt?: string | null;
      locator?: string | null;
      supportStrength?: number | null;
    }): Promise<MutationOutcome<FactEvidenceRow>> {
      await requireSubject("fact", input.factId);
      const evidence = await requireEvidence(input.evidenceItemId);
      const strength = validateUnitDecimal(input.supportStrength, {
        min: -1,
        max: 1,
        path: ["supportStrength"],
      });
      if (strength.issues.length) return invalid(strength.issues);
      const existing = await repository.getFactEvidence({
        workspaceId: context.workspaceId,
        factId: input.factId,
        evidenceItemId: input.evidenceItemId,
      });
      if (existing) {
        await context.database.transaction(async (tx) => {
          await audit.write(tx as unknown as typeof context.database, {
            action: "fact.evidence.link",
            resourceKind: "fact",
            resourceId: input.factId,
            changedFields: [],
            sensitivity: evidence.sensitivity,
            metadata: { state: "unchanged" },
          });
        });
        return { resource: existing, issues: [], code: null };
      }
      const row = await context.database.transaction(async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const created = await scoped.createFactEvidence({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            factId: input.factId,
            evidenceItemId: input.evidenceItemId,
            excerpt: input.excerpt?.normalize("NFKC").trim() || null,
            locator: input.locator?.trim() || null,
            supportStrength: strength.value,
            createdBy: context.actor.principalId,
          },
        });
        await audit.write(tx as unknown as typeof context.database, {
          action: "fact.evidence.link",
          resourceKind: "fact",
          resourceId: input.factId,
          changedFields: ["evidenceItemId", "locator", "supportStrength"],
          sensitivity: evidence.sensitivity,
          metadata: { evidenceItemId: input.evidenceItemId },
        });
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async unlinkFact(input: {
      factId: string;
      evidenceItemId: string;
    }): Promise<MutationOutcome<FactEvidenceRow>> {
      await requireSubject("fact", input.factId);
      const row = await context.database.transaction(async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const [removed] = await scoped.deleteFactEvidence({
          workspaceId: context.workspaceId,
          factId: input.factId,
          evidenceItemId: input.evidenceItemId,
        });
        if (!removed)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        await audit.write(tx as unknown as typeof context.database, {
          action: "fact.evidence.unlink",
          resourceKind: "fact",
          resourceId: input.factId,
          changedFields: ["evidenceItemId"],
          metadata: { evidenceItemId: input.evidenceItemId },
        });
        return removed;
      });
      return { resource: row, issues: [], code: null };
    },
    async listFactEvidence(input: {
      factId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<FactEvidenceRow>> {
      await requireSubject("fact", input.factId);
      const page = normalizePagination(input);
      const decoded = decodeCursor(page.after, "fact-evidence-created-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const chunkSize = Math.min(101, page.first + 1);
      const links = await repository.listFactEvidence({
        workspaceId: context.workspaceId,
        factId: input.factId,
        limit: chunkSize,
        cursor,
        evidenceVisibility,
      });
      const nodes = links.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: links.length > page.first,
          endCursor: last
            ? encodeCursor({
                o: "fact-evidence-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async listFactEvidenceForFacts(
      keys: readonly {
        factId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<FactEvidenceRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decodeCursor(key.after, "fact-evidence-created-desc");
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
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listFactEvidenceForFacts({
        workspaceId: context.workspaceId,
        pages,
        limitPerFact: limit,
        evidenceVisibility,
        factVisibility,
      });
      const grouped = new Map<number, FactEvidenceRow[]>();
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
              ? encodeCursor({
                  o: "fact-evidence-created-desc",
                  t: last.createdAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async linkRelationship(input: {
      relationshipId: string;
      evidenceItemId: string;
      locator?: string | null;
      supportStrength?: number | null;
    }): Promise<MutationOutcome<RelationshipEvidenceRow>> {
      await requireSubject("relationship", input.relationshipId);
      const evidence = await requireEvidence(input.evidenceItemId);
      const strength = validateUnitDecimal(input.supportStrength, {
        min: -1,
        max: 1,
        path: ["supportStrength"],
      });
      if (strength.issues.length) return invalid(strength.issues);
      const existing = await repository.getRelationshipEvidence({
        workspaceId: context.workspaceId,
        relationshipId: input.relationshipId,
        evidenceItemId: input.evidenceItemId,
      });
      if (existing) {
        await context.database.transaction(async (tx) => {
          await audit.write(tx as unknown as typeof context.database, {
            action: "relationship.evidence.link",
            resourceKind: "relationship",
            resourceId: input.relationshipId,
            changedFields: [],
            sensitivity: evidence.sensitivity,
            metadata: { state: "unchanged" },
          });
        });
        return { resource: existing, issues: [], code: null };
      }
      const row = await context.database.transaction(async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const created = await scoped.createRelationshipEvidence({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            relationshipId: input.relationshipId,
            evidenceItemId: input.evidenceItemId,
            locator: input.locator?.trim() || null,
            supportStrength: strength.value,
            createdBy: context.actor.principalId,
          },
        });
        await audit.write(tx as unknown as typeof context.database, {
          action: "relationship.evidence.link",
          resourceKind: "relationship",
          resourceId: input.relationshipId,
          changedFields: ["evidenceItemId", "locator", "supportStrength"],
          sensitivity: evidence.sensitivity,
          metadata: { evidenceItemId: input.evidenceItemId },
        });
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async unlinkRelationship(input: {
      relationshipId: string;
      evidenceItemId: string;
    }): Promise<MutationOutcome<RelationshipEvidenceRow>> {
      await requireSubject("relationship", input.relationshipId);
      const row = await context.database.transaction(async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const [removed] = await scoped.deleteRelationshipEvidence({
          workspaceId: context.workspaceId,
          relationshipId: input.relationshipId,
          evidenceItemId: input.evidenceItemId,
        });
        if (!removed)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        await audit.write(tx as unknown as typeof context.database, {
          action: "relationship.evidence.unlink",
          resourceKind: "relationship",
          resourceId: input.relationshipId,
          changedFields: ["evidenceItemId"],
          metadata: { evidenceItemId: input.evidenceItemId },
        });
        return removed;
      });
      return { resource: row, issues: [], code: null };
    },
    async listRelationshipEvidence(input: {
      relationshipId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<RelationshipEvidenceRow>> {
      await requireSubject("relationship", input.relationshipId);
      const page = normalizePagination(input);
      const decoded = decodeCursor(
        page.after,
        "relationship-evidence-created-desc",
      );
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const chunkSize = Math.min(101, page.first + 1);
      const links = await repository.listRelationshipEvidence({
        workspaceId: context.workspaceId,
        relationshipId: input.relationshipId,
        limit: chunkSize,
        cursor,
        evidenceVisibility,
      });
      const nodes = links.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: links.length > page.first,
          endCursor: last
            ? encodeCursor({
                o: "relationship-evidence-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async listRelationshipEvidenceForRelationships(
      keys: readonly {
        relationshipId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<RelationshipEvidenceRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decodeCursor(
          key.after,
          "relationship-evidence-created-desc",
        );
        const cursor =
          decoded && typeof decoded.t === "string"
            ? { createdAt: new Date(decoded.t), id: decoded.i as string }
            : null;
        if (cursor && Number.isNaN(cursor.createdAt.getTime()))
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return { pageKey, relationshipId: key.relationshipId, cursor };
      });
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listRelationshipEvidenceForRelationships({
        workspaceId: context.workspaceId,
        pages,
        limitPerRelationship: limit,
        evidenceVisibility,
        relationshipVisibility,
      });
      const grouped = new Map<number, RelationshipEvidenceRow[]>();
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
              ? encodeCursor({
                  o: "relationship-evidence-created-desc",
                  t: last.createdAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async getNote(id: string) {
      const row = await repository.getNote({
        workspaceId: context.workspaceId,
        id,
        visibility: noteVisibility,
        subjectVisibility: noteSubjectVisibility,
      });
      return row;
    },
    async listNotes(input: {
      first?: number | null;
      after?: string | null;
      personId?: string | null;
      factId?: string | null;
      relationshipId?: string | null;
      evidenceItemId?: string | null;
      sensitivity?: string | null;
    }): Promise<Connection<NoteRow>> {
      const page = normalizePagination(input);
      const decoded = decodeCursor(page.after, "note-updated-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { updatedAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.updatedAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const subject = (
        ["personId", "factId", "relationshipId", "evidenceItemId"] as const
      ).filter((key) => input[key]);
      if (subject.length > 1)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "Choose at most one note subject.",
        );
      if (input.personId) await requireSubject("person", input.personId);
      if (input.factId) await requireSubject("fact", input.factId);
      if (input.relationshipId)
        await requireSubject("relationship", input.relationshipId);
      if (input.evidenceItemId) await requireEvidence(input.evidenceItemId);
      const chunkSize = Math.min(101, page.first + 1);
      const rows = await repository.listNotes({
        workspaceId: context.workspaceId,
        limit: chunkSize,
        personId: input.personId,
        factId: input.factId,
        relationshipId: input.relationshipId,
        evidenceItemId: input.evidenceItemId,
        cursor,
        visibility: noteVisibility,
        subjectVisibility: noteSubjectVisibility,
        sensitivity: input.sensitivity as
          NoteRow["sensitivity"] | null | undefined,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeCursor({
                o: "note-updated-desc",
                t: last.updatedAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async listNotesForSubjects(
      keys: readonly {
        kind: "person" | "fact" | "relationship" | "evidence";
        subjectId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<NoteRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decodeCursor(key.after, "note-updated-desc");
        const cursor =
          decoded && typeof decoded.t === "string"
            ? { updatedAt: new Date(decoded.t), id: decoded.i as string }
            : null;
        if (cursor && Number.isNaN(cursor.updatedAt.getTime()))
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return {
          pageKey,
          kind: key.kind,
          subjectId: key.subjectId,
          cursor,
        };
      });
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listNotesForSubjects({
        workspaceId: context.workspaceId,
        pages,
        limitPerSubject: limit,
        visibility: noteVisibility,
        subjectVisibility: noteSubjectVisibility,
      });
      const grouped = new Map<number, NoteRow[]>();
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
              ? encodeCursor({
                  o: "note-updated-desc",
                  t: last.updatedAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async createNote(input: {
      subject?: {
        personId?: string | null;
        factId?: string | null;
        relationshipId?: string | null;
        evidenceItemId?: string | null;
      } | null;
      content: { plainText?: string | null; markdown?: string | null };
      sensitivity?: string | null;
    }): Promise<MutationOutcome<NoteRow>> {
      const subject = input.subject ?? {};
      const subjects = (
        ["personId", "factId", "relationshipId", "evidenceItemId"] as const
      ).filter((key) => subject[key]);
      const content = validateNoteContent(input.content);
      const access = sensitivity(input.sensitivity);
      const issues = [...content.issues, ...access.issues];
      if (subjects.length > 1)
        issues.push({
          path: ["subject"],
          code: "ONE_OF",
          message: "Choose at most one note subject.",
        });
      if (issues.length) return invalid(issues);
      if (subject.personId)
        await requireNoteSubjectMutation("person", subject.personId);
      if (subject.factId)
        await requireNoteSubjectMutation("fact", subject.factId);
      if (subject.relationshipId)
        await requireNoteSubjectMutation(
          "relationship",
          subject.relationshipId,
        );
      if (subject.evidenceItemId)
        await requireNoteSubjectMutation("evidence", subject.evidenceItemId);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const created = await scoped.createNote({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            personId: subject.personId ?? null,
            factId: subject.factId ?? null,
            relationshipId: subject.relationshipId ?? null,
            evidenceItemId: subject.evidenceItemId ?? null,
            ...content.value!,
            sensitivity: access.value!,
            createdBy: context.actor.principalId,
            updatedBy: context.actor.principalId,
          },
        });
        await audit.write(tx as unknown as typeof context.database, {
          action: "note.create",
          resourceKind: "note",
          resourceId: created.id,
          changedFields: ["subject", "content", "sensitivity"],
          sensitivity: created.sensitivity,
          metadata: { version: created.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "note",
            sourceVersion: created.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return created;
      });
      return { resource: row, issues: [], code: null };
    },
    async updateNote(input: {
      id: string;
      expectedVersion: number;
      content?: { plainText?: string | null; markdown?: string | null } | null;
      sensitivity?: string | null;
    }): Promise<MutationOutcome<NoteRow>> {
      const current = await repository.getNote({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        !current ||
        !(await visible("note", current)) ||
        !(await noteSubjectAccessible(current))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const issues = versionIssue(input.expectedVersion);
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changed: string[] = [];
      if (input.content) {
        const value = validateNoteContent(input.content);
        issues.push(...value.issues);
        if (!value.issues.length) Object.assign(patch, value.value);
        changed.push("content");
      }
      if (input.sensitivity !== undefined) {
        const value = sensitivity(input.sensitivity);
        issues.push(...value.issues);
        if (value.value) patch.sensitivity = value.value;
        changed.push("sensitivity");
      }
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const updated = await scoped.updateNote({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "note.update",
          resourceKind: "note",
          resourceId: updated.id,
          changedFields: changed,
          sensitivity: updated.sensitivity,
          metadata: { version: updated.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "note",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async archiveNote(input: {
      id: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<NoteRow>> {
      const current = await repository.getNote({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        !current ||
        !(await visible("note", current)) ||
        !(await noteSubjectAccessible(current))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const issues = versionIssue(input.expectedVersion);
      if (issues.length) return invalid(issues);
      const row = await withResearchWriteTransaction(context, async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const updated = await scoped.updateNote({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          },
        });
        if (!updated) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "note.archive",
          resourceKind: "note",
          resourceId: updated.id,
          changedFields: ["deletedAt"],
          sensitivity: updated.sensitivity,
          metadata: { version: updated.version },
        });
        await applySearchIndexMaintenance(context, tx, [
          {
            action: "remove",
            sourceId: updated.id,
            sourceKind: "note",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async getTag(id: string) {
      return repository.getTag({ workspaceId: context.workspaceId, id });
    },
    async getTagsByIds(ids: readonly string[]) {
      const rows = await repository.getTagsByIds({
        workspaceId: context.workspaceId,
        ids,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listTags(input: {
      first?: number | null;
      after?: string | null;
      normalizedNamePrefix?: string | null;
    }): Promise<Connection<TagRow>> {
      const page = normalizePagination(input);
      const prefix = input.normalizedNamePrefix
        ? normalizeTagName(input.normalizedNamePrefix, [
            "filter",
            "normalizedNamePrefix",
          ])
        : { value: null, issues: [] as ValidationIssue[] };
      if (prefix.issues.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The tag filter is invalid.",
        );
      const decoded = decodeCursor(page.after, "tag-name-asc");
      const cursor =
        decoded && typeof decoded.n === "string"
          ? { normalizedName: decoded.n, id: decoded.i as string }
          : null;
      if (decoded && !cursor)
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const rows = await repository.listTags({
        workspaceId: context.workspaceId,
        limit: page.first + 1,
        cursor,
        normalizedNamePrefix: prefix.value,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeCursor({
                o: "tag-name-asc",
                n: last.normalizedName,
                i: last.id,
              })
            : null,
        },
      };
    },
    async createTag(input: {
      name: string;
      color?: string | null;
      description?: string | null;
    }): Promise<MutationOutcome<TagRow>> {
      const name = normalizeHumanText(input.name, {
        path: ["name"],
        min: 1,
        max: 200,
      });
      const normalized = normalizeTagName(input.name, ["name"]);
      const color = validateColor(input.color, ["color"]);
      const issues = [...name.issues, ...normalized.issues, ...color.issues];
      if (issues.length) return invalid(issues);
      try {
        const row = await context.database.transaction(async (tx) => {
          const scoped = createEvidenceRepository(
            tx as unknown as typeof context.database,
          );
          const created = await scoped.createTag({
            workspaceId: context.workspaceId,
            value: {
              id: newId(),
              name: name.value!,
              normalizedName: normalized.value!,
              color: color.value,
              description: input.description?.normalize("NFKC").trim() || null,
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            },
          });
          await audit.write(tx as unknown as typeof context.database, {
            action: "tag.create",
            resourceKind: "tag",
            resourceId: created.id,
            changedFields: ["name", "color", "description"],
            metadata: { version: created.version },
          });
          return created;
        });
        return { resource: row, issues: [], code: null };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return conflict();
        throw error;
      }
    },
    async updateTag(input: {
      id: string;
      expectedVersion: number;
      name?: string | null;
      color?: string | null;
      description?: string | null;
    }): Promise<MutationOutcome<TagRow>> {
      const current = await repository.getTag({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const issues = versionIssue(input.expectedVersion);
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changed: string[] = [];
      if (input.name !== undefined) {
        const name = normalizeHumanText(input.name, {
          path: ["name"],
          min: 1,
          max: 200,
        });
        const normalized = normalizeTagName(input.name, ["name"]);
        issues.push(...name.issues, ...normalized.issues);
        if (name.value && normalized.value) {
          patch.name = name.value;
          patch.normalizedName = normalized.value;
        }
        changed.push("name");
      }
      if (input.color !== undefined) {
        const value = validateColor(input.color, ["color"]);
        issues.push(...value.issues);
        if (!value.issues.length) patch.color = value.value;
        changed.push("color");
      }
      if (input.description !== undefined) {
        patch.description = input.description?.normalize("NFKC").trim() || null;
        changed.push("description");
      }
      if (issues.length) return invalid(issues);
      const row = await context.database.transaction(async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const updated = await scoped.updateTag({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "tag.update",
          resourceKind: "tag",
          resourceId: updated.id,
          changedFields: changed,
          metadata: { version: updated.version },
        });
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async archiveTag(input: {
      id: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<TagRow>> {
      const current = await repository.getTag({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const issues = versionIssue(input.expectedVersion);
      if (issues.length) return invalid(issues);
      const row = await context.database.transaction(async (tx) => {
        const scoped = createEvidenceRepository(
          tx as unknown as typeof context.database,
        );
        const updated = await scoped.updateTag({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          },
        });
        if (!updated) return null;
        await audit.write(tx as unknown as typeof context.database, {
          action: "tag.archive",
          resourceKind: "tag",
          resourceId: updated.id,
          changedFields: ["deletedAt"],
          metadata: { version: updated.version },
        });
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async tagPerson(input: {
      personId: string;
      tagId: string;
    }): Promise<MutationOutcome<PersonTagRow>> {
      return tagAssociation("person", input.personId, input.tagId) as Promise<
        MutationOutcome<PersonTagRow>
      >;
    },
    async tagFact(input: {
      factId: string;
      tagId: string;
    }): Promise<MutationOutcome<FactTagRow>> {
      return tagAssociation("fact", input.factId, input.tagId) as Promise<
        MutationOutcome<FactTagRow>
      >;
    },
    async tagRelationship(input: {
      relationshipId: string;
      tagId: string;
    }): Promise<MutationOutcome<RelationshipTagRow>> {
      return tagAssociation(
        "relationship",
        input.relationshipId,
        input.tagId,
      ) as Promise<MutationOutcome<RelationshipTagRow>>;
    },
    async untagPerson(input: {
      personId: string;
      tagId: string;
    }): Promise<MutationOutcome<PersonTagRow>> {
      return untagAssociation("person", input.personId, input.tagId) as Promise<
        MutationOutcome<PersonTagRow>
      >;
    },
    async untagFact(input: {
      factId: string;
      tagId: string;
    }): Promise<MutationOutcome<FactTagRow>> {
      return untagAssociation("fact", input.factId, input.tagId) as Promise<
        MutationOutcome<FactTagRow>
      >;
    },
    async untagRelationship(input: {
      relationshipId: string;
      tagId: string;
    }): Promise<MutationOutcome<RelationshipTagRow>> {
      return untagAssociation(
        "relationship",
        input.relationshipId,
        input.tagId,
      ) as Promise<MutationOutcome<RelationshipTagRow>>;
    },
    async listPersonTags(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<TagRow>> {
      await requireSubject("person", input.personId);
      return listSubjectTags("person", input.personId, input);
    },
    async listFactTags(input: {
      factId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<TagRow>> {
      await requireSubject("fact", input.factId);
      return listSubjectTags("fact", input.factId, input);
    },
    async listRelationshipTags(input: {
      relationshipId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<TagRow>> {
      await requireSubject("relationship", input.relationshipId);
      return listSubjectTags("relationship", input.relationshipId, input);
    },
    async listTagsForSubjects(
      keys: readonly {
        kind: "person" | "fact" | "relationship";
        subjectId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<TagRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decodeCursor(key.after, "subject-tag-name-asc");
        const cursor =
          decoded && typeof decoded.n === "string"
            ? { normalizedName: decoded.n, id: decoded.i as string }
            : null;
        if (decoded && !cursor)
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return {
          pageKey,
          kind: key.kind,
          subjectId: key.subjectId,
          cursor,
        };
      });
      const limit = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listTagRowsForSubjects({
        workspaceId: context.workspaceId,
        pages,
        limitPerSubject: limit,
        personVisibility,
        factVisibility,
        relationshipVisibility,
      });
      const grouped = new Map<number, TagRow[]>();
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
              ? encodeCursor({
                  o: "subject-tag-name-asc",
                  n: last.normalizedName,
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
  };

  async function listSubjectTags(
    kind: "person" | "fact" | "relationship",
    subjectId: string,
    input: { first?: number | null; after?: string | null },
  ): Promise<Connection<TagRow>> {
    const page = normalizePagination(input);
    const decoded = decodeCursor(page.after, "subject-tag-name-asc");
    const cursor =
      decoded && typeof decoded.n === "string"
        ? { normalizedName: decoded.n, id: decoded.i as string }
        : null;
    if (decoded && !cursor)
      throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
    const wrapped =
      kind === "person"
        ? await repository.listTagRowsForPerson({
            workspaceId: context.workspaceId,
            personId: subjectId,
            limit: page.first + 1,
            cursor,
          })
        : kind === "fact"
          ? await repository.listTagRowsForFact({
              workspaceId: context.workspaceId,
              factId: subjectId,
              limit: page.first + 1,
              cursor,
            })
          : await repository.listTagRowsForRelationship({
              workspaceId: context.workspaceId,
              relationshipId: subjectId,
              limit: page.first + 1,
              cursor,
            });
    const nodes = wrapped.slice(0, page.first).map((row) => row.tag);
    const last = nodes.at(-1);
    return {
      nodes,
      pageInfo: {
        hasNextPage: wrapped.length > page.first,
        endCursor: last
          ? encodeCursor({
              o: "subject-tag-name-asc",
              n: last.normalizedName,
              i: last.id,
            })
          : null,
      },
    };
  }

  async function tagAssociation(
    kind: "person" | "fact" | "relationship",
    subjectId: string,
    tagId: string,
  ) {
    await requireSubject(kind, subjectId);
    const tag = await repository.getTag({
      workspaceId: context.workspaceId,
      id: tagId,
    });
    if (!tag)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    const row = await context.database.transaction(async (tx) => {
      const scoped = createEvidenceRepository(
        tx as unknown as typeof context.database,
      );
      const value = {
        id: newId(),
        tagId,
        createdBy: context.actor.principalId,
      };
      const created =
        kind === "person"
          ? await scoped.createPersonTag({
              workspaceId: context.workspaceId,
              value: { ...value, personId: subjectId },
            })
          : kind === "fact"
            ? await scoped.createFactTag({
                workspaceId: context.workspaceId,
                value: { ...value, factId: subjectId },
              })
            : await scoped.createRelationshipTag({
                workspaceId: context.workspaceId,
                value: { ...value, relationshipId: subjectId },
              });
      if (!created) throw new Error("Tag association failed");
      await audit.write(tx as unknown as typeof context.database, {
        action: `tag.${kind}`,
        resourceKind: kind,
        resourceId: subjectId,
        changedFields: ["tagId"],
        metadata: { tagId },
      });
      return created;
    });
    return { resource: row, issues: [], code: null };
  }

  async function untagAssociation(
    kind: "person" | "fact" | "relationship",
    subjectId: string,
    tagId: string,
  ) {
    await requireSubject(kind, subjectId);
    const tag = await repository.getTag({
      workspaceId: context.workspaceId,
      id: tagId,
    });
    if (!tag)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    const row = await context.database.transaction(async (tx) => {
      const scoped = createEvidenceRepository(
        tx as unknown as typeof context.database,
      );
      const [removed] =
        kind === "person"
          ? await scoped.deletePersonTag({
              workspaceId: context.workspaceId,
              personId: subjectId,
              tagId,
            })
          : kind === "fact"
            ? await scoped.deleteFactTag({
                workspaceId: context.workspaceId,
                factId: subjectId,
                tagId,
              })
            : await scoped.deleteRelationshipTag({
                workspaceId: context.workspaceId,
                relationshipId: subjectId,
                tagId,
              });
      await audit.write(tx as unknown as typeof context.database, {
        action: `untag.${kind}`,
        resourceKind: kind,
        resourceId: subjectId,
        changedFields: removed ? ["tagId"] : [],
        metadata: { state: removed ? "changed" : "unchanged" },
      });
      return removed ?? null;
    });
    return { resource: row, issues: [], code: null };
  }
}

export type EvidenceService = ReturnType<typeof createEvidenceService>;
