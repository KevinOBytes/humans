import { builder } from "./builder";
import type { GraphQLContext } from "./context";
import type { SafeWorkspace } from "./loaders";
import { registerPeopleGraphQL } from "@/modules/people/graphql";
import { registerFactsGraphQL } from "@/modules/facts/graphql";
import { registerRelationshipsGraphQL } from "@/modules/relationships/graphql";
import { registerEvidenceGraphQL } from "@/modules/evidence/graphql";
import { registerAuditGraphQL } from "@/modules/audit/graphql";
import { registerGraphGraphQL } from "@/modules/graph/graphql";
import { registerFilesGraphQL } from "@/modules/files/graphql";
import { registerImportsGraphQL } from "@/modules/imports/graphql";
import { registerSearchGraphQL } from "@/modules/search/graphql";
import { registerSettingsGraphQL } from "@/modules/settings/graphql";
import { registerLocationsGraphQL } from "@/modules/locations/graphql";
import { registerAiGraphQL } from "@/modules/ai/graphql";

const Workspace = builder.objectRef<SafeWorkspace>("Workspace").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID", nullable: false }),
    name: t.exposeString("name", { nullable: false }),
    organizationId: t.exposeString("organizationId", { nullable: false }),
  }),
});

const Viewer = builder.objectRef<GraphQLContext>("Viewer").implement({
  fields: (t) => ({
    id: t.string({ nullable: false, resolve: (context) => context.actor.id }),
    principalId: t.field({
      type: "UUID",
      nullable: false,
      resolve: (context) => context.actor.principalId,
    }),
    actorType: t.string({
      nullable: false,
      resolve: (context) =>
        context.actor.type === "apiKey" ? "API_KEY" : "USER",
    }),
    role: t.string({
      nullable: true,
      resolve: (context) => context.actor.role,
    }),
    permissions: t.stringList({
      nullable: { items: false, list: false },
      resolve: (context) => [...context.permissions].sort(),
    }),
    workspace: t.field({
      type: Workspace,
      nullable: false,
      resolve: (context) => context.workspace,
    }),
  }),
});

builder.queryType({
  fields: (t) => ({
    viewer: t.field({
      type: Viewer,
      nullable: false,
      resolve: (_root, _args, context) => context,
    }),
    workspace: t.field({
      type: Workspace,
      nullable: false,
      resolve: (_root, _args, context) => context.workspace,
    }),
  }),
});

builder.mutationType({ fields: () => ({}) });
registerPeopleGraphQL();
registerFactsGraphQL();
registerRelationshipsGraphQL();
registerEvidenceGraphQL();
registerAuditGraphQL();
registerGraphGraphQL();
registerFilesGraphQL();
registerImportsGraphQL();
registerSearchGraphQL();
registerSettingsGraphQL();
registerLocationsGraphQL();
registerAiGraphQL();

export const schema = builder.toSchema();
