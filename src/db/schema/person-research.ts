import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/**
 * Immutable provenance for a person web-research attempt.
 *
 * The provider response is stored only after the response has passed the
 * bounded URL/output validation in the research service. The JSON columns are
 * intentionally a snapshot: public search results can change after a draft
 * was reviewed, so re-running a search must create a new run rather than
 * mutate the historical record.
 */
export const personWebResearchRuns = pgTable(
  "person_web_research_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    queryHash: text("query_hash").notNull(),
    sourceCount: integer("source_count").default(0).notNull(),
    sources: jsonb("sources").default([]).notNull(),
    suggestions: jsonb("suggestions").default([]).notNull(),
    consentedAt: domainTimestamp("consented_at").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("person_web_research_runs_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("person_web_research_runs_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
      table.createdAt,
    ),
    foreignKey({
      name: "person_web_research_runs_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "person_web_research_runs_source_count_check",
      sql`${table.sourceCount} BETWEEN 0 AND 5`,
    ),
    check(
      "person_web_research_runs_sources_array_check",
      sql`jsonb_typeof(${table.sources}) = 'array'`,
    ),
    check(
      "person_web_research_runs_suggestions_array_check",
      sql`jsonb_typeof(${table.suggestions}) = 'array'`,
    ),
    check(
      "person_web_research_runs_provider_length_check",
      sql`octet_length(${table.provider}) BETWEEN 1 AND 100`,
    ),
    check(
      "person_web_research_runs_model_length_check",
      sql`octet_length(${table.model}) BETWEEN 1 AND 200`,
    ),
    check(
      "person_web_research_runs_query_hash_check",
      sql`${table.queryHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type PersonWebResearchRunRow = typeof personWebResearchRuns.$inferSelect;
