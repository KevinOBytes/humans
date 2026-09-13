// @vitest-environment node

import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { auditEvents } from "@/db/schema/operations";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";
import {
  BULK_EXPORT_ALERT_ROW_THRESHOLD,
  createSearchService,
} from "@/modules/search/service";
import {
  previewExport,
  type ExportPreview,
  type ExportRedactionProfile,
} from "@/modules/exports/preview";
import { createCasesService } from "@/modules/cases/service";
import { createExportApprovalService } from "@/modules/exports/approval-service";
import type {
  InternalObjectWrite,
  ObjectStore,
  SignedObjectRequest,
  UploadRequest,
} from "@/lib/storage/types";
import type { ResearchServiceContext } from "@/modules/audit/service";

import { caseContext } from "../support/cases";
import type { SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const hmacKey = "6a".repeat(32);

class ExportObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly writes: Array<{ key: string; workspaceId: string }> = [];
  failNextWrite = false;

  async createUpload(input: UploadRequest): Promise<SignedObjectRequest> {
    return {
      contentLength: input.bytes,
      expiresAt: input.sessionExpiresAt,
      headers: { "content-type": input.contentType },
      method: "PUT",
      url: "https://storage.example.test/upload",
    };
  }

  async createDownload(): Promise<SignedObjectRequest> {
    return {
      expiresAt: new Date(Date.now() + 60_000),
      headers: {},
      method: "GET",
      url: "https://storage.example.test/download",
    };
  }

  async checkReachability() {}

  async getMetadata(input: { key: string; workspaceId: string }) {
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body ? { bytes: body.byteLength, custom: {} } : null;
  }

  async openRead(input: { key: string; workspaceId: string }) {
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body
      ? { body: Readable.from([body]), bytes: body.byteLength }
      : null;
  }

  async exists(input: { key: string; workspaceId: string }) {
    return this.objects.has(`${input.workspaceId}:${input.key}`);
  }

  async delete(input: { key: string; workspaceId: string }) {
    this.objects.delete(`${input.workspaceId}:${input.key}`);
  }

  async putInternal(input: InternalObjectWrite) {
    this.writes.push({ key: input.key, workspaceId: input.workspaceId });
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("synthetic object-store interruption");
    }
    this.objects.set(
      `${input.workspaceId}:${input.key}`,
      new Uint8Array(input.content),
    );
  }
}

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `private-row-${index}`,
    sensitivity: "public" as const,
    values: { title: `Private Person ${index}` },
  }));
}

function buildPreview(input: {
  actor: SessionActor;
  caseId?: string | null;
  profile?: ExportRedactionProfile;
  rowCount: number;
}): ExportPreview {
  return previewExport({
    actorPrincipalId: input.actor.principalId,
    caseId: input.caseId,
    hmacKey,
    purpose: "consented research",
    redactionProfile: input.profile ?? "PUBLIC",
    rows: rows(input.rowCount),
    workspaceId: input.actor.workspaceId,
  });
}

