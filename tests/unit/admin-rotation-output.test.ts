import { describe, expect, it } from "vitest";

import { formatAdminRotationResult } from "@/db/rotate-admin-password-entry";

describe("administrator rotation operator output", () => {
  it("reports the outcome without returning the administrator identifier", () => {
    const output = formatAdminRotationResult({
      userId: "019fe224-a0cd-76e4-92ac-9d28795c2cca",
      created: false,
      reconciled: true,
      passwordRotated: true,
    });

    expect(JSON.parse(output)).toEqual({
      created: false,
      reconciled: true,
      passwordRotated: true,
    });
    expect(output).not.toContain("019fe224-a0cd-76e4-92ac-9d28795c2cca");
  });
});
