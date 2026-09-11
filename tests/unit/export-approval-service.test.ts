import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchServiceContext } from "@/modules/audit/service";
import { createExportApprovalService } from "@/modules/exports/approval-service";

const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7001";
const requesterId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const reviewerId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7003";
const caseId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7004";
const previewHash = "a1".repeat(32);

const doubles = vi.hoisted(() => ({
  approval: null as Record<string, unknown> | null,
  auditWrites: 0,
  caseRole: null as string | null,
  caseState: "active",
  claims: new Map<
    string,
    {
      material: Record<string, unknown>;
      responseReference: Record<string, unknown>;
    }
  >(),
  inserts: 0,
  updates: 0,
}));

vi.mock("@/modules/audit/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/audit/service")>();
  return {
    ...original,
    createAuditService: () => ({
      write: async () => {
        doubles.auditWrites += 1;
        return `018f5c90-7b9a-7c1f-8e2a-${String(doubles.auditWrites).padStart(12, "0")}`;
      },
    }),
  };
});

vi.mock("@/modules/audit/transactions", () => ({
  derivePrincipalResearchIdempotency: (
    _context: unknown,
    input: {
      idempotencyKey: string;
      operation: string;
      requestMaterial: Record<string, unknown>;
    },
  ) => input,
  runPrincipalIdempotentResearchWrite: async (
    context: unknown,
    input: {
      idempotencyKey: string;
      operation: string;
      requestMaterial: Record<string, unknown>;
    },
    _permissions: unknown,
    write: (context: unknown) => Promise<Record<string, unknown>>,
  ) => {
    const identity = `${input.operation}:${input.idempotencyKey}`;
    const prior = doubles.claims.get(identity);
    if (prior) {
      if (
        JSON.stringify(prior.material) !== JSON.stringify(input.requestMaterial)
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return { replayed: true, responseReference: prior.responseReference };
    }
    const responseReference = await write(context);
    doubles.claims.set(identity, {
      material: input.requestMaterial,
      responseReference,
    });
    return { replayed: false, responseReference };
  },
}));

vi.mock("@/modules/cases/repository", () => ({
  createCasesRepository: () => ({
    get: async () =>
      doubles.caseRole
        ? { case: { state: doubles.caseState }, role: doubles.caseRole }
        : null,
  }),
}));

vi.mock("@/modules/cases/service", () => ({
  createCasesService: () => ({
    getCase: async (id: string) => {
      if (id !== caseId) throw new Error("CASE_NOT_VISIBLE");
      return { id, state: "active" };
    },
  }),
}));

function database() {
  const db = {
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          doubles.inserts += 1;
          doubles.approval = {
            ...value,
            version: 1,
            state: "requested",
            reviewedAt: null,
            reviewedByPrincipalId: null,
            decisionReason: null,
            requestAuditReference: value.requestAuditReference,
            reviewAuditReference: null,
            createdAt: new Date("2026-09-11T12:00:00.000Z"),
            updatedAt: new Date("2026-09-11T12:00:00.000Z"),
          };
          return [doubles.approval];
        },
      }),
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => (doubles.approval ? [doubles.approval] : []),
      };
      return chain;
    },
    transaction: async (write: (transaction: unknown) => unknown) => write(db),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            doubles.updates += 1;
            if (!doubles.approval) return [];
            doubles.approval = {
              ...doubles.approval,
              ...value,
              version:
                "version" in value
                  ? Number(doubles.approval.version) + 1
                  : doubles.approval.version,
            };
            return [doubles.approval];
          },
        }),
      }),
    }),
  };
  return db;
}

function context(
  input: {
    principalId?: string;
    role?: string;
    permissions?: string[];
    actorType?: "user" | "apiKey";
  } = {},
): ResearchServiceContext {
  const principalId = input.principalId ?? requesterId;
  const actor =
    input.actorType === "apiKey"
      ? ({ type: "apiKey", id: "api-key", principalId, role: null } as const)
      : ({
          type: "user",
          id: `user-${principalId}`,
          principalId,
          memberId: `member-${principalId}`,
          sessionId: `session-${principalId}`,
          role: input.role ?? "owner",
        } as const);
  return {
    actor,
    database: database() as never,
    idempotencyHmacKey: "ab".repeat(32),
    permissions: new Set(
      input.permissions ?? [
        "workspace:read",
        "workspace:update",
        "file:create",
        "search:read",
      ],
    ),
    requestId: "request",
    searchIndexMaintenance: { mode: "disabled", apply: async () => undefined },
    workspaceId,
  } as ResearchServiceContext;
}

const requestInput = {
  purpose: "investigative review",
  caseId: null,
  previewHash,
  redactionProfile: "CONFIDENTIAL" as const,
  requestReason: "Independent review is required before release.",
  expiresAt: new Date("2026-09-11T13:00:00.000Z"),
  idempotencyKey: "export-request-1",
};