liveDescribe("persistent bulk-export alerts", () => {
  let fixture: ResearchFixture;
  let store: ExportObjectStore;

  beforeAll(() => {
    fixture = new ResearchFixture();
    store = new ExportObjectStore();
  });

  beforeEach(async () => {
    await fixture.reset();
    store.objects.clear();
    store.writes.length = 0;
    store.failNextWrite = false;
  });

  afterAll(() => fixture.close());

  async function serviceFor(actor: SessionActor, preview: ExportPreview) {
    const context = await caseContext(fixture, actor);
    const service = createSearchService(
      {
        ...context,
        metrics: createTask12Metrics(disabledMetricsSink),
        operationLimiter: {
          consume: async () => ({
            allowed: true,
            remainingMicrotokens: 1_000_000,
            retryAfterMs: 0,
          }),
        },
      },
      {
        cursorHmacKey: hmacKey,
        encryptionKey: hmacKey,
        protectedLookupHmacKey: hmacKey,
        exportArtifacts: {
          objectStore: store,
          storageBucket: "private",
          storageProvider: "minio",
        },
      },
    );
    service.previewExport = async () => preview;
    return { context, service };
  }

  async function commit(input: {
    actor: SessionActor;
    idempotencyKey: string;
    preview: ExportPreview;
    query?: string;
  }) {
    const { service } = await serviceFor(input.actor, input.preview);
    return service.commitExport({
      commitToken: input.preview.commitToken,
      first: input.preview.rows.length,
      format: "JSON",
      idempotencyKey: input.idempotencyKey,
      purpose: input.preview.purpose,
      query: input.query ?? "private identity query",
      redactionProfile: input.preview.redactionProfile,
      caseId: input.preview.caseId,
    });
  }

  async function bulkAlerts(workspaceId?: string) {
    return fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "export.bulk_alert"),
          workspaceId ? eq(auditEvents.workspaceId, workspaceId) : undefined,
        ),
      );
  }

  it("alerts at the fixed threshold and does not alert below it", async () => {
    const actor = await fixture.createActor();
    const atThreshold = buildPreview({
      actor,
      rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
    });
    const belowThreshold = buildPreview({
      actor,
      rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD - 1,
    });

    await commit({
      actor,
      idempotencyKey: "bulk-at-threshold",
      preview: atThreshold,
    });
    await commit({
      actor,
      idempotencyKey: "bulk-below-threshold",
      preview: belowThreshold,
    });

    const alerts = await bulkAlerts(actor.workspaceId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      resourceKind: "export_artifact",
      workspaceId: actor.workspaceId,
      redactedDiff: {
        changedFields: ["state"],
        metadata: {
          caseScoped: false,
          redactionProfile: "PUBLIC",
          rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
          threshold: BULK_EXPORT_ALERT_ROW_THRESHOLD,
        },
      },
    });
  });

  it("emits once after interrupted recovery and not on a ready replay", async () => {
    const actor = await fixture.createActor();
    const preview = buildPreview({
      actor,
      rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
    });
    const input = {
      actor,
      idempotencyKey: "bulk-recovery",
      preview,
      query: "private recovery query",
    };

    store.failNextWrite = true;
    await expect(commit(input)).rejects.toThrow(
      "synthetic object-store interruption",
    );
    expect(await bulkAlerts(actor.workspaceId)).toHaveLength(0);

    const recovered = await commit(input);
    const replay = await commit(input);

    expect(recovered.state).toBe("ready");
    expect(replay.id).toBe(recovered.id);
    expect(await bulkAlerts(actor.workspaceId)).toHaveLength(1);
  });

  it("records bounded restricted case metadata without sensitive values", async () => {
    const actor = await fixture.createActor();
    const reviewer = await fixture.createWorkspaceMember(actor, "admin");
    const actorContext = await caseContext(fixture, actor);
    const baseReviewerContext = await caseContext(fixture, reviewer);
    if (baseReviewerContext.actor.type !== "user") {
      throw new Error("Expected a user reviewer context.");
    }
    const reviewerContext = {
      ...baseReviewerContext,
      actor: { ...baseReviewerContext.actor, role: "admin" as const },
    } satisfies ResearchServiceContext;
    const caseRow = await createCasesService(actorContext).createCase({
      title: "Private investigation title",
      purpose: "consented research",
    });
    const preview = buildPreview({
      actor,
      caseId: caseRow.id,
      profile: "RESTRICTED",
      rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
    });
    const approval = await createExportApprovalService(actorContext).request({
      caseId: caseRow.id,
      expiresAt: new Date(preview.expiresAt),
      idempotencyKey: newId(),
      previewHash: preview.previewHash,
      purpose: preview.purpose,
      redactionProfile: preview.redactionProfile,
      requestReason: "Private reviewer rationale",
    });
    await createExportApprovalService(reviewerContext).review({
      decision: "approved",
      expectedPreviewHash: preview.previewHash,
      expectedVersion: approval.version,
      id: approval.id,
      idempotencyKey: newId(),
      reason: "Private approval rationale",
    });

    await commit({
      actor,
      idempotencyKey: "restricted-case-export",
      preview,
      query: "private restricted query",
    });

    const alerts = await bulkAlerts(actor.workspaceId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.redactedDiff).toEqual({
      changedFields: ["state"],
      metadata: {
        caseScoped: true,
        redactionProfile: "RESTRICTED",
        rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
        threshold: BULK_EXPORT_ALERT_ROW_THRESHOLD,
      },
    });
    expect(JSON.stringify(alerts)).not.toMatch(
      /Private Person|private restricted query|Private investigation title|Private reviewer rationale|Private approval rationale|private-row-|exports\//u,
    );
  });

  it("keeps same-key alerts workspace-scoped and immutable", async () => {
    const first = await fixture.createActor();
    const second = await fixture.createActor();
    const rawKey = "same-raw-bulk-key";

    await commit({
      actor: first,
      idempotencyKey: rawKey,
      preview: buildPreview({
        actor: first,
        rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
      }),
    });
    await commit({
      actor: second,
      idempotencyKey: rawKey,
      preview: buildPreview({
        actor: second,
        rowCount: BULK_EXPORT_ALERT_ROW_THRESHOLD,
      }),
    });

    const all = await bulkAlerts();
    expect(all).toHaveLength(2);
    expect(await bulkAlerts(first.workspaceId)).toHaveLength(1);
    expect(await bulkAlerts(second.workspaceId)).toHaveLength(1);
    expect(new Set(all.map((row) => row.resourceId)).size).toBe(2);
    expect(new Set(store.writes.map((write) => write.workspaceId))).toEqual(
      new Set([first.workspaceId, second.workspaceId]),
    );

    await expect(
      fixture.database
        .update(auditEvents)
        .set({ outcome: "failure" })
        .where(eq(auditEvents.id, all[0]!.id)),
    ).rejects.toThrow();
    expect((await bulkAlerts()).map((row) => row.outcome)).toEqual([
      "success",
      "success",
    ]);
  });
});
