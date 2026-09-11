import { describe, expect, it } from "vitest";

import {
  previewImport,
  verifyImportCommitToken,
} from "@/modules/imports/preview";

const key = "11".repeat(32);
const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const mapping = {
  version: 1,
  recordKind: "PERSON",
  rowKeySource: "external_id",
  person: {
    displayNameSource: "name",
    primaryNameKind: "preferred",
    fields: [],
  },
  facts: [],
  defaults: {},
} as const;

describe("governed import previews", () => {
  it("maps CSV in memory, preserves provenance defaults, and flags duplicates", () => {
    const preview = previewImport({
      workspaceId,
      actorPrincipalId: "principal",
      purpose: "consented demo import",
      format: "CSV",
      content: "external_id,name\n1,Alice\n",
      mapping,
      duplicateKeys: { "1": ["existing"] },
      hmacKey: key,
    });
    expect(preview.rows[0]).toMatchObject({
      externalKey: "1",
      duplicateCandidateIds: ["existing"],
    });
    expect(preview.duplicateStrategy).toBe("FLAG_ONLY");
    expect(preview.provenanceDefaults.method).toBe(
      "user_supplied_import_preview",
    );
  });
  it("binds the commit token to workspace, actor, purpose, mapping, and expiry", () => {
    const preview = previewImport({
      workspaceId,
      actorPrincipalId: "principal",
      purpose: "consented demo import",
      format: "JSON",
      content: JSON.stringify([{ external_id: "1", name: "Alice" }]),
      mapping,
      hmacKey: key,
    });
    expect(
      verifyImportCommitToken({
        token: preview.commitToken,
        workspaceId,
        actorPrincipalId: "principal",
        purpose: preview.purpose,
        mappingHash: preview.mappingHash,
        hmacKey: key,
      }),
    ).toBeDefined();
    const encodedPayload = preview.commitToken.split(".")[0];
    expect(encodedPayload).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(encodedPayload!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("hmacKey");
    expect(Object.keys(payload).sort()).toEqual([
      "actorPrincipalId",
      "caseId",
      "expiresAt",
      "mappingHash",
      "purpose",
      "version",
      "workspaceId",
    ]);
    expect(() =>
      verifyImportCommitToken({
        token: preview.commitToken,
        workspaceId: "other",
        actorPrincipalId: "principal",
        purpose: preview.purpose,
        mappingHash: "wrong",
        hmacKey: key,
      }),
    ).toThrow();
  });
});
