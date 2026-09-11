import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchServiceContext } from "@/modules/audit/service";
import { createGovernanceService } from "@/modules/governance/service";

const doubles = vi.hoisted(() => ({
  auditWrites: 0,
  claims: new Map<
    string,
    {
      material: Record<string, unknown>;
      responseReference: Record<string, unknown>;
    }
  >(),
  inserts: 0,
  policies: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/modules/audit/service", () => ({
  createAuditService: () => ({
    write: async () => {
      doubles.auditWrites += 1;
    },
  }),
  resourceVisibilitySql: () => undefined,
}));

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

function database() {
  const tx = {
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          doubles.inserts += 1;
          const row = {
            ...value,
            id: String(value.id),
            version: 1,
            createdAt: new Date(),
          };
          doubles.policies.set(String(row.id), row);
          return [row];
        },
      }),
    }),
  };
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => {
      const row = [...doubles.policies.values()][0];
      return row ? [row] : [];
    },
  };
  return {
    transaction: async (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    select: () => selectChain,
  };
}

function service() {
  return createGovernanceService({
    actor: {
      type: "user",
      id: "user",
      principalId: "principal",
      memberId: "member",
      sessionId: "session",
      role: "owner",
    },
    database: database(),
    idempotencyHmacKey: "ab".repeat(32),
    permissions: new Set(["workspace:update"]),
    requestId: "request",
    searchIndexMaintenance: { apply: async () => undefined },
    workspaceId: "workspace",
  } as unknown as ResearchServiceContext);
}

beforeEach(() => {
  doubles.auditWrites = 0;
  doubles.claims.clear();
  doubles.inserts = 0;
  doubles.policies.clear();
});

describe("governance mutation idempotency", () => {
  const input = {
    effectiveFrom: "2026-01-01T00:00:00Z",
    idempotencyKey: "purpose-policy-key",
    lawfulBases: ["consent"],
    purpose: "research",
    state: "active" as const,
  };

  it("replays a purpose-policy create without duplicate side effects", async () => {
    const governance = service();

    const first = await governance.createPurposePolicy(input);
    const replayed = await governance.createPurposePolicy(input);

    expect(replayed.id).toBe(first.id);
    expect(doubles.inserts).toBe(1);
    expect(doubles.auditWrites).toBe(1);
  });

  it("rejects a changed purpose-policy request bound to the same key", async () => {
    const governance = service();
    await governance.createPurposePolicy(input);

    await expect(
      governance.createPurposePolicy({ ...input, purpose: "different" }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");

    expect(doubles.inserts).toBe(1);
    expect(doubles.auditWrites).toBe(1);
  });
});
