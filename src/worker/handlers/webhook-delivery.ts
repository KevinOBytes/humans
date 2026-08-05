import { and, eq } from "drizzle-orm";

import { webhookDeliveries, webhooks } from "@/db/schema/operations";
import { openSealedEnvelope } from "@/lib/security/sealed-envelope";
import { JobExecutionError } from "@/modules/jobs/types";
import {
  webhookEventHeaders,
  webhookRetryDelayMs,
} from "@/modules/webhooks/signature";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { assertPublicWebhookTarget } from "@/modules/webhooks/target";

function safeError(error: unknown): Record<string, string> {
  return {
    code: "delivery_failed",
    detail: error instanceof Error ? error.name.slice(0, 64) : "unknown",
  };
}

export function createWebhookDeliveryHandler(input: {
  database: Database;
  encryptionKey: string;
}): (
  payload: { deliveryId: string; webhookId: string },
  context: { job: { attemptCount: number }; signal: AbortSignal },
) => Promise<{ resultReferences: readonly string[] }> {
  return async (payload, context) => {
    const rows = await input.database
      .select({
        delivery: webhookDeliveries,
        webhook: webhooks,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhooks,
        and(
          eq(webhooks.workspaceId, webhookDeliveries.workspaceId),
          eq(webhooks.id, webhookDeliveries.webhookId),
        ),
      )
      .where(
        and(
          eq(webhookDeliveries.id, payload.deliveryId),
          eq(webhookDeliveries.webhookId, payload.webhookId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new JobExecutionError("webhook_delivery_not_found", "permanent");
    }
    // Delivery rows are immutable attempts. A completed row may be replayed by
    // a recovered queue, but must never issue a duplicate outbound request.
    // This also safely retires rows migrated from pre-payload versions.
    if (row.delivery.completedAt) {
      return { resultReferences: [row.delivery.id] };
    }
    if (row.webhook.state !== "active" || row.webhook.deletedAt) {
      return { resultReferences: [row.delivery.id] };
    }
    if (context.signal.aborted) {
      throw new JobExecutionError("worker_draining", "retryable");
    }
    const payloadText = openSealedEnvelope({
      key: input.encryptionKey,
      purpose: "webhook-payload",
      token: row.delivery.encryptedPayload,
    });
    const secret = openSealedEnvelope({
      key: input.encryptionKey,
      purpose: "webhook-secret",
      token: row.webhook.encryptedSecret,
    });
    const parsed = JSON.parse(payloadText) as { event?: unknown };
    const event = typeof parsed.event === "string" ? parsed.event : "unknown";
    const timestampSeconds = Math.floor(Date.now() / 1_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await assertPublicWebhookTarget(row.webhook.url);
      const response = await fetch(row.webhook.url, {
        method: "POST",
        headers: webhookEventHeaders({
          event,
          deliveryId: row.delivery.id,
          payload: payloadText,
          secret,
          timestampSeconds,
        }),
        body: payloadText,
        signal: controller.signal,
      });
      const nextRetryAt = response.ok
        ? null
        : webhookRetryDelayMs(context.job.attemptCount);
      await input.database
        .update(webhookDeliveries)
        .set({
          attempt: context.job.attemptCount,
          responseStatus: response.status,
          startedAt: new Date(Date.now() - 1),
          completedAt: new Date(),
          nextRetryAt: nextRetryAt ? new Date(Date.now() + nextRetryAt) : null,
          redactedError: response.ok ? null : { code: "http_failure" },
        })
        .where(eq(webhookDeliveries.id, row.delivery.id));
      if (!response.ok) {
        throw new JobExecutionError(
          `webhook_http_${response.status}`,
          nextRetryAt === null ? "permanent" : "retryable",
        );
      }
      return {
        resultReferences: [row.delivery.id],
      };
    } catch (error) {
      if (error instanceof JobExecutionError) throw error;
      await input.database
        .update(webhookDeliveries)
        .set({
          attempt: context.job.attemptCount,
          completedAt: new Date(),
          nextRetryAt: (() => {
            const delay = webhookRetryDelayMs(context.job.attemptCount);
            return delay === null ? null : new Date(Date.now() + delay);
          })(),
          redactedError: safeError(error),
        })
        .where(eq(webhookDeliveries.id, row.delivery.id));
      const delay = webhookRetryDelayMs(context.job.attemptCount);
      throw new JobExecutionError(
        "webhook_transport_failure",
        delay === null ? "permanent" : "retryable",
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}
