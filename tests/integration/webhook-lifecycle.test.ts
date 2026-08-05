// @vitest-environment node

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) =>
    hostname === "rebound.example.test"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "198.51.100.10", family: 4 }],
  ),
}));

import {
  CreateWorkspaceWebhookDocument,
  DisableWorkspaceWebhookDocument,
  RotateWorkspaceWebhookSecretDocument,
  SendWorkspaceWebhookTestEventDocument,
  WorkspaceWebhooksDocument,
} from "@/graphql/generated/graphql";
import { lookup } from "node:dns/promises";
import { webhookDeliveries, webhooks } from "@/db/schema/operations";
import { verifyWebhookSignature } from "@/modules/webhooks/signature";
import { createWebhookDeliveryHandler } from "@/worker/handlers/webhook-delivery";

import { testAdminEnv } from "../support/auth";
import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("webhook lifecycle acceptance", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => fixture.close());

  it("administers a generated webhook lifecycle and records a signed retry without duplicate replay", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { code: string; id: string | null; secret: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/humans",
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    expect(created.body?.data?.createWebhook).toMatchObject({
      code: "APPLIED",
      id: expect.any(String),
      secret: expect.stringMatching(/^whsec_/u),
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "webhook ID",
    );
    const firstSecret = required(
      created.body?.data?.createWebhook.secret,
      "initial webhook secret",
    );

    const rotated = await fixture.execute<{
      rotateWebhookSecret: {
        code: string;
        id: string | null;
        secret: string | null;
      };
    }>({
      jar: owner.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: { input: { id: webhookId } },
    });
    const rotatedSecret = required(
      rotated.body?.data?.rotateWebhookSecret.secret,
      "rotated webhook secret",
    );
    expect(rotated.body?.errors).toBeUndefined();
    expect(rotated.body?.data?.rotateWebhookSecret).toMatchObject({
      code: "APPLIED",
      id: webhookId,
    });
    expect(rotatedSecret).not.toBe(firstSecret);

    const listed = await fixture.execute<{
      webhooks: {
        nodes: Array<{ id: string; state: string; version: number }>;
      };
    }>({
      jar: owner.jar,
      operationName: "WorkspaceWebhooks",
      query: WorkspaceWebhooksDocument,
    });
    expect(listed.body?.data?.webhooks.nodes).toEqual([
      expect.objectContaining({ id: webhookId, state: "active", version: 2 }),
    ]);

    const queued = await fixture.execute<{
      sendWebhookTestEvent: {
        code: string;
        deliveryId: string | null;
        id: string | null;
      };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId } },
    });
    expect(queued.body?.errors).toBeUndefined();
    expect(queued.body?.data?.sendWebhookTestEvent).toMatchObject({
      code: "APPLIED",
      id: webhookId,
      deliveryId: expect.any(String),
    });
    const deliveryId = required(
      queued.body?.data?.sendWebhookTestEvent.deliveryId,
      "webhook delivery ID",
    );

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("temporarily unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const handler = createWebhookDeliveryHandler({
      database: fixture.database,
      encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
    });
    await expect(
      handler(
        { deliveryId, webhookId },
        { job: { attemptCount: 1 }, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "webhook_http_503",
      failureKind: "retryable",
    });
    expect(lookup).toHaveBeenCalledWith("hooks.example.test", {
      all: true,
      verbatim: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://hooks.example.test/humans");
    const body = String(request?.body);
    const headers = new Headers(request?.headers);
    const timestamp = Number(headers.get("x-humans-signature-timestamp"));
    expect(
      verifyWebhookSignature({
        payload: body,
        secret: rotatedSecret,
        signature: String(headers.get("x-humans-signature")),
        timestampSeconds: timestamp,
        nowSeconds: timestamp,
      }),
    ).toBe(true);

    const [delivery] = await fixture.database
      .select({
        attempt: webhookDeliveries.attempt,
        completedAt: webhookDeliveries.completedAt,
        nextRetryAt: webhookDeliveries.nextRetryAt,
        redactedError: webhookDeliveries.redactedError,
        responseStatus: webhookDeliveries.responseStatus,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(delivery).toMatchObject({
      attempt: 1,
      responseStatus: 503,
    });
    expect(delivery?.redactedError).toEqual({ code: "http_failure" });
    expect(delivery?.completedAt).toBeInstanceOf(Date);
    expect(delivery?.nextRetryAt).toBeInstanceOf(Date);

    const queuedSuccess = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId } },
    });
    const completedDeliveryId = required(
      queuedSuccess.body?.data?.sendWebhookTestEvent.deliveryId,
      "successful webhook delivery ID",
    );
    await expect(
      handler(
        { deliveryId: completedDeliveryId, webhookId },
        { job: { attemptCount: 1 }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ resultReferences: [completedDeliveryId] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(
      handler(
        { deliveryId: completedDeliveryId, webhookId },
        { job: { attemptCount: 2 }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ resultReferences: [completedDeliveryId] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await fixture.database
      .update(webhooks)
      .set({ url: "https://rebound.example.test/humans" })
      .where(eq(webhooks.id, webhookId));
    const queuedRebound = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId } },
    });
    const reboundDeliveryId = required(
      queuedRebound.body?.data?.sendWebhookTestEvent.deliveryId,
      "rebound webhook delivery ID",
    );
    await expect(
      handler(
        { deliveryId: reboundDeliveryId, webhookId },
        { job: { attemptCount: 1 }, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "webhook_transport_failure",
      failureKind: "retryable",
    });
    expect(lookup).toHaveBeenCalledWith("rebound.example.test", {
      all: true,
      verbatim: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [reboundDelivery] = await fixture.database
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, reboundDeliveryId));
    expect(reboundDelivery?.redactedError).toEqual({
      code: "delivery_failed",
      detail: "Error",
    });
    const serializedDelivery = JSON.stringify(reboundDelivery);
    expect(serializedDelivery).not.toContain("temporarily unavailable");
    expect(serializedDelivery).not.toContain(firstSecret);
    expect(serializedDelivery).not.toContain(rotatedSecret);
    expect(serializedDelivery).not.toContain("Humans webhook test");

    const disabled = await fixture.execute<{
      disableWebhook: { code: string; id: string | null };
    }>({
      jar: owner.jar,
      operationName: "DisableWorkspaceWebhook",
      query: DisableWorkspaceWebhookDocument,
      variables: { input: { id: webhookId } },
    });
    expect(disabled.body?.errors).toBeUndefined();
    expect(disabled.body?.data?.disableWebhook).toEqual({
      code: "APPLIED",
      id: webhookId,
      requestId: expect.any(String),
    });
    const [disabledWebhook] = await fixture.database
      .select({ deletedAt: webhooks.deletedAt, state: webhooks.state })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.id, webhookId),
          eq(webhooks.workspaceId, owner.workspaceId),
        ),
      );
    expect(disabledWebhook).toMatchObject({ state: "disabled" });
    expect(disabledWebhook?.deletedAt).toBeInstanceOf(Date);
  });

  it("keeps webhook administration bound to the active actor workspace before ordering", async () => {
    const owner = await fixture.createSessionActor({ name: "Webhook owner" });
    const foreign = await fixture.createSessionActor({
      name: "Webhook foreign",
    });

    const ownerCreated = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          // The owner URL sorts after the foreign URL. A missing tenant
          // predicate would therefore expose the foreign row first.
          url: "https://hooks.example.test/z-owner",
        },
      },
    });
    expect(ownerCreated.body?.errors).toBeUndefined();
    const ownerWebhookId = required(
      ownerCreated.body?.data?.createWebhook.id,
      "owner webhook ID",
    );

    const foreignCreated = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/a-foreign",
        },
      },
    });
    expect(foreignCreated.body?.errors).toBeUndefined();
    const foreignWebhookId = required(
      foreignCreated.body?.data?.createWebhook.id,
      "foreign webhook ID",
    );

    const ownerList = await fixture.execute<{
      webhooks: { nodes: Array<{ id: string; url: string }> };
    }>({
      jar: owner.jar,
      operationName: "WorkspaceWebhooks",
      query: WorkspaceWebhooksDocument,
      // A caller-controlled workspace header must not replace the actor's
      // active workspace before the service applies its deterministic order.
      headers: { "x-workspace-id": foreign.workspaceId },
    });
    expect(ownerList.body?.errors).toBeUndefined();
    expect(ownerList.body?.data?.webhooks.nodes).toHaveLength(1);
    expect(ownerList.body?.data?.webhooks.nodes).toEqual([
      expect.objectContaining({
        id: ownerWebhookId,
        url: "https://hooks.example.test/z-owner",
      }),
    ]);
    expect(JSON.stringify(ownerList.body)).not.toContain(foreignWebhookId);

    const foreignRotate = await fixture.execute<{
      rotateWebhookSecret: { code: string; id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: { input: { id: ownerWebhookId } },
    });
    expect(foreignRotate.body?.errors).toBeUndefined();
    expect(foreignRotate.body?.data?.rotateWebhookSecret).toMatchObject({
      code: "INVALID",
      id: null,
    });

    const foreignDisable = await fixture.execute<{
      disableWebhook: { code: string; id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "DisableWorkspaceWebhook",
      query: DisableWorkspaceWebhookDocument,
      variables: { input: { id: ownerWebhookId } },
    });
    expect(foreignDisable.body?.errors).toBeUndefined();
    expect(foreignDisable.body?.data?.disableWebhook).toMatchObject({
      code: "INVALID",
      id: null,
    });

    const foreignSend = await fixture.execute({
      jar: foreign.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: ownerWebhookId } },
    });
    expectGraphQLError(foreignSend, "NOT_FOUND");
    expect(JSON.stringify(foreignSend.body)).not.toContain(ownerWebhookId);

    const ownerKey = await fixture.provisionKey(owner, {
      webhook: ["read", "update", "delete"],
    });
    const apiKeyList = await fixture.execute({
      apiKey: ownerKey.key,
      origin: null,
      operationName: "WorkspaceWebhooks",
      query: WorkspaceWebhooksDocument,
    });
    expectGraphQLError(apiKeyList, "FORBIDDEN");
    expect(JSON.stringify(apiKeyList.body)).not.toContain(ownerWebhookId);

    const [ownerRow] = await fixture.database
      .select({ state: webhooks.state, version: webhooks.version })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.id, ownerWebhookId),
          eq(webhooks.workspaceId, owner.workspaceId),
        ),
      );
    expect(ownerRow).toEqual({ state: "active", version: 1 });
  });
});
