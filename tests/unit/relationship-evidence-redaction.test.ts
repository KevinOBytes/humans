// @vitest-environment node

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import type { GraphQLContext } from "@/graphql/context";
import { schema } from "@/graphql/schema";

const relationshipId = "01984e93-7644-72c6-82d0-fda7f590580e";
const relationshipEvidenceId = "01984e93-7644-72c6-82d0-fda7f590580f";
const evidenceItemId = "01984e93-7644-72c6-82d0-fda7f5905810";
const sourceId = "01984e93-7644-72c6-82d0-fda7f5905811";
const restrictedLocator = "restricted cabinet 7";
const { graphql } = createRequire(import.meta.url)(
  "graphql",
) as typeof import("graphql");

describe("relationship evidence GraphQL redaction", () => {
  it("suppresses the locator when the evidence source projection is restricted", async () => {
    const contextValue = {
      permissions: new Set([
        "relationship:read",
        "evidence:read",
        "source:read",
      ]),
      loaders: {
        relationship: {
          load: vi.fn(async () => ({ id: relationshipId })),
        },
        relationshipEvidence: {
          load: vi.fn(async () => ({
            nodes: [
              {
                id: relationshipEvidenceId,
                relationshipId,
                evidenceItemId,
                locator: restrictedLocator,
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          })),
        },
        evidenceItem: {
          load: vi.fn(async () => ({ id: evidenceItemId, sourceId })),
        },
        source: {
          load: vi.fn(async () => null),
        },
      },
    } as unknown as GraphQLContext;

    const result = await graphql({
      schema,
      source: `query {
        relationship(id: "${relationshipId}") {
          evidence(first: 1) {
            nodes {
              locator
              evidenceItem { source { id } }
            }
          }
        }
      }`,
      contextValue,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.relationship).toEqual({
      evidence: {
        nodes: [{ locator: null, evidenceItem: { source: null } }],
      },
    });
    expect(JSON.stringify(result)).not.toContain(restrictedLocator);
  });
});
