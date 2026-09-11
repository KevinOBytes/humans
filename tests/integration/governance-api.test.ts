// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";

import { GraphQLFixture } from "../support/graphql";

describe("governance GraphQL API", () => {
  const fixture = new GraphQLFixture();

  beforeEach(async () => {
    await fixture.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("exposes a fail-closed consent coverage query", async () => {
    const actor = await fixture.createSessionActor();
    const result = await fixture.execute({
      jar: actor.jar,
      operationName: "ConsentCoverage",
      query: /* GraphQL */ `
        query ConsentCoverage($personId: UUID!) {
          consentCoverage(
            personId: $personId
            purpose: "research"
            scope: WRITE
          ) {
            allowed
            reason
            consentRecordId
            policyId
          }
        }
      `,
      variables: { personId: newId() },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.consentCoverage).toEqual({
      allowed: false,
      reason: "MISSING_CONSENT",
      consentRecordId: null,
      policyId: null,
    });
  });
});
