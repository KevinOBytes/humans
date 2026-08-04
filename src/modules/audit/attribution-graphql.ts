import { builder } from "@/graphql/builder";

import type { ActorAttribution as ActorAttributionShape } from "./service";

const ActorKind = builder.enumType("ActorKind", {
  values: ["USER", "API_KEY", "LEGACY", "SYSTEM"] as const,
});

export const ActorAttribution = builder
  .objectRef<ActorAttributionShape>("ActorAttribution")
  .implement({
    fields: (t) => ({
      principalId: t.expose("principalId", { type: "UUID", nullable: true }),
      kind: t.field({ type: ActorKind, resolve: (row) => row.kind }),
      label: t.exposeString("label"),
    }),
  });
