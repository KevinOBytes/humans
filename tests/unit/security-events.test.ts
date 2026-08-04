// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { productionSecurityEventLogger } from "@/lib/observability/security-events";

describe("production security event sink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits redacted correlated auth lifecycle info events", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = [
      {
        event: "auth.recovery.requested" as const,
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
        severity: "info" as const,
      },
      {
        event: "auth.registration.allowed" as const,
        requestId: "88079e5d-0d78-40b3-8171-c50831e4967e",
        severity: "info" as const,
      },
    ];

    for (const event of events) productionSecurityEventLogger.log(event);
    const denied = {
      event: "auth.registration.denied" as const,
      requestId: "297fd3ca-33d8-40e3-9506-d3f43d1f5d26",
      severity: "warn" as const,
    };
    productionSecurityEventLogger.log(denied);

    expect(info.mock.calls).toEqual(events.map((event) => [event]));
    expect(warn).toHaveBeenCalledWith(denied);
    expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toMatch(
      /email|password|token|backup|totp/iu,
    );
  });
});
