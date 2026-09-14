import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertIdentifierCitationStorage,
  openProtectedIdentifierCitation,
  sealProtectedIdentifierCitation,
} from "@/modules/evidence/identifier-citations";
import type { ResearchServiceContext } from "@/modules/audit/service";

const context = {
  protectedExactRuntime: {
    encryptionKey: "ab".repeat(32),
  },
} as ResearchServiceContext;

describe("protected identifier citation storage", () => {
  it("seals locator and quote without plaintext shadow copies", () => {
    const sealed = sealProtectedIdentifierCitation(context, {
      locator: "page 7",
      quote: "SYNTHETIC-PROTECTED-SECRET",
    });
    expect(sealed.encryptedLocator).not.toContain("page 7");
    expect(sealed.encryptedQuote).not.toContain("SYNTHETIC-PROTECTED-SECRET");

    const opened = openProtectedIdentifierCitation(context, {
      id: "assertion",
      locator: null,
      quote: null,
      ...sealed,
    });
    expect(opened).toMatchObject({
      locator: "page 7",
      quote: "SYNTHETIC-PROTECTED-SECRET",
    });
  });

  it("fails closed when the key is not authorized for the envelope", () => {
    const sealed = sealProtectedIdentifierCitation(context, {
      locator: "page 7",
      quote: "protected",
    });
    const wrongContext = {
      protectedExactRuntime: { encryptionKey: "cd".repeat(32) },
    } as ResearchServiceContext;
    expect(() =>
      openProtectedIdentifierCitation(wrongContext, {
        locator: null,
        quote: null,
        ...sealed,
      }),
    ).toThrow(/cannot be disclosed/i);
  });

  it("requires storage mode to match the current identifier sensitivity", () => {
    expect(() =>
      assertIdentifierCitationStorage("internal", {
        locator: "page 7",
        quote: "plaintext",
        encryptedLocator: null,
        encryptedQuote: null,
      }),
    ).toThrow(/storage is invalid/i);
    expect(() =>
      assertIdentifierCitationStorage("public", {
        locator: null,
        quote: null,
        encryptedLocator: "sealed",
        encryptedQuote: "sealed",
      }),
    ).toThrow(/storage is invalid/i);
  });
});
