import { describe, expect, it } from "vitest";
import {
  normalizePrivacyRequest,
  assertPrivacyTransition,
  exportArtifactSatisfiesPrivacyRequest,
} from "@/modules/privacy/request-validation";
import {
  privacyPropagationIsComplete,
  privacyProcessors,
} from "@/modules/privacy/request-types";

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
  it("requires a purpose before creating an export request", () => {
    expect(() =>
      normalizePrivacyRequest(
        {
          requestType: "export",
          personIds: [id],
          dueAt: "2026-10-11T00:00:00Z",
          idempotencyKey: "export-without-purpose",
        },
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

  it("requires every processor result before destructive privacy completion", () => {
    const pending = privacyProcessors.map((processor) => ({
      processor,
      state: "pending" as const,
    }));
    expect(privacyPropagationIsComplete("deletion", [])).toBe(false);
    expect(privacyPropagationIsComplete("deletion", pending)).toBe(false);
    expect(
      privacyPropagationIsComplete(
        "deletion",
        pending.map((row) => ({ ...row, state: "succeeded" as const })),
      ),
    ).toBe(true);
    expect(
      privacyPropagationIsComplete(
        "deletion",
        pending.map((row, index) => ({
          ...row,
          state: index === 0 ? ("failed" as const) : ("succeeded" as const),
        })),
      ),
    ).toBe(false);
    expect(
      privacyPropagationIsComplete("access", [
        { processor: "files", state: "pending" },
      ]),
    ).toBe(true);
  });

  it("binds export-request evidence to a ready, unexpired governed artifact", () => {
    const now = new Date("2026-09-11T00:00:00Z");
    const base = {
      state: "ready",
      purpose: "subject-access",
      caseId: id,
      expiresAt: new Date("2026-09-11T00:15:00Z"),
    };
    expect(
      exportArtifactSatisfiesPrivacyRequest({
        artifact: base,
        request: { purpose: "subject-access", caseId: id },
        now,
      }),
    ).toBe(true);
    expect(
      exportArtifactSatisfiesPrivacyRequest({
        artifact: { ...base, state: "writing" },
        request: { purpose: "subject-access", caseId: id },
        now,
      }),
    ).toBe(false);
    expect(
      exportArtifactSatisfiesPrivacyRequest({
        artifact: {
          ...base,
          expiresAt: new Date("2026-09-10T23:59:59Z"),
        },
        request: { purpose: "subject-access", caseId: id },
        now,
      }),
    ).toBe(false);
    expect(
      exportArtifactSatisfiesPrivacyRequest({
        artifact: base,
        request: { purpose: "different-purpose", caseId: id },
        now,
      }),
    ).toBe(false);
  });
});
