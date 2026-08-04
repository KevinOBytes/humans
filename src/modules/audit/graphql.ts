import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { PageInfo } from "@/modules/people/graphql";
import type { PageInfo as PageInfoShape } from "@/modules/people/service";

import { ActorAttribution } from "./attribution-graphql";
import type { AuditEventRow } from "./service";

const AuditOutcome = builder.enumType("AuditOutcome", {
  values: {
    SUCCESS: { value: "success" },
    FAILURE: { value: "failure" },
  } as const,
});

const AuditEvent = builder.objectRef<AuditEventRow>("AuditEvent").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    action: t.exposeString("action"),
    resourceKind: t.exposeString("resourceKind"),
    resourceId: t.expose("resourceId", { type: "UUID", nullable: true }),
    requestId: t.exposeString("requestId"),
    actor: t.field({
      type: ActorAttribution,
      resolve: (row, _args, context) =>
        context.loaders.actorAttribution.load(
          row.apiKeyId
            ? `k:${row.apiKeyId}`
            : row.actorUserId
              ? `u:${row.actorUserId}`
              : "s:system",
        ),
    }),
    redactedDiff: t.field({
      type: "JSON",
      nullable: true,
      resolve: (row) => row.redactedDiff,
    }),
    outcome: t.field({
      type: AuditOutcome,
      resolve: (row) => row.outcome as "success" | "failure",
    }),
    occurredAt: t.field({
      type: "DateTime",
      resolve: (row) => row.occurredAt.toISOString(),
    }),
  }),
});

const AuditEventConnection = builder
  .objectRef<{ nodes: AuditEventRow[]; pageInfo: PageInfoShape }>(
    "AuditEventConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [AuditEvent],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const AuditEventFilterInput = builder.inputType("AuditEventFilterInput", {
  fields: (t) => ({
    action: t.string(),
    resourceKind: t.string(),
    resourceId: t.field({ type: "UUID" }),
    outcome: t.field({ type: AuditOutcome }),
    occurredFrom: t.field({ type: "DateTime" }),
    occurredUntil: t.field({ type: "DateTime" }),
  }),
});

function multiplier(first?: number | null) {
  const n = first ?? 25;
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : 101;
}

export function registerAuditGraphQL(): void {
  builder.queryFields((t) => ({
    auditEvents: t.field({
      type: AuditEventConnection,
      args: {
        filter: t.arg({ type: AuditEventFilterInput }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => ({ field: 3, multiplier: multiplier(args.first) }),
      resolve: (_root, args, context) => {
        requirePermission(context, "audit", "read");
        return context.services.audit.list({
          ...args.filter,
          first: args.first,
          after: args.after,
        });
      },
    }),
  }));
}
