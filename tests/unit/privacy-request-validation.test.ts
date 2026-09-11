import { describe, expect, it } from "vitest";
import {
  normalizePrivacyRequest,
  assertPrivacyTransition,
} from "@/modules/privacy/request-validation";

const id = "019f0000-0000-7000-8000-000000000001";
const now = new Date("2026-09-11T00:00:00Z");
describe("privacy request validation", () => {
  it.each([
    "access",
    "correction",
    "export",
    "restriction",
    "consent_withdrawal",
    "deletion",
  ])(
    "accepts a bounded %s request with an explicit deadline",
    (requestType) => {
      expect(
        normalizePrivacyRequest(
          {
            requestType,
            purpose: "research",
            personIds: [id],
            dueAt: "2026-10-11T00:00:00Z",
            idempotencyKey: "request-1",
          },
          now,
        ),
      ).toMatchObject({ requestType, personIds: [id] });
    },
  );
  it("rejects expired deadlines, duplicate resources and empty scopes", () => {
    const base = {
      requestType: "deletion",
      personIds: [id],
      dueAt: "2026-09-10",
      idempotencyKey: "request-1",
    };
    expect(() => normalizePrivacyRequest(base, now)).toThrow();
    expect(() =>
      normalizePrivacyRequest(
        { ...base, dueAt: "2026-10-11", personIds: [id, id] },
        now,
      ),
    ).toThrow();
    expect(() =>
      normalizePrivacyRequest(
        { ...base, dueAt: "2026-10-11", personIds: [] },
        now,
      ),
    ).toThrow();
  });
  it("requires verification and independent approval", () => {
    expect(() =>
      assertPrivacyTransition({
        from: "requested",
        to: "approved",
        verified: false,
        independentReviewer: true,
      }),
    ).toThrow();
    expect(() =>
      assertPrivacyTransition({
        from: "requested",
        to: "approved",
        verified: true,
        independentReviewer: false,
      }),
    ).toThrow();
    expect(() =>
      assertPrivacyTransition({
        from: "requested",
        to: "approved",
        verified: true,
        independentReviewer: true,
      }),
    ).not.toThrow();
  });
  it("requires completion evidence and rejects terminal-state mutation", () => {
    expect(() =>
      assertPrivacyTransition({
        from: "approved",
        to: "completed",
        verified: true,
      }),
    ).toThrow();
    expect(() =>
      assertPrivacyTransition({
        from: "fulfilling",
        to: "completed",
        verified: true,
        completionEvidence: id,
      }),
    ).not.toThrow();
    expect(() =>
      assertPrivacyTransition({
        from: "completed",
        to: "cancelled",
        verified: true,
      }),
    ).toThrow();
  });
  it("blocks held destructive transitions but permits cancellation", () => {
    expect(() =>
      assertPrivacyTransition({
        from: "approved",
        to: "fulfilling",
        verified: true,
        destructive: true,
        held: true,
      }),
    ).toThrow();
    expect(() =>
      assertPrivacyTransition({
        from: "approved",
        to: "cancelled",
        verified: true,
        held: true,
      }),
    ).not.toThrow();
  });
});
