import { GraphQLEnumType } from "graphql";
import { describe, expect, it } from "vitest";

import { schema } from "@/graphql/schema";

describe("graph GraphQL schema", () => {
  it("exposes the bounded graph, saved view, and analysis contract", () => {
    const query = schema.getQueryType()?.getFields();
    const mutation = schema.getMutationType()?.getFields();
    expect(query).toHaveProperty("graph");
    expect(query).toHaveProperty("graphViews");
    expect(mutation).toHaveProperty("createGraphView");
    expect(mutation).toHaveProperty("runGraphAnalysis");
    expect(query?.graph?.args.map(({ name }) => name)).toEqual(["filter"]);
    expect(query?.graphViews?.args.map(({ name }) => name)).toEqual([
      "after",
      "first",
    ]);
    expect(String(query?.graphViews?.type)).toBe("GraphViewConnection!");
    expect(query?.graphView?.args.map(({ name }) => name)).toEqual(["id"]);
    expect(schema.getType("GraphView")?.toString()).toBe("GraphView");
    const graphView = schema.getType(
      "GraphView",
    ) as import("graphql").GraphQLObjectType;
    expect(
      graphView.getFields().positions?.args.map(({ name }) => name),
    ).toEqual(["after", "first"]);
    expect(String(graphView.getFields().positions?.type)).toBe(
      "GraphPositionConnection!",
    );
    const positions = schema.getType(
      "GraphPositionConnection",
    ) as import("graphql").GraphQLObjectType;
    expect(String(positions.getFields().nodes?.type)).toBe("[GraphPosition!]!");
    expect(String(positions.getFields().pageInfo?.type)).toBe("PageInfo!");
    expect(
      (schema.getType("GraphRelationshipState") as GraphQLEnumType)
        .getValues()
        .map(({ name, value }) => [name, value]),
    ).toEqual([
      ["ASSERTED", "asserted"],
      ["CORROBORATED", "corroborated"],
      ["DISPROVEN", "disproven"],
      ["DISPUTED", "disputed"],
      ["INACTIVE", "inactive"],
      ["INFERRED", "inferred"],
    ]);
  });
});
