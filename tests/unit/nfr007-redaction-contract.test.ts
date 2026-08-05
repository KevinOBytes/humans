// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  productionSecurityEventLogger,
  redactSecurityEvent,
} from "@/lib/observability/security-events";
import { redactAuditDiff } from "@/modules/audit/redaction";

const requestId = "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1";

describe("NFR-007 redaction boundaries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("allowlists audit metadata and never copies protected values", () => {
    const redacted = redactAuditDiff({
      changedFields: [
        "password",
        "privateContent",
        "password",
        "not-a-field",
        "state",
      ],
      metadata: {
        state: "active",
        status: "success",
        version: 2,
        sensitivity: "restricted",
        token: "audit-token-secret",
        password: "correct horse battery staple",
        totpURI: "otpauth://totp/Humans?secret=TOPSECRET",
        backupCodes: ["BACKUP-ONE", "BACKUP-TWO"],
        prompt: "private AI prompt",
        privateFileContent: "private file bytes",
        nested: { secret: "nested-secret" },
      },
      sensitivity: "public",
    });

    expect(redacted).toEqual({
      changedFields: ["password", "privateContent", "state"],
      metadata: {
        sensitivity: "restricted",
        state: "active",
        status: "success",
        version: 2,
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("audit-token-secret");
    expect(serialized).not.toContain("correct horse battery staple");
    expect(serialized).not.toContain("TOPSECRET");
    expect(serialized).not.toContain("BACKUP-ONE");
    expect(serialized).not.toContain("private AI prompt");
    expect(serialized).not.toContain("private file bytes");
    expect(serialized).not.toContain("nested-secret");
  });

  it("collapses restricted audit metadata to changed-field markers", () => {
    expect(
      redactAuditDiff({
        changedFields: ["secret", "value"],
        metadata: { state: "active", version: 4 },
        sensitivity: "restricted",
      }),
    ).toEqual({
      changed: [
        { changed: true, field: "secret" },
        { changed: true, field: "value" },
      ],
    });
  });

  it("drops accidental logger fields before console serialization", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const unsafe = {
      event: "auth.registration.allowed",
      requestId,
      severity: "info",
      password: "password-secret",
      token: "session-token-secret",
      totpURI: "otpauth://totp/Humans?secret=TOPSECRET",
      backupCodes: ["BACKUP-ONE"],
      prompt: "private prompt",
    } as unknown as Parameters<typeof productionSecurityEventLogger.log>[0];

    const safe = redactSecurityEvent(unsafe);
    productionSecurityEventLogger.log(unsafe);

    expect(safe).toEqual({
      event: "auth.registration.allowed",
      requestId,
      severity: "info",
    });
    expect(info).toHaveBeenCalledWith(safe);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(
      /password-secret|session-token-secret|TOPSECRET|BACKUP-ONE|private prompt/iu,
    );
  });

  it("keeps invitation rejection reasons closed and correlation safe", () => {
    const safe = redactSecurityEvent({
      event: "auth.invitation.acceptance_rejected",
      reason: "UNAVAILABLE",
      requestId,
      severity: "warn",
      leaked: "provider-token",
    } as unknown as Parameters<typeof redactSecurityEvent>[0]);

    expect(safe).toEqual({
      event: "auth.invitation.acceptance_rejected",
      reason: "UNAVAILABLE",
      requestId,
      severity: "warn",
    });
    expect(JSON.stringify(safe)).not.toContain("provider-token");
  });

  it("fails closed for an unknown event shape", () => {
    expect(
      redactSecurityEvent({
        event: "future.event",
        severity: "info",
        password: "future-password",
      } as unknown as Parameters<typeof redactSecurityEvent>[0]),
    ).toEqual({ event: "auth.infrastructure.failure", severity: "error" });
  });

  it.each([null, undefined, "not-an-event", 42, Symbol("event")])(
    "fails closed for malformed logger input: %s",
    (input) => {
      expect(redactSecurityEvent(input)).toEqual({
        event: "auth.infrastructure.failure",
        severity: "error",
      });
    },
  );

  it("returns a fresh fallback object for each malformed event", () => {
    const first = redactSecurityEvent(null);
    (first as { event: string }).event = "mutated.event";
    expect(redactSecurityEvent(null)).toEqual({
      event: "auth.infrastructure.failure",
      severity: "error",
    });
  });
});
