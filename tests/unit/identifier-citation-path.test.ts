import { describe, expect, it } from "vitest";
import { normalizeEvidenceAssertion } from "@/modules/evidence/assertions-validation";

const identifierId = "019f4df3-a656-7002-9979-8946810c5bde";
const input = {
  resourceKind: "person",
  locator: "page 1",
  quote: "Fictional public membership record",
  role: "supports",
  confidence: 0.8,
};

describe("identifier citation paths", () => {
  it.each([
    "identifiers",
    `identifiers.${identifierId}.value`,
    `identifiers.${identifierId}.v0.value`,
    `identifiers.${identifierId}.v01.value`,
    `identifiers.${identifierId}.v2147483648.value`,
    `identifiers.${identifierId}.v1.encryptedRawValue`,
    "identifiers.not-a-uuid.v1.value",
    `Identifiers.${identifierId}.v1.value`,
  ])(
    "rejects malformed, unversioned or storage-only identifier path %s",
    (fieldPath) => {
      expect(() =>
        normalizeEvidenceAssertion({ ...input, fieldPath }),
      ).toThrow();
    },
  );

  it("rejects an identifier path attached to a different resource kind", () => {
    expect(() =>
      normalizeEvidenceAssertion({
        ...input,
        resourceKind: "relationship",
        fieldPath: `identifiers.${identifierId}.v1.value`,
      }),
    ).toThrow();
  });

  it.each([
    "value",
    "namespace",
    "identifierType",
    "issuer",
    "validFrom",
    "validUntil",
    "verificationState",
  ])("accepts a canonical version-bound %s citation", (field) => {
    const fieldPath = `identifiers.${identifierId}.v12.${field}`;
    expect(normalizeEvidenceAssertion({ ...input, fieldPath }).fieldPath).toBe(
      fieldPath,
    );
  });
});
