// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  normalizeProtectedExactV1,
  prepareProtectedExactV1,
  type ProtectedExactInput,
} from "@/lib/security/protected-exact";
import { openSealedEnvelope } from "@/lib/security/sealed-envelope";

const blindIndexKey = "12".repeat(32);
const encryptionKey = "34".repeat(32);
const workspaceId = "019d1d34-a5a5-7c98-b8fc-24f9058ec0d1";

describe("protected exact v1", () => {
  it.each([
    [" +1 (212) 555-0199 ", "+12125550199"],
    ["００４４ ２０ ７９４６ ０９５８", "+442079460958"],
  ])("normalizes international phone formatting", (value, expected) => {
    expect(normalizeProtectedExactV1({ kind: "PHONE", value })).toEqual({
      canonicalValue: expected,
      namespace: null,
    });
  });

  it.each([
    "2125550199",
    "+0123456789",
    "+1234567",
    "+1234567890123456",
    "+1 212 555 0199 ext 4",
    "+1/212/555/0199",
    `+12125550199\u2066`,
    `+12125550199\u0085`,
    "9".repeat(65),
  ])("rejects unsupported or unsafe phone input", (value) => {
    expect(() => normalizeProtectedExactV1({ kind: "PHONE", value })).toThrow(
      /protected exact value/iu,
    );
  });

  it("normalizes only the identifier namespace and preserves value semantics", () => {
    expect(
      normalizeProtectedExactV1({
        kind: "PERSON_IDENTIFIER",
        namespace: " ＰＡＳＳＰＯＲＴ.US ",
        value: "  Ab C-123  ",
      }),
    ).toEqual({ canonicalValue: "Ab C-123", namespace: "passport.us" });
  });

  it.each([
    { kind: "PERSON_IDENTIFIER", namespace: "", value: "x" },
    { kind: "PERSON_IDENTIFIER", namespace: "bad namespace", value: "x" },
    { kind: "PERSON_IDENTIFIER", namespace: "a", value: "" },
    { kind: "PERSON_IDENTIFIER", namespace: "a", value: `x\u202e` },
    { kind: "PERSON_IDENTIFIER", namespace: "a", value: "é".repeat(129) },
  ] satisfies ProtectedExactInput[])(
    "rejects invalid identifier input",
    (input) => {
      expect(() => normalizeProtectedExactV1(input)).toThrow(
        /protected exact value/iu,
      );
    },
  );

  it("prepares a workspace-bound purpose-separated digest and sealed display value", () => {
    const lookup = {
      kind: "PERSON_IDENTIFIER" as const,
      namespace: " Passport.US ",
      value: "  Ab C-123  ",
    };
    const prepared = prepareProtectedExactV1({
      blindIndexKey,
      encryptionKey,
      lookup,
      workspaceId,
    });
    const repeated = prepareProtectedExactV1({
      blindIndexKey,
      encryptionKey,
      lookup,
      workspaceId,
    });

    expect(prepared).toMatchObject({
      blindIndexVersion: 1,
      namespace: "passport.us",
    });
    expect(prepared.blindIndex).toMatch(/^[0-9a-f]{64}$/u);
    expect(repeated.blindIndex).toBe(prepared.blindIndex);
    expect(Object.keys(prepared).sort()).toEqual([
      "blindIndex",
      "blindIndexVersion",
      "encryptedValue",
      "namespace",
    ]);
    expect(JSON.stringify(prepared)).not.toContain("Ab C-123");
    expect(
      openSealedEnvelope({
        key: encryptionKey,
        purpose: "protected-person-identifier",
        token: prepared.encryptedValue,
      }),
    ).toBe("Ab C-123");
    expect(() =>
      openSealedEnvelope({
        key: encryptionKey,
        purpose: "protected-phone",
        token: prepared.encryptedValue,
      }),
    ).toThrow();
  });

  it("separates workspaces, kinds, namespaces, keys, and component boundaries", () => {
    const digest = (lookup: ProtectedExactInput, overrides = {}) =>
      prepareProtectedExactV1({
        blindIndexKey,
        encryptionKey,
        lookup,
        workspaceId,
        ...overrides,
      }).blindIndex;
    const baseline = digest({
      kind: "PERSON_IDENTIFIER",
      namespace: "ab",
      value: "c",
    });
    expect(
      new Set([
        baseline,
        digest({ kind: "PERSON_IDENTIFIER", namespace: "a", value: "bc" }),
        digest({ kind: "PERSON_IDENTIFIER", namespace: "ab", value: "C" }),
        digest({ kind: "PHONE", value: "+12125550199" }),
        digest(
          { kind: "PERSON_IDENTIFIER", namespace: "ab", value: "c" },
          { workspaceId: "019d1d34-a5a5-7c98-b8fc-24f9058ec0d2" },
        ),
        digest(
          { kind: "PERSON_IDENTIFIER", namespace: "ab", value: "c" },
          { blindIndexKey: "56".repeat(32) },
        ),
      ]).size,
    ).toBe(6);
  });
});
