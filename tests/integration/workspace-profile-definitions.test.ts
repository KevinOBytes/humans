// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FactCatalogDocument } from "@/graphql/generated/graphql";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("workspace rich-profile fact catalog", () => {
  let fixture: ResearchFixture;
  let initialized = false;

  beforeAll(() => {
    fixture = new ResearchFixture();
    initialized = true;
  });

  beforeEach(async () => fixture.reset());

  afterAll(async () => {
    if (initialized) await fixture.close();
  });

  it("provisions the documented profile fields for each new workspace", async () => {
    const actor = await fixture.createActor();
    const response = await fixture.execute<{
      factDefinitions: {
        nodes: Array<{
          namespace: string;
          fieldKey: string;
          label: string;
          category: string | null;
          allowedValueType: string;
          cardinality: string;
          defaultSensitivity: string;
          state: string;
        }>;
      };
    }>({
      jar: actor.jar,
      operationName: "FactCatalog",
      query: FactCatalogDocument,
      variables: { first: 20 },
    });

    expect(response.body?.errors).toBeUndefined();
    expect(response.body?.data?.factDefinitions.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "pronouns",
          label: "Pronouns",
          category: "identity",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          defaultSensitivity: "INTERNAL",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "employment",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "education",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "language",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "organization",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "birth_date",
          allowedValueType: "DATE",
          cardinality: "ONE",
          defaultSensitivity: "CONFIDENTIAL",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "custom_note",
          allowedValueType: "JSON",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
      ]),
    );
  });
});
