import { describe, expect, it } from "vitest";
import * as service from "@/modules/people/service";
import { openSealedEnvelope } from "@/lib/security/sealed-envelope";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

const runtime = {
  blindIndexKey: "12".repeat(32),
  encryptionKey: "34".repeat(32),
};
const workspaceId = "019fe224-a0cd-76e4-92ac-9d27a5c62cf4";
const input = {
  namespace: " Registry ",
  identifierType: "profile",
  value: " ＡＢ-42 ",
  sensitivity: "public",
};

describe("identifier write preparation", () => {
  it("normalizes public values and removes all protected storage columns", () => {
    expect(
      service.prepareIdentifierWrite(input, { workspaceId }),
    ).toMatchObject({
      namespace: "registry",
      normalizedValue: "AB-42",
      encryptedRawValue: null,
      blindIndex: null,
      blindIndexVersion: 1,
    });
  });
  it("seals non-public values and never retains normalized plaintext", () => {
    const row = service.prepareIdentifierWrite(
      { ...input, sensitivity: "confidential" },
      { workspaceId, protectedExactRuntime: runtime },
    );
    expect(row.normalizedValue).toBeNull();
    expect(row.blindIndex).toMatch(/^[0-9a-f]{64}$/);
    expect(
      openSealedEnvelope({
        key: runtime.encryptionKey,
        purpose: "protected-person-identifier",
        token: row.encryptedRawValue!,
      }),
    ).toBe("AB-42");
  });
  it("fails closed without encryption keys", () => {
    expect(() =>
      service.prepareIdentifierWrite(
        { ...input, sensitivity: "internal" },
        { workspaceId },
      ),
    ).toThrow("Protected identifier storage is not configured.");
  });
  it.each([
    { namespace: "bad namespace" },
    { value: "\u0000" },
    { value: "" },
    { identifierType: "" },
    { sensitivity: "unknown" },
    { verificationState: "fake" },
    { validFrom: "invalid" },
    { validFrom: "2026-09-13", validUntil: "2026-09-12" },
  ])("rejects malformed identifier material %j", (patch) => {
    expect(() =>
      service.prepareIdentifierWrite({ ...input, ...patch }, { workspaceId }),
    ).toThrow("The identifier fields are invalid.");
  });

  it.each([
    "createIdentifier",
    "updateIdentifier",
    "archiveIdentifier",
  ] as const)(
    "denies %s before touching persistence when the caller lacks permission",
    async (method) => {
      const context: ResearchServiceContext = {
        database: {} as ResearchServiceContext["database"],
        requestId: "identifier-permission-test",
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        workspaceId,
        permissions: new Set<string>(),
        actor: {
          type: "user",
          id: "synthetic-user",
          principalId: workspaceId,
          memberId: workspaceId,
          sessionId: "synthetic-session",
          role: "viewer",
        },
      };
      await expect(
        service.createPeopleService(context)[method]({
          ...input,
          personId: workspaceId,
          id: workspaceId,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    },
  );
});
