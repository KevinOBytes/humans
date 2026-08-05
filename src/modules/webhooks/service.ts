import { createHash, randomBytes } from "node:crypto";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { members } from "@/db/schema/auth";
import {
  auditEvents,
  webhookDeliveries,
  webhooks,
} from "@/db/schema/operations";
import type { GraphQLActor } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import { sealEnvelope } from "@/lib/security/sealed-envelope";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { createJobsService } from "@/modules/jobs/service";
import { webhookPayloadHash } from "./signature";

type TransactionDatabase = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

const EVENT_NAME = /^[a-z][a-z0-9_.-]{1,63}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireUser(
  actor: GraphQLActor,
): Extract<GraphQLActor, { type: "user" }> {
  if (actor.type !== "user") {
    throw createGraphQLError(
      "FORBIDDEN",
      "Webhook administration requires a user session.",
    );
  }
  return actor;
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname.length < 1 ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.includes(".") === false ||
    (url.port && url.port !== "443")
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Webhook URLs must be public HTTPS endpoints.",
    );
  }
  url.hash = "";
  return url.href;
}

function normalizeEvents(values: readonly string[]): readonly string[] {
  const events = [
    ...new Set(values.map((value) => value.trim().toLowerCase())),
  ].sort();
  if (
    events.length < 1 ||
    events.length > 32 ||
    events.some((event) => !EVENT_NAME.test(event))
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Webhook event subscriptions are invalid.",
    );
  }
  return events;
}

function createSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export type SafeWebhook = {
  id: string;
  url: string;
  subscribedEvents: readonly string[];
  state: string;
  secretFingerprint: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookMutationResult = {
  id: string | null;
  deliveryId?: string | null;
  code: "APPLIED" | "INVALID";
  requestId: string;
  secret?: string;
};

function mapWebhook(row: typeof webhooks.$inferSelect): SafeWebhook {
  return {
    id: row.id,
    url: row.url,
    subscribedEvents: row.subscribedEvents,
    state: row.state,
    secretFingerprint: row.secretFingerprint,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createWebhooksService(input: {
  actor: GraphQLActor;
  database: Database;
  encryptionKey: string;
  requestId: string;
  workspaceId: string;
}) {
  const jobs = createJobsService({
    database: input.database,
    encryptionKey: input.encryptionKey,
  });

  async function requireAdmin() {
    const actor = requireUser(input.actor);
    const rows = await input.database
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, input.workspaceId),
          eq(members.userId, actor.id),
          or(eq(members.role, "owner"), eq(members.role, "admin")),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      throw createGraphQLError(
        "FORBIDDEN",
        "Webhook administration requires an administrator role.",
      );
    }
    return { actor, role: row.role };
  }

  async function audit(
    transaction: TransactionDatabase,
    action: string,
    resourceId: string,
    outcome = "success",
  ) {
    await transaction.insert(auditEvents).values({
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actor.type === "user" ? input.actor.id : null,
      sessionId: input.actor.type === "user" ? input.actor.sessionId : null,
      apiKeyId: input.actor.type === "apiKey" ? input.actor.id : null,
      action,
      resourceKind: "webhook",
      resourceId,
      requestId: input.requestId,
      outcome,
      redactedDiff: null,
    });
  }

  return {
    async list(): Promise<readonly SafeWebhook[]> {
      await requireAdmin();
      const rows = await input.database
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.workspaceId, input.workspaceId),
            isNull(webhooks.deletedAt),
          ),
        )
        .orderBy(asc(webhooks.url), asc(webhooks.id));
      return rows.map(mapWebhook);
    },
    async create(
      urlValue: string,
      eventsValue: readonly string[],
    ): Promise<WebhookMutationResult> {
      await requireAdmin();
      const url = normalizeUrl(urlValue);
      const subscribedEvents = normalizeEvents(eventsValue);
      const actor = requireUser(input.actor);
      const id = newId();
      const secret = createSecret();
      const fingerprint = createHash("sha256")
        .update(secret, "utf8")
        .digest("hex");
      await input.database.transaction(async (transaction) => {
        await transaction.insert(webhooks).values({
          id,
          workspaceId: input.workspaceId,
          url,
          encryptedSecret: sealEnvelope({
            key: input.encryptionKey,
            plaintext: secret,
            purpose: "webhook-secret",
          }),
          secretFingerprint: fingerprint,
          subscribedEvents: [...subscribedEvents],
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        await audit(transaction, "webhook.create", id);
      });
      return { id, code: "APPLIED", requestId: input.requestId, secret };
    },
    async rotate(id: string): Promise<WebhookMutationResult> {
      await requireAdmin();
      if (!UUID.test(id))
        return { id: null, code: "INVALID", requestId: input.requestId };
      const actor = requireUser(input.actor);
      const secret = createSecret();
      const fingerprint = createHash("sha256")
        .update(secret, "utf8")
        .digest("hex");
      const result = await input.database.transaction(async (transaction) => {
        const updated = await transaction
          .update(webhooks)
          .set({
            encryptedSecret: sealEnvelope({
              key: input.encryptionKey,
              plaintext: secret,
              purpose: "webhook-secret",
            }),
            secretFingerprint: fingerprint,
            version: sql`${webhooks.version} + 1`,
            updatedAt: new Date(),
            updatedBy: actor.id,
          })
          .where(
            and(
              eq(webhooks.id, id),
              eq(webhooks.workspaceId, input.workspaceId),
              eq(webhooks.state, "active"),
              isNull(webhooks.deletedAt),
            ),
          )
          .returning({ id: webhooks.id });
        if (updated.length !== 1) return false;
        await audit(transaction, "webhook.rotate", id);
        return true;
      });
      return result
        ? { id, code: "APPLIED", requestId: input.requestId, secret }
        : { id: null, code: "INVALID", requestId: input.requestId };
    },
    async disable(id: string): Promise<WebhookMutationResult> {
      await requireAdmin();
      if (!UUID.test(id))
        return { id: null, code: "INVALID", requestId: input.requestId };
      const actor = requireUser(input.actor);
      const result = await input.database.transaction(async (transaction) => {
        const updated = await transaction
          .update(webhooks)
          .set({
            state: "disabled",
            deletedAt: new Date(),
            deletedBy: actor.id,
            updatedAt: new Date(),
            updatedBy: actor.id,
          })
          .where(
            and(
              eq(webhooks.id, id),
              eq(webhooks.workspaceId, input.workspaceId),
              isNull(webhooks.deletedAt),
            ),
          )
          .returning({ id: webhooks.id });
        if (updated.length !== 1) return false;
        await audit(transaction, "webhook.disable", id);
        return true;
      });
      return result
        ? { id, code: "APPLIED", requestId: input.requestId }
        : { id: null, code: "INVALID", requestId: input.requestId };
    },
    async enqueueEvent(
      event: string,
      payload: Record<string, unknown>,
      options: { webhookId?: string } = {},
    ): Promise<readonly string[]> {
      const actor = input.actor.type === "user" ? input.actor : null;
      if (
        !EVENT_NAME.test(event) ||
        Buffer.byteLength(JSON.stringify(payload), "utf8") > 64 * 1024
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "Webhook event payload is invalid.",
        );
      }
      const rows = await input.database
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.workspaceId, input.workspaceId),
            eq(webhooks.state, "active"),
            isNull(webhooks.deletedAt),
            ...(options.webhookId ? [eq(webhooks.id, options.webhookId)] : []),
          ),
        );
      const payloadText = JSON.stringify({
        data: payload,
        event,
        id: newId(),
        occurredAt: new Date().toISOString(),
      });
      const eventId = JSON.parse(payloadText).id as string;
      const deliveries: string[] = [];
      for (const webhook of rows.filter((row) =>
        row.subscribedEvents.includes(event),
      )) {
        const deliveryId = newId();
        await input.database.transaction(async (transaction) => {
          await transaction.insert(webhookDeliveries).values({
            id: deliveryId,
            workspaceId: input.workspaceId,
            webhookId: webhook.id,
            eventId,
            encryptedPayload: sealEnvelope({
              key: input.encryptionKey,
              plaintext: payloadText,
              purpose: "webhook-payload",
            }),
            payloadHash: webhookPayloadHash(payloadText),
            attempt: 1,
            signatureAlgorithm: "hmac-sha256",
          });
          await jobs.enqueue({
            createdBy: actor?.id ?? null,
            principalId: actor ? null : undefined,
            idempotencyKey: `webhook:${deliveryId}:1`,
            payload: {
              kind: "webhook_delivery",
              deliveryId,
              webhookId: webhook.id,
            },
            workspaceId: input.workspaceId,
          });
        });
        deliveries.push(deliveryId);
      }
      return deliveries;
    },
  };
}
