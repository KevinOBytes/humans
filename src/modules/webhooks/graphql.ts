import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";

import type { SafeWebhook, WebhookMutationResult } from "./service";

const Webhook = builder.objectRef<SafeWebhook>("Webhook").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    url: t.exposeString("url"),
    subscribedEvents: t.exposeStringList("subscribedEvents", {
      nullable: { list: false, items: false },
    }),
    state: t.exposeString("state"),
    secretFingerprint: t.exposeString("secretFingerprint"),
    version: t.exposeInt("version"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

const WebhookConnection = builder
  .objectRef<{ nodes: readonly SafeWebhook[] }>("WebhookConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Webhook],
        nullable: { list: false, items: false },
      }),
    }),
  });

type WebhookPayload = WebhookMutationResult;
const WebhookMutationPayload = builder
  .objectRef<WebhookPayload>("WebhookMutationPayload")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id", { nullable: true }),
      deliveryId: t.exposeString("deliveryId", { nullable: true }),
      code: t.exposeString("code"),
      requestId: t.exposeString("requestId"),
      secret: t.exposeString("secret", { nullable: true }),
    }),
  });

const CreateWebhookInput = builder.inputType("CreateWebhookInput", {
  fields: (t) => ({
    url: t.string({ required: true }),
    events: t.stringList({ required: true }),
  }),
});

const WebhookIdInput = builder.inputType("WebhookIdInput", {
  fields: (t) => ({ id: t.field({ type: "UUID", required: true }) }),
});

export function registerWebhooksGraphQL(): void {
  builder.queryFields((t) => ({
    webhooks: t.field({
      type: WebhookConnection,
      nullable: false,
      resolve: (_root, _args, context) => {
        requirePermission(context, "webhook", "read");
        return context.services.webhooks.list().then((nodes) => ({ nodes }));
      },
    }),
  }));

  builder.mutationFields((t) => ({
    createWebhook: t.field({
      type: WebhookMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: CreateWebhookInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "webhook", "create");
        return context.services.webhooks.create(
          args.input.url,
          args.input.events,
        );
      },
    }),
    rotateWebhookSecret: t.field({
      type: WebhookMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: WebhookIdInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "webhook", "update");
        return context.services.webhooks.rotate(args.input.id);
      },
    }),
    disableWebhook: t.field({
      type: WebhookMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: WebhookIdInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "webhook", "delete");
        return context.services.webhooks.disable(args.input.id);
      },
    }),
    sendWebhookTestEvent: t.field({
      type: WebhookMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: WebhookIdInput, required: true }),
      },
      resolve: async (_root, args, context) => {
        requirePermission(context, "webhook", "update");
        const deliveryIds = await context.services.webhooks.enqueueEvent(
          "webhook.test",
          { message: "Humans webhook test" },
          { webhookId: args.input.id },
        );
        const deliveryId = deliveryIds[0] ?? null;
        if (!deliveryId) {
          throw createGraphQLError(
            "NOT_FOUND",
            "The webhook is disabled or not subscribed to webhook.test.",
          );
        }
        return {
          id: args.input.id,
          deliveryId,
          code: "APPLIED" as const,
          requestId: context.requestId,
        };
      },
    }),
  }));
}
