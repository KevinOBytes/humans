import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("research assignment queue schema contract", () => {
  it("defines bounded, workspace-leading queue tables and append-only events", async () => {
    const schema = await readFile(
      "src/db/schema/research-assignments.ts",
      "utf8",
    );
    const migration = await readFile("drizzle/0040_core.sql", "utf8");
    for (const field of [
      "workspaceId",
      "caseId",
      "queueKind",
      "priority",
      "status",
      "assigneePrincipalId",
      "dueAt",
      "escalationCount",
      "version",
    ])
      expect(schema).toContain(field);
    expect(schema).toContain("researchAssignmentItems");
    expect(schema).toContain("researchAssignmentEvents");
    expect(migration).toContain("research_assignment_events_no_update");
    expect(migration).toContain("research_assignment_events_no_delete");
    expect(migration).toContain("research_assignment_items_case_fk");
    expect(migration).toContain("research_assignment_items_assignee_fk");
  });

  it("publishes all queue operations through GraphQL generated documents", async () => {
    const operations = await readFile(
      "src/graphql/operations/research-assignments.graphql",
      "utf8",
    );
    const generated = await readFile("src/graphql/generated/gql.ts", "utf8");
    for (const operation of [
      "ResearchAssignments",
      "CreateResearchAssignment",
      "AssignResearchAssignment",
      "TransitionResearchAssignment",
      "EscalateResearchAssignment",
    ]) {
      expect(operations).toContain(operation);
      expect(generated).toContain(operation);
    }
  });
});
