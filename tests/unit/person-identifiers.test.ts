import { describe, expect, it } from "vitest";

import { projectPersonIdentifier } from "@/modules/people/service";
import type { PersonIdentifierRow } from "@/modules/people/repository";

const baseIdentifier: PersonIdentifierRow = {
  id: "019fe224-a0cd-76e4-92ac-9d28795c2cca",
  workspaceId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf4",
  personId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
  namespace: "public-registry",
  identifierType: "profile",
  encryptedRawValue: "sealed-value-must-never-leave-the-server",
  normalizedValue: "https://example.invalid/profile/42",
  blindIndex: "a".repeat(64),
  blindIndexVersion: 1,
  issuer: "Synthetic Registry",
  validFrom: null,
  validUntil: null,
  verificationState: "verified",
  sensitivity: "public",
  version: 1,
  createdAt: new Date("2026-09-12T00:00:00.000Z"),
  createdBy: "019fe224-a0cd-76e4-92ac-9d27a5c62cf6",
  updatedAt: new Date("2026-09-12T00:00:00.000Z"),
  updatedBy: "019fe224-a0cd-76e4-92ac-9d27a5c62cf6",
  deletedAt: null,
  deletedBy: null,
};

describe("person identifier profile projection", () => {
  it("returns public metadata and value without exposing storage internals", () => {
    const projection = projectPersonIdentifier(baseIdentifier);

    expect(projection).toMatchObject({
      identifierType: "profile",
      namespace: "public-registry",
      issuer: "Synthetic Registry",
      value: "https://example.invalid/profile/42",
      redacted: false,
    });
    expect(projection).not.toHaveProperty("encryptedRawValue");
    expect(projection).not.toHaveProperty("blindIndex");
    expect(projection).not.toHaveProperty("normalizedValue");
  });

  it("redacts protected values even when a caller can see identifier metadata", () => {
    const projection = projectPersonIdentifier({
      ...baseIdentifier,
      normalizedValue: "internal-value",
      sensitivity: "confidential",
    });

    expect(projection).toMatchObject({
      value: null,
      redacted: true,
      sensitivity: "confidential",
    });
    expect(JSON.stringify(projection)).not.toContain("internal-value");
    expect(JSON.stringify(projection)).not.toContain(
      "sealed-value-must-never-leave-the-server",
    );
  });

  it("marks a public identifier without a safe display value as unavailable", () => {
    expect(
      projectPersonIdentifier({ ...baseIdentifier, normalizedValue: null }),
    ).toMatchObject({ value: null, redacted: true });
  });
});
