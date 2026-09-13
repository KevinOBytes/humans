import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createFactsService } from "@/modules/facts/service";

const doubles = vi.hoisted(() => ({
  coverage: vi.fn(),
  material: {} as Record<string, unknown>,
}));
const factId = "019f4df3-a656-7002-9979-8946810c5bde";
vi.mock("@/modules/governance/coverage", () => ({
  checkPurposeCoverage: doubles.coverage,
}));
vi.mock("@/modules/facts/repository", async (original) => ({
  ...(await original<object>()),
  createFactsRepository: () => ({
    getFact: async () => ({
      id: factId,
      personId: "person",
      factDefinitionId: "field",
      sensitivity: "restricted",
      version: 1,
    }),
    getDefinitionForUpdate: async () => ({
      id: "field",
      state: "active",
      defaultSensitivity: "public",
      allowedValueType: "text",
    }),
  }),
}));
vi.mock("@/modules/people/repository", () => ({
  createPeopleRepository: () => ({
    getById: async ({ id }: { id: string }) => ({
      id,
      sensitivity: "public",
    }),
  }),
}));
vi.mock("@/modules/audit/service", async (original) => ({
  ...(await original<object>()),
  canAccessResource: async () => true,
  visibleResourceIds: async () => new Set([factId]),
}));
vi.mock("@/modules/audit/transactions", async (original) => ({
  ...(await original<object>()),
  derivePrincipalResearchIdempotency: (
    _context: unknown,
    input: { requestMaterial: Record<string, unknown> },
  ) => {
    doubles.material = input.requestMaterial;
    return {};
  },
  runPrincipalIdempotentResearchWrite: (
    context: unknown,
    _id: unknown,
    _permissions: unknown,
    callback: (context: unknown) => unknown,
  ) => callback(context),
}));
const context = {
  actor: { type: "apiKey", id: "key", principalId: "principal", role: null },
  workspaceId: "workspace",
  permissions: new Set([
    "person:read",
    "fact:read",
    "fact:create",
    "fact:update",
  ]),
  database: {},
} as unknown as ResearchServiceContext;
beforeEach(() => {
  doubles.coverage.mockReset().mockResolvedValue({ allowed: false });
  doubles.material = {};
});
describe("fact governance service boundary", () => {
  it("does not let an ordinary caller self-assign accepted review state", async () => {
    await expect(
      createFactsService(context).create({
        personId: "person",
        definitionId: "field",
        value: { text: "claim" },
        reviewState: "accepted",
      }),
    ).rejects.toThrow("Only an authorized reviewer may accept");
  });

  it("does not allow a supersession link to cross people", async () => {
    await expect(
      createFactsService(context).create({
        personId: "another-person",
        definitionId: "field",
        value: { text: "claim" },
        supersedesFactId: factId,
      }),
    ).rejects.toThrow("The requested resource was not found");
  });

  it("does not bypass consent by downgrading a restricted fact", async () => {
    await expect(
      createFactsService(context).revise({
        id: factId,
        expectedVersion: 1,
        sensitivity: "public",
        value: { text: "changed" },
      }),
    ).rejects.toThrow("A governed purpose is required");
  });
  it.each([false, true])(
    "checks actual create sensitivity against coverage (idempotent=%s)",
    async (idempotent) => {
      const service = createFactsService(context, {
        idempotencyHmacKey: "ab".repeat(32),
      });
      const input = {
        personId: "person",
        definitionId: "field",
        sensitivity: "restricted",
        value: { text: "value" },
        governancePurpose: " Research ",
        governanceCaseReference: " case-1 ",
      };
      await expect(
        idempotent
          ? service.createIdempotent({ ...input, idempotencyKey: "key" })
          : service.create(input),
      ).rejects.toThrow("Consent coverage is required");
      expect(doubles.coverage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scope: "write",
          effectiveSensitivity: "restricted",
          purpose: "research",
          caseReference: "case-1",
        }),
      );
      if (idempotent)
        expect(doubles.material).toMatchObject({
          governancePurpose: "research",
          governanceCaseReference: "case-1",
        });
    },
  );
  it("forwards and binds normalized governance context in idempotent downgrade revisions", async () => {
    await expect(
      createFactsService(context, {
        idempotencyHmacKey: "ab".repeat(32),
      }).reviseIdempotent({
        id: factId,
        expectedVersion: 1,
        sensitivity: "public",
        governancePurpose: " Research ",
        governanceCaseReference: " case-1 ",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow("Consent coverage is required");
    expect(doubles.material).toMatchObject({
      governancePurpose: "research",
      governanceCaseReference: "case-1",
    });
    expect(doubles.coverage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: "research",
        caseReference: "case-1",
        effectiveSensitivity: "restricted",
      }),
    );
  });
});
