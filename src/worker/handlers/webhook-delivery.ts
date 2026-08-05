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
  void error;
  return { code: "delivery_failed" };
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
    // A completed delivery is terminal unless it has a scheduled retry. A
    // retryable HTTP/transport failure records completion for the attempt but
    // must still allow the worker's next attempt to progress; a duplicate
    // queue message for the same attempt must remain side-effect free.
    const hasScheduledRetry =
      row.delivery.completedAt !== null &&
      row.delivery.nextRetryAt !== null &&
      row.delivery.redactedError !== null;
    if (
      row.delivery.completedAt &&
      (!hasScheduledRetry || context.job.attemptCount <= row.delivery.attempt)
    ) {
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
    const startedAt = new Date();
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
          startedAt,
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
          startedAt,
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