beforeEach(() => {
  doubles.approval = null;
  doubles.auditWrites = 0;
  doubles.caseRole = null;
  doubles.caseState = "active";
  doubles.claims.clear();
  doubles.inserts = 0;
  doubles.updates = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00.000Z"));
});

describe("reviewed governed export approvals", () => {
  it("requires a user with the complete export permission bundle", async () => {
    await expect(
      createExportApprovalService(context({ actorType: "apiKey" })).request(
        requestInput,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      createExportApprovalService(
        context({ permissions: ["workspace:update", "search:read"] }),
      ).request(requestInput),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(doubles.inserts).toBe(0);
  });

  it("replays an identical request without duplicate rows or audits and returns only metadata", async () => {
    const service = createExportApprovalService(context());
    const first = await service.request(requestInput);
    const replay = await service.request(requestInput);

    expect(replay).toEqual(first);
    expect(doubles.inserts).toBe(1);
    expect(doubles.auditWrites).toBe(1);
    expect(first).toMatchObject({
      workspaceId,
      requestedByPrincipalId: requesterId,
      purpose: "investigative review",
      previewHash,
      redactionProfile: "CONFIDENTIAL",
      state: "requested",
      version: 1,
    });
    expect(Object.keys(first).sort()).toEqual(
      [
        "caseId",
        "createdAt",
        "decisionReason",
        "expiresAt",
        "id",
        "previewHash",
        "purpose",
        "redactionProfile",
        "requestAuditReference",
        "requestReason",
        "requestedByPrincipalId",
        "reviewAuditReference",
        "reviewedAt",
        "reviewedByPrincipalId",
        "state",
        "version",
        "workspaceId",
      ].sort(),
    );
  });

  it("rejects creator self-approval and stale optimistic versions", async () => {
    const requester = createExportApprovalService(context());
    const approval = await requester.request(requestInput);

    await expect(
      requester.review({
        id: approval.id,
        expectedVersion: 1,
        expectedPreviewHash: previewHash,
        decision: "approved",
        reason: "Self review is not independent.",
        idempotencyKey: "self-review",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });

    await expect(
      createExportApprovalService(
        context({ principalId: reviewerId, role: "admin" }),
      ).review({
        id: approval.id,
        expectedVersion: 2,
        expectedPreviewHash: previewHash,
        decision: "approved",
        reason: "The preview is appropriately minimized.",
        idempotencyKey: "stale-review",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("rejects review when the displayed preview fingerprint changed", async () => {
    const approval =
      await createExportApprovalService(context()).request(requestInput);
    await expect(
      createExportApprovalService(
        context({ principalId: reviewerId, role: "admin" }),
      ).review({
        id: approval.id,
        expectedVersion: 1,
        expectedPreviewHash: "b2".repeat(32),
        decision: "approved",
        reason: "Only the displayed fingerprint may be approved.",
        idempotencyKey: "changed-review-fingerprint",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("allows an assigned case reviewer but rejects an ordinary case member", async () => {
    const approval = await createExportApprovalService(context()).request({
      ...requestInput,
      caseId,
    });
    const reviewer = createExportApprovalService(
      context({
        principalId: reviewerId,
        role: "analyst",
        permissions: ["workspace:read", "search:read"],
      }),
    );

    doubles.caseRole = "member";
    await expect(
      reviewer.review({
        id: approval.id,
        expectedVersion: 1,
        expectedPreviewHash: previewHash,
        decision: "approved",
        reason: "Member authority must not imply review authority.",
        idempotencyKey: "member-review",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });

    doubles.caseRole = "reviewer";
    const reviewed = await reviewer.review({
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "approved",
      reason: "Case scope and redaction are appropriate.",
      idempotencyKey: "case-review",
    });
    expect(reviewed).toMatchObject({
      state: "approved",
      reviewedByPrincipalId: reviewerId,
      version: 2,
    });
  });

  it("lists only pending approvals within the reviewer's current workspace/case scope", async () => {
    const approval = await createExportApprovalService(context()).request({
      ...requestInput,
      caseId,
    });
    const reviewer = createExportApprovalService(
      context({
        principalId: reviewerId,
        role: "analyst",
        permissions: ["workspace:read"],
      }),
    );

    doubles.caseRole = "member";
    await expect(reviewer.listPending({ caseId, first: 25 })).resolves.toEqual(
      [],
    );

    doubles.caseRole = "reviewer";
    await expect(reviewer.listPending({ caseId, first: 25 })).resolves.toEqual([
      expect.objectContaining({ id: approval.id }),
    ]);

    doubles.caseState = "closed";
    await expect(reviewer.listPending({ caseId, first: 25 })).resolves.toEqual(
      [],
    );
  });

  it("replays an identical review without duplicate transitions or audits", async () => {
    const approval =
      await createExportApprovalService(context()).request(requestInput);
    const reviewer = createExportApprovalService(
      context({ principalId: reviewerId, role: "admin" }),
    );
    const input = {
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "approved" as const,
      reason: "The preview is appropriately minimized.",
      idempotencyKey: "review-replay",
    };

    const first = await reviewer.review(input);
    const replay = await reviewer.review(input);

    expect(replay).toEqual(first);
    expect(doubles.inserts).toBe(1);
    expect(doubles.auditWrites).toBe(2);
    expect(first.version).toBe(2);
  });

  it("rechecks removed and inactive case-review authority before replay disclosure", async () => {
    const approval = await createExportApprovalService(context()).request({
      ...requestInput,
      caseId,
    });
    const reviewInput = {
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "approved" as const,
      reason: "The case export was independently reviewed.",
      idempotencyKey: "case-review-replay",
    };
    doubles.caseRole = "reviewer";
    await createExportApprovalService(
      context({
        principalId: reviewerId,
        role: "analyst",
        permissions: ["workspace:read"],
      }),
    ).review(reviewInput);

    doubles.caseRole = null;
    await expect(
      createExportApprovalService(
        context({
          principalId: reviewerId,
          role: "analyst",
          permissions: ["workspace:read"],
        }),
      ).review(reviewInput),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });

    doubles.caseRole = "reviewer";
    doubles.caseState = "closed";
    await expect(
      createExportApprovalService(
        context({
          principalId: reviewerId,
          role: "analyst",
          permissions: ["workspace:read"],
        }),
      ).review(reviewInput),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rechecks a demoted workspace reviewer's authority before replay disclosure", async () => {
    const approval =
      await createExportApprovalService(context()).request(requestInput);
    const reviewInput = {
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "approved" as const,
      reason: "The workspace export was independently reviewed.",
      idempotencyKey: "workspace-review-replay",
    };
    await createExportApprovalService(
      context({ principalId: reviewerId, role: "admin" }),
    ).review(reviewInput);

    await expect(
      createExportApprovalService(
        context({
          principalId: reviewerId,
          role: "member",
          permissions: ["workspace:read"],
        }),
      ).review(reviewInput),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("returns neutral forbidden before exposing approval state or version", async () => {
    const approval =
      await createExportApprovalService(context()).request(requestInput);
    const unauthorized = createExportApprovalService(
      context({
        principalId: reviewerId,
        role: "member",
        permissions: ["workspace:read"],
      }),
    );
    const attempt = (expectedVersion: number) =>
      unauthorized.review({
        id: approval.id,
        expectedVersion,
        expectedPreviewHash: previewHash,
        decision: "approved",
        reason: "An unauthorized reader must receive a neutral denial.",
        idempotencyKey: `unauthorized-${expectedVersion}-${String(doubles.approval?.state)}`,
      });

    await expect(attempt(1)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    await expect(attempt(99)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    if (doubles.approval) doubles.approval.state = "approved";
    await expect(attempt(1)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it.each([
    ["purpose", { purpose: "different purpose" }],
    ["case", { caseId }],
    ["redaction profile", { redactionProfile: "RESTRICTED" as const }],
    ["preview hash", { previewHash: "b2".repeat(32) }],
    ["actor", { actorPrincipalId: reviewerId }],
    ["workspace", { workspaceId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7999" }],
  ])("fails closed when the %s binding changes", async (_label, change) => {
    const requester = createExportApprovalService(context());
    const approval = await requester.request(requestInput);
    await createExportApprovalService(
      context({ principalId: reviewerId, role: "admin" }),
    ).review({
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "approved",
      reason: "The preview is appropriately minimized.",
      idempotencyKey: "binding-review",
    });

    await expect(
      requester.requireApproved({
        workspaceId,
        actorPrincipalId: requesterId,
        purpose: requestInput.purpose,
        caseId: null,
        redactionProfile: requestInput.redactionProfile,
        previewHash,
        now: new Date("2026-09-11T12:30:00.000Z"),
        ...change,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });

  it("rejects an expired approval with the stable precondition error", async () => {
    const requester = createExportApprovalService(context());
    const approval = await requester.request(requestInput);
    await createExportApprovalService(
      context({ principalId: reviewerId, role: "admin" }),
    ).review({
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "approved",
      reason: "The preview is appropriately minimized.",
      idempotencyKey: "expiry-review",
    });

    await expect(
      requester.requireApproved({
        workspaceId,
        actorPrincipalId: requesterId,
        purpose: requestInput.purpose,
        caseId: null,
        redactionProfile: requestInput.redactionProfile,
        previewHash,
        now: requestInput.expiresAt,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });
});
