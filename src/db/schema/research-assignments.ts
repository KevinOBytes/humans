import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { cases } from "./cases";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const time = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

const attribution = () => ({
  version: integer("version").default(1).notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: time("updated_at").defaultNow().notNull(),
  updatedBy: uuid("updated_by").notNull(),
});

export const researchAssignmentItems = pgTable(
  "research_assignment_items",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id"),
    queueKind: text("queue_kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priority: integer("priority").default(0).notNull(),
    status: text("status").default("open").notNull(),
    assigneePrincipalId: uuid("assignee_principal_id"),
    dueAt: time("due_at"),
    escalationCount: integer("escalation_count").default(0).notNull(),
    ...attribution(),
  },
  (t) => [
    unique("research_assignment_items_workspace_id_unique").on(
      t.workspaceId,
      t.id,
    ),
    index("research_assignment_items_queue_idx").on(
      t.workspaceId,
      t.status,
      t.priority,
      t.dueAt,
      t.id,
    ),
    index("research_assignment_items_case_idx").on(
      t.workspaceId,
      t.caseId,
      t.status,
      t.id,
    ),
    foreignKey({
      name: "research_assignment_items_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "research_assignment_items_assignee_fk",
      columns: [t.workspaceId, t.assigneePrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "research_assignment_items_created_by_fk",
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "research_assignment_items_updated_by_fk",
      columns: [t.workspaceId, t.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "research_assignment_items_kind_check",
      sql`${t.queueKind} IN ('review', 'verification', 'consent_follow_up', 'source_reconciliation', 'privacy_request')`,
    ),
    check(
      "research_assignment_items_status_check",
      sql`${t.status} IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')`,
    ),
    check(
      "research_assignment_items_priority_check",
      sql`${t.priority} BETWEEN 0 AND 100`,
    ),
    check(
      "research_assignment_items_escalation_check",
      sql`${t.escalationCount} BETWEEN 0 AND 1000`,
    ),
    check("research_assignment_items_version_check", sql`${t.version} > 0`),
    check(
      "research_assignment_items_text_check",
      sql`length(trim(${t.title})) BETWEEN 1 AND 200 AND (${t.description} IS NULL OR length(${t.description}) <= 4000)`,
    ),
  ],
);

export const researchAssignmentEvents = pgTable(
  "research_assignment_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assignmentId: uuid("assignment_id").notNull(),
    eventKind: text("event_kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    fromAssigneePrincipalId: uuid("from_assignee_principal_id"),
    toAssigneePrincipalId: uuid("to_assignee_principal_id"),
    reason: text("reason"),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    occurredAt: time("occurred_at").defaultNow().notNull(),
  },
  (t) => [
    unique("research_assignment_events_workspace_id_unique").on(
      t.workspaceId,
      t.id,
    ),
    index("research_assignment_events_item_idx").on(
      t.workspaceId,
      t.assignmentId,
      t.occurredAt,
      t.id,
    ),
    foreignKey({
      name: "research_assignment_events_item_fk",
      columns: [t.workspaceId, t.assignmentId],
      foreignColumns: [
        researchAssignmentItems.workspaceId,
        researchAssignmentItems.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "research_assignment_events_actor_fk",
      columns: [t.workspaceId, t.actorPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "research_assignment_events_from_assignee_fk",
      columns: [t.workspaceId, t.fromAssigneePrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "research_assignment_events_to_assignee_fk",
      columns: [t.workspaceId, t.toAssigneePrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "research_assignment_events_kind_check",
      sql`${t.eventKind} IN ('created', 'assigned', 'status_changed', 'escalated')`,
    ),
    check(
      "research_assignment_events_reason_check",
      sql`${t.reason} IS NULL OR length(trim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  ],
);

export type ResearchAssignmentItemRow =
  typeof researchAssignmentItems.$inferSelect;
export type ResearchAssignmentEventRow =
  typeof researchAssignmentEvents.$inferSelect;
