import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { createSearchRepository } from "@/modules/search/repository";
import { normalizeSearchInput } from "@/modules/search/normalization";
import type { Database } from "@/modules/auth/bootstrap-admin";
import type { ResearchServiceContext } from "@/modules/audit/service";
import type { SQL } from "drizzle-orm";

const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const principalId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7003";
const caseId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7004";

describe("research analysis SQL projection", () => {
  it("loads real provenance metadata with active case membership predicates only for analysis", async () => {
    const statements: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const database = {
      execute: async (statement: SQL) => {
        statements.push(new PgDialect().sqlToQuery(statement));
        return [];
      },
    } as unknown as Database;
    const context: Pick<ResearchServiceContext, "actor" | "workspaceId"> = {
      workspaceId,
      actor: {
        type: "user",
        principalId,
        id: "reader",
        memberId: principalId,
        sessionId: "session",
        role: "viewer",
      },
    };
    const repository = createSearchRepository(database, context);
    const search = normalizeSearchInput({
      version: 1,
      match: { type: "text", query: "fictional" },
      kinds: ["RELATIONSHIP", "FACT", "EVIDENCE"],
      filters: {},
      first: 20,
    });
    if (search.match.type !== "text") throw new Error("Expected text query");
    await repository.searchText({
      cursor: null,
      search: { ...search, match: search.match },
      analysis: { caseId },
    });
    const query = statements[0]!;
    expect(query.sql).toContain('AS "analysis"');
    expect(query.sql).toContain('"relationships"."source_person_id"');
    expect(query.sql).toContain('"relationships"."target_person_id"');
    expect(query.sql).toContain('"sources"."reliability"');
    expect(query.sql).toContain('"case_members"."deleted_at" IS NULL');
    expect(query.sql).toContain('"case_resource_links"."deleted_at" IS NULL');
    expect(query.sql).toContain("d.sensitivity IN ('public', 'internal')");
    expect(query.params).toContain(principalId);
    expect(query.params).toContain(caseId);
    await repository.searchText({
      cursor: null,
      search: { ...search, match: search.match },
    });
    expect(statements[1]!.sql).not.toContain('AS "analysis"');
  });
});
