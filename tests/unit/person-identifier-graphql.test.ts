// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { schema } from "@/graphql/schema";
const { parse, validate } = createRequire(import.meta.url)(
  "graphql",
) as typeof import("graphql");

describe("identifier mutation API", () => {
  it.each(["Create", "Update", "Archive"])(
    "accepts the %s lifecycle operation with safe results",
    (action) => {
      const field = action.toLowerCase() + "PersonIdentifier";
      expect(
        validate(
          schema,
          parse(
            `mutation($input: ${action}PersonIdentifierInput!) { ${field}(input: $input) { code currentVersion issues { path code message } identifier { id version namespace value redacted issuer sensitivity verificationState validFrom validUntil } } }`,
          ),
        ),
      ).toEqual([]);
    },
  );
});
