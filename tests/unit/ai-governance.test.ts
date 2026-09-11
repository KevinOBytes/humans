import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createAiAnalysisService } from "@/modules/ai/service";

const doubles = vi.hoisted(() => ({
  material: {} as Record<string, unknown>,
  rows: [] as unknown[][],
  coverage: vi.fn(),
}));
vi.mock("@/modules/governance/coverage", () => ({
  checkPurposeCoverage: doubles.coverage,
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
vi.mock("@/modules/ai/repository", () => ({
  createAiRepository: () => ({
    insertStartedAnalysis: () => {
      throw new Error("INSERT_REACHED");
    },
  }),
}));

const personId = "019f4df3-a656-7002-9979-8946810c5bde";
const evidenceId = "019f4df3-a656-7002-9979-8946810c5bdf";
function service() {
  const database = {
    select: () => {
      const rows = doubles.rows.shift() ?? [];
      const chain = { from: () => chain, where: () => Promise.resolve(rows) };
      return chain;
    },
  };
  return createAiAnalysisService(
    {
      database,
      actor: { type: "apiKey", id: "key", principalId: personId, role: null },
      workspaceId: personId,
      permissions: new Set([
        "person:read",
        "evidence:read",
        "analysis:create",
        "analysis:run",
      ]),
    } as unknown as ResearchServiceContext,
    {
      encryptionKey: "ab".repeat(32),
      hmacKey: "cd".repeat(32),
      provider: {
        baseUrlFingerprint: "ab".repeat(32),
        disclosure: { provider: "OPENAI", model: "test" },
      },
    },
  );
}
beforeEach(() => {
  doubles.rows = [];
  doubles.coverage.mockReset().mockResolvedValue({ allowed: false });
  doubles.material = {};
});
describe("AI governance before insertion", () => {
  it.each(["public", "internal", "confidential"])(
    "requires purpose for a %s person scope",
    async (sensitivity) => {
      doubles.rows = [[{ id: personId, sensitivity }]];
      await expect(
        service().startAiAnalysis({
          question: "question",
          idempotencyKey: "key",
          scope: { personIds: [personId] },
        }),
      ).rejects.toThrow("A governed purpose is required");
    },
  );
  it("rejects restricted evidence without a covered subject", async () => {
    doubles.rows = [[{ id: evidenceId, sensitivity: "restricted" }]];
    await expect(
      service().startAiAnalysis({
        question: "question",
        idempotencyKey: "key",
        governancePurpose: "research",
        scope: { evidenceIds: [evidenceId] },
      }),
    ).rejects.toThrow("covered subject");
  });
  it("binds normalized purpose and case into the idempotency material", async () => {
    doubles.rows = [[{ id: personId, sensitivity: "public" }]];
    await expect(
      service().startAiAnalysis({
        question: "question",
        idempotencyKey: "key",
        governancePurpose: " Research ",
        governanceCaseReference: " case-1 ",
        scope: { personIds: [personId] },
      }),
    ).rejects.toThrow("Consent coverage is required");
    expect(doubles.material).toMatchObject({
      governancePurpose: "research",
      governanceCaseReference: "case-1",
    });
  });
});
