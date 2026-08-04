import SchemaBuilder from "@pothos/core";
import ComplexityPlugin from "@pothos/plugin-complexity";
import {
  DateResolver,
  DateTimeISOResolver,
  JSONResolver,
  UUIDResolver,
} from "graphql-scalars";

import type { GraphQLContext } from "./context";
import { createGraphQLError } from "./errors";
import { MAX_BREADTH, MAX_COMPLEXITY, MAX_DEPTH } from "./limits";

export type HumansSchemaTypes = {
  Context: GraphQLContext;
  Scalars: {
    UUID: { Input: string; Output: string };
    Date: { Input: string; Output: string };
    DateTime: { Input: string; Output: string };
    JSON: { Input: unknown; Output: unknown };
  };
};

export function createSchemaBuilder() {
  const schemaBuilder = new SchemaBuilder<HumansSchemaTypes>({
    plugins: [ComplexityPlugin],
    complexity: {
      defaultComplexity: 1,
      defaultListMultiplier: 10,
      limit: {
        breadth: MAX_BREADTH,
        complexity: MAX_COMPLEXITY,
        depth: MAX_DEPTH,
      },
      complexityError: () =>
        createGraphQLError(
          "VALIDATION_FAILED",
          "Operation exceeds the allowed complexity.",
        ),
    },
  });
  schemaBuilder.addScalarType("UUID", UUIDResolver, {});
  schemaBuilder.addScalarType("Date", DateResolver, {});
  schemaBuilder.addScalarType("DateTime", DateTimeISOResolver, {});
  schemaBuilder.addScalarType("JSON", JSONResolver, {});
  return schemaBuilder;
}

export const builder = createSchemaBuilder();
