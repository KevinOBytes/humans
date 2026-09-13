// @vitest-environment node

import { randomUUID } from "node:crypto";
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
import { and, eq, sql } from "drizzle-orm";

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
import {
  auditEvents,
  idempotencyKeys,
  jobs,
  webhookDeliveries,
  webhooks,
} from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { openSealedEnvelope } from "@/lib/security/sealed-envelope";
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

function commitRace(operation: string) {
  let signalReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hit: false,
    operation,
    reached,
    release,
    released,
    signalReached,
  };
}

liveDescribe("webhook lifecycle acceptance", () => {
  let fixture: ResearchFixture;
  let race: ReturnType<typeof commitRace> | null = null;

  beforeAll(() => {
    fixture = new ResearchFixture({
      webhookRuntime: {
        afterIdempotentCommit: async (operation) => {
          if (!race || race.hit || race.operation !== operation) return;
          race.hit = true;
          race.signalReached();
          await race.released;
        },
      },
    });
  });
  beforeEach(async () => {
    race = null;
    await fixture.reset();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });
  afterAll(async () => fixture.close());

  it("converges concurrent keyed creation with one encrypted secret and secretless replay", async () => {
    const owner = await fixture.createActor();
    const input = {
      events: ["webhook.test", "person.updated"],
      idempotencyKey: "webhook-create-concurrent-v1",
      url: "https://hooks.example.test/durable-create",
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.execute<{
          createWebhook: {
            code: string;
            id: string | null;
            replayed: boolean;
            requestId: string;
            secret: string | null;
          };
        }>({
          jar: owner.jar,
          operationName: "CreateWorkspaceWebhook",
          query: CreateWorkspaceWebhookDocument,
          variables: { input },
        }),
      ),
    );
    expect(responses.map((response) => response.body?.errors)).toEqual([
      undefined,
      undefined,
    ]);
    const payloads = responses.map((response) =>
      required(response.body?.data?.createWebhook, "create payload"),
    );
    expect(new Set(payloads.map((payload) => payload.id))).toHaveLength(1);
    expect(payloads.map((payload) => payload.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const secrets = payloads
      .map((payload) => payload.secret)
      .filter((secret): secret is string => typeof secret === "string");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatch(/^whsec_/u);
    const executor = required(
      payloads.find((payload) => !payload.replayed),
      "create executor payload",
    );

    const replay = await fixture.execute<{
      createWebhook: {
        code: string;
        id: string | null;
        replayed: boolean;
        requestId: string;
        secret: string | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: { input },
    });
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data?.createWebhook).toEqual({
      code: "APPLIED",
      id: executor.id,
      replayed: true,
      requestId: executor.requestId,
      secret: null,
    });

    const storedWebhooks = await fixture.database
      .select({
        encryptedSecret: webhooks.encryptedSecret,
        id: webhooks.id,
        secretFingerprint: webhooks.secretFingerprint,
        version: webhooks.version,
      })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, owner.workspaceId));
    expect(storedWebhooks).toHaveLength(1);
    expect(storedWebhooks[0]).toMatchObject({
      id: executor.id,
      secretFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      version: 1,
    });
    expect(storedWebhooks[0]?.encryptedSecret).not.toContain(secrets[0] ?? "");
    expect(
      openSealedEnvelope({
        key: testAdminEnv.DATA_ENCRYPTION_KEY,
        purpose: "webhook-secret",
        token: required(
          storedWebhooks[0]?.encryptedSecret,
          "encrypted webhook secret",
        ),
      }),
    ).toBe(secrets[0]);

    const audits = await fixture.database
      .select({
        id: auditEvents.id,
        redactedDiff: auditEvents.redactedDiff,
        requestId: auditEvents.requestId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "webhook.create"),
        ),
      );
    expect(audits).toEqual([
      {
        id: expect.any(String),
        redactedDiff: null,
        requestId: executor.requestId,
      },
    ]);
    const claims = await fixture.database
      .select({
        actorPrincipalId: locationMutationIdempotency.actorPrincipalId,
        keyHash: locationMutationIdempotency.keyHash,
        operation: locationMutationIdempotency.operation,
        requestHash: locationMutationIdempotency.requestHash,
        responseReference: locationMutationIdempotency.responseReference,
      })
      .from(locationMutationIdempotency)
      .where(eq(locationMutationIdempotency.workspaceId, owner.workspaceId));
    expect(claims).toEqual([
      {
        actorPrincipalId: owner.principalId,
        keyHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        operation: "webhook.create.graphql",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        responseReference: {
          auditEventId: audits[0]?.id,
          code: "APPLIED",
          requestId: executor.requestId,
          version: 1,
          webhookId: executor.id,
        },
      },
    ]);
    const serializedClaims = JSON.stringify(claims);
    expect(serializedClaims).not.toContain(input.idempotencyKey);
    expect(serializedClaims).not.toContain(input.url);
    expect(serializedClaims).not.toContain(secrets[0] ?? "missing-secret");
  });

  it("does not strand the first create secret when a lifecycle mutation follows commit", async () => {
    const owner = await fixture.createActor();
    const input = {
      events: ["webhook.test"],
      idempotencyKey: "webhook-create-post-commit-race-v1",
      url: "https://hooks.example.test/post-commit-create",
    };
    const commit = commitRace("webhook.create");
    race = commit;
    const createPromise = fixture.execute<{
      createWebhook: {
        code: string;
        id: string | null;
        requestId: string;
        secret: string | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: { input },
    });
    await commit.reached;
    const [created] = await fixture.database
      .select({ id: webhooks.id, version: webhooks.version })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, owner.workspaceId));
    const webhookId = required(created?.id, "post-commit webhook ID");
    const disabled = await fixture.execute({
      jar: owner.jar,
      operationName: "DisableWorkspaceWebhook",
      query: DisableWorkspaceWebhookDocument,
      variables: { input: { expectedVersion: 1, id: webhookId } },
    });
    expect(disabled.body?.errors).toBeUndefined();
    commit.release();
    const createdResult = await createPromise;
    expect(createdResult.body?.errors).toBeUndefined();
    expect(createdResult.body?.data?.createWebhook).toMatchObject({
      code: "APPLIED",
      id: webhookId,
      replayed: false,
    });
    expect(createdResult.body?.data?.createWebhook.secret).toMatch(/^whsec_/u);
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateWorkspaceWebhook",
        query: CreateWorkspaceWebhookDocument,
        variables: { input },
      }),
      "NOT_FOUND",
    );
    race = null;
  });

  it("does not strand the first rotation secret when disable follows commit", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/post-commit-rotate",
        },
      },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "rotation webhook ID",
    );
    const input = {
      expectedVersion: 1,
      id: webhookId,
      idempotencyKey: "webhook-rotate-post-commit-race-v1",
    };
    const commit = commitRace("webhook.rotate");
    race = commit;
    const rotatePromise = fixture.execute<{
      rotateWebhookSecret: {
        code: string;
        id: string | null;
        replayed: boolean;
        secret: string | null;
      };
    }>({
      jar: owner.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: { input },
    });
    await commit.reached;
    const disabled = await fixture.execute({
      jar: owner.jar,
      operationName: "DisableWorkspaceWebhook",
      query: DisableWorkspaceWebhookDocument,
      variables: { input: { expectedVersion: 2, id: webhookId } },
    });
    expect(disabled.body?.errors).toBeUndefined();
    commit.release();
    const rotated = await rotatePromise;
    expect(rotated.body?.errors).toBeUndefined();
    expect(rotated.body?.data?.rotateWebhookSecret).toMatchObject({
      code: "APPLIED",
      id: webhookId,
      replayed: false,
    });
    expect(rotated.body?.data?.rotateWebhookSecret.secret).toMatch(/^whsec_/u);
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "RotateWorkspaceWebhookSecret",
        query: RotateWorkspaceWebhookSecretDocument,
        variables: { input },
      }),
      "NOT_FOUND",
    );
    race = null;
  });

  it("converges concurrent keyed rotation with an optimistic version and one transient secret", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null; secret: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/durable-rotate",
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "webhook ID",
    );
    const originalSecret = required(
      created.body?.data?.createWebhook.secret,
      "original webhook secret",
    );
    const input = {
      expectedVersion: 1,
      id: webhookId,
      idempotencyKey: "webhook-rotate-concurrent-v1",
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.execute<{
          rotateWebhookSecret: {
            code: string;
            id: string | null;
            replayed: boolean;
            requestId: string;
            secret: string | null;
          };
        }>({
          jar: owner.jar,
          operationName: "RotateWorkspaceWebhookSecret",
          query: RotateWorkspaceWebhookSecretDocument,
          variables: { input },
        }),
      ),
    );
    expect(responses.map((response) => response.body?.errors)).toEqual([
      undefined,
      undefined,
    ]);
    const payloads = responses.map((response) =>
      required(response.body?.data?.rotateWebhookSecret, "rotation payload"),
    );
    expect(new Set(payloads.map((payload) => payload.id))).toEqual(
      new Set([webhookId]),
    );
    expect(payloads.map((payload) => payload.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const secrets = payloads
      .map((payload) => payload.secret)
      .filter((secret): secret is string => typeof secret === "string");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatch(/^whsec_/u);
    expect(secrets[0]).not.toBe(originalSecret);
    const executor = required(
      payloads.find((payload) => !payload.replayed),
      "rotation executor payload",
    );
    const replay = await fixture.execute<{
      rotateWebhookSecret: {
        code: string;
        id: string | null;
        replayed: boolean;
        requestId: string;
        secret: string | null;
      };
    }>({
      jar: owner.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: { input },
    });
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data?.rotateWebhookSecret).toEqual({
      code: "APPLIED",
      id: webhookId,
      replayed: true,
      requestId: executor.requestId,
      secret: null,
    });

    const [stored] = await fixture.database
      .select({
        encryptedSecret: webhooks.encryptedSecret,
        version: webhooks.version,
      })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.workspaceId, owner.workspaceId),
          eq(webhooks.id, webhookId),
        ),
      );
    expect(stored?.version).toBe(2);
    expect(
      openSealedEnvelope({
        key: testAdminEnv.DATA_ENCRYPTION_KEY,
        purpose: "webhook-secret",
        token: required(stored?.encryptedSecret, "rotated encrypted secret"),
      }),
    ).toBe(secrets[0]);
    const rotationAudits = await fixture.database
      .select({ id: auditEvents.id, requestId: auditEvents.requestId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "webhook.rotate"),
        ),
      );
    expect(rotationAudits).toEqual([
      { id: expect.any(String), requestId: executor.requestId },
    ]);
    const [claim] = await fixture.database
      .select({
        operation: locationMutationIdempotency.operation,
        responseReference: locationMutationIdempotency.responseReference,
      })
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "webhook.rotate.graphql"),
        ),
      );
    expect(claim).toEqual({
      operation: "webhook.rotate.graphql",
      responseReference: {
        auditEventId: rotationAudits[0]?.id,
        code: "APPLIED",
        requestId: executor.requestId,
        version: 2,
        webhookId,
      },
    });
    expect(JSON.stringify(claim)).not.toContain(secrets[0] ?? "missing-secret");
  });

  it("converges concurrent keyed disable with one versioned deletion and audit", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/durable-disable",
        },
      },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "webhook ID",
    );
    const input = {
      expectedVersion: 1,
      id: webhookId,
      idempotencyKey: "webhook-disable-concurrent-v1",
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.execute<{
          disableWebhook: {
            code: string;
            id: string | null;
            replayed: boolean;
            requestId: string;
          };
        }>({
          jar: owner.jar,
          operationName: "DisableWorkspaceWebhook",
          query: DisableWorkspaceWebhookDocument,
          variables: { input },
        }),
      ),
    );
    expect(responses.map((response) => response.body?.errors)).toEqual([
      undefined,
      undefined,
    ]);
    const payloads = responses.map((response) =>
      required(response.body?.data?.disableWebhook, "disable payload"),
    );
    expect(payloads).toEqual([
      expect.objectContaining({ code: "APPLIED", id: webhookId }),
      expect.objectContaining({ code: "APPLIED", id: webhookId }),
    ]);
    expect(new Set(payloads.map((payload) => payload.requestId))).toHaveLength(
      1,
    );
    expect(payloads.map((payload) => payload.replayed).sort()).toEqual([
      false,
      true,
    ]);

    const [disabled] = await fixture.database
      .select({
        deletedAt: webhooks.deletedAt,
        state: webhooks.state,
        version: webhooks.version,
      })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.workspaceId, owner.workspaceId),
          eq(webhooks.id, webhookId),
        ),
      );
    expect(disabled).toMatchObject({ state: "disabled", version: 2 });
    expect(disabled?.deletedAt).toBeInstanceOf(Date);
    const disableAudits = await fixture.database
      .select({ id: auditEvents.id, requestId: auditEvents.requestId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "webhook.disable"),
        ),
      );
    expect(disableAudits).toEqual([
      { id: expect.any(String), requestId: payloads[0]?.requestId },
    ]);
    const [claim] = await fixture.database
      .select({
        responseReference: locationMutationIdempotency.responseReference,
      })
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "webhook.disable.graphql"),
        ),
      );
    expect(claim?.responseReference).toEqual({
      auditEventId: disableAudits[0]?.id,
      code: "APPLIED",
      requestId: payloads[0]?.requestId,
      version: 2,
      webhookId,
    });
  });

  it("rejects changed material and stale versions while fencing replay to the current webhook", async () => {
    const owner = await fixture.createActor();
    const createInput = {
      events: ["webhook.test"],
      idempotencyKey: "webhook-changed-create-v1",
      url: "https://hooks.example.test/changed-create",
    };
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: { input: createInput },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "webhook ID",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateWorkspaceWebhook",
        query: CreateWorkspaceWebhookDocument,
        variables: {
          input: {
            ...createInput,
            url: "https://hooks.example.test/changed-create-material",
          },
        },
      }),
      "CONFLICT",
    );

    const rotateInput = {
      expectedVersion: 1,
      id: webhookId,
      idempotencyKey: "webhook-changed-rotate-v1",
    };
    const rotated = await fixture.execute({
      jar: owner.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: { input: rotateInput },
    });
    expect(rotated.body?.errors).toBeUndefined();
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "RotateWorkspaceWebhookSecret",
        query: RotateWorkspaceWebhookSecretDocument,
        variables: { input: { ...rotateInput, expectedVersion: 2 } },
      }),
      "CONFLICT",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateWorkspaceWebhook",
        query: CreateWorkspaceWebhookDocument,
        variables: { input: createInput },
      }),
      "CONFLICT",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "DisableWorkspaceWebhook",
        query: DisableWorkspaceWebhookDocument,
        variables: {
          input: {
            expectedVersion: 1,
            id: webhookId,
            idempotencyKey: "webhook-stale-disable-v1",
          },
        },
      }),
      "CONFLICT",
    );

    const disableInput = {
      expectedVersion: 2,
      id: webhookId,
      idempotencyKey: "webhook-changed-disable-v1",
    };
    const disabled = await fixture.execute({
      jar: owner.jar,
      operationName: "DisableWorkspaceWebhook",
      query: DisableWorkspaceWebhookDocument,
      variables: { input: disableInput },
    });
    expect(disabled.body?.errors).toBeUndefined();
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "DisableWorkspaceWebhook",
        query: DisableWorkspaceWebhookDocument,
        variables: { input: { ...disableInput, expectedVersion: 3 } },
      }),
      "CONFLICT",
    );
  });

  it("fails closed for malformed create, rotate, and disable response references", async () => {
    const owner = await fixture.createActor();
    const createInput = {
      events: ["webhook.test"],
      idempotencyKey: "webhook-malformed-create-v1",
      url: "https://hooks.example.test/malformed-create",
    };
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: { input: createInput },
    });
    const createdId = required(
      created.body?.data?.createWebhook.id,
      "created ID",
    );
    const [createClaim] = await fixture.database
      .select({ id: locationMutationIdempotency.id })
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "webhook.create.graphql"),
      );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { webhookId: "not-a-uuid" } })
      .where(
        eq(
          locationMutationIdempotency.id,
          required(createClaim, "create claim").id,
        ),
      );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateWorkspaceWebhook",
        query: CreateWorkspaceWebhookDocument,
        variables: { input: createInput },
      }),
      "VALIDATION_FAILED",
    );

    const rotateInput = {
      expectedVersion: 1,
      id: createdId,
      idempotencyKey: "webhook-malformed-rotate-v1",
    };
    const rotated = await fixture.execute<{
      rotateWebhookSecret: { requestId: string };
    }>({
      jar: owner.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: { input: rotateInput },
    });
    const rotateRequestId = required(
      rotated.body?.data?.rotateWebhookSecret.requestId,
      "rotate request ID",
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          auditEventId: randomUUID(),
          code: "APPLIED",
          requestId: rotateRequestId,
          version: 2,
          webhookId: createdId,
        },
      })
      .where(
        eq(locationMutationIdempotency.operation, "webhook.rotate.graphql"),
      );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "RotateWorkspaceWebhookSecret",
        query: RotateWorkspaceWebhookSecretDocument,
        variables: { input: rotateInput },
      }),
      "VALIDATION_FAILED",
    );

    const disableInput = {
      expectedVersion: 2,
      id: createdId,
      idempotencyKey: "webhook-malformed-disable-v1",
    };
    const disabled = await fixture.execute({
      jar: owner.jar,
      operationName: "DisableWorkspaceWebhook",
      query: DisableWorkspaceWebhookDocument,
      variables: { input: disableInput },
    });
    expect(disabled.body?.errors).toBeUndefined();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          auditEventId: randomUUID(),
          code: "APPLIED",
          requestId: randomUUID(),
          version: "3",
          webhookId: createdId,
        },
      })
      .where(
        eq(locationMutationIdempotency.operation, "webhook.disable.graphql"),
      );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "DisableWorkspaceWebhook",
        query: DisableWorkspaceWebhookDocument,
        variables: { input: disableInput },
      }),
      "VALIDATION_FAILED",
    );
    for (const action of [
      "webhook.create",
      "webhook.rotate",
      "webhook.disable",
    ]) {
      const rows = await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, action),
          ),
        );
      expect(rows).toHaveLength(1);
    }
  });

  it("takes over an expired rotation claim at the current version and ignores its stale reference", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/expired-rotate",
        },
      },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "webhook ID",
    );
    const key = "webhook-expired-rotate-v1";
    const first = await fixture.execute({
      jar: owner.jar,
      operationName: "RotateWorkspaceWebhookSecret",
      query: RotateWorkspaceWebhookSecretDocument,
      variables: {
        input: { expectedVersion: 1, id: webhookId, idempotencyKey: key },
      },
    });
    expect(first.body?.errors).toBeUndefined();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
        responseReference: { webhookId: "expired-stale-reference" },
      })
      .where(
        eq(locationMutationIdempotency.operation, "webhook.rotate.graphql"),
      );
    const takeoverInput = {
      expectedVersion: 2,
      id: webhookId,
      idempotencyKey: key,
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.execute<{
          rotateWebhookSecret: {
            replayed: boolean;
            secret: string | null;
          };
        }>({
          jar: owner.jar,
          operationName: "RotateWorkspaceWebhookSecret",
          query: RotateWorkspaceWebhookSecretDocument,
          variables: { input: takeoverInput },
        }),
      ),
    );
    expect(responses.map((response) => response.body?.errors)).toEqual([
      undefined,
      undefined,
    ]);
    const payloads = responses.map((response) =>
      required(response.body?.data?.rotateWebhookSecret, "takeover payload"),
    );
    expect(payloads.map((payload) => payload.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(payloads.filter((payload) => payload.secret != null)).toHaveLength(
      1,
    );
    const [stored] = await fixture.database
      .select({ version: webhooks.version })
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));
    expect(stored?.version).toBe(3);
    const claims = await fixture.database
      .select({ expiresAt: locationMutationIdempotency.expiresAt })
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "webhook.rotate.graphql"),
      );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const audits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "webhook.rotate"));
    expect(audits).toHaveLength(2);
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "RotateWorkspaceWebhookSecret",
        query: RotateWorkspaceWebhookSecretDocument,
        variables: {
          input: {
            expectedVersion: 2,
            id: webhookId,
            idempotencyKey: "webhook-stale-after-takeover-v1",
          },
        },
      }),
      "CONFLICT",
    );
  });

  it("isolates raw keys by workspace and principal and denies unauthorized actors", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const foreign = await fixture.createActor();
    const rawKey = "webhook-principal-fence-v1";
    const executeCreate = (jar: typeof owner.jar, url: string) =>
      fixture.execute<{
        createWebhook: { id: string | null };
      }>({
        jar,
        operationName: "CreateWorkspaceWebhook",
        query: CreateWorkspaceWebhookDocument,
        variables: {
          input: {
            events: ["webhook.test"],
            idempotencyKey: rawKey,
            url,
          },
        },
      });
    const ownerResult = await executeCreate(
      owner.jar,
      "https://hooks.example.test/principal-owner",
    );
    const adminResult = await executeCreate(
      admin.jar,
      "https://hooks.example.test/principal-admin",
    );
    const foreignResult = await executeCreate(
      foreign.jar,
      "https://hooks.example.test/principal-owner",
    );
    expect(ownerResult.body?.errors).toBeUndefined();
    expect(adminResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(
      new Set([
        ownerResult.body?.data?.createWebhook.id,
        adminResult.body?.data?.createWebhook.id,
        foreignResult.body?.data?.createWebhook.id,
      ]),
    ).toHaveLength(3);

    expectGraphQLError(
      await executeCreate(
        viewer.jar,
        "https://hooks.example.test/principal-viewer",
      ),
      "FORBIDDEN",
    );
    const apiKey = await fixture.provisionKey(owner, {
      webhook: ["create", "read", "update", "delete"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: apiKey.key,
        operationName: "CreateWorkspaceWebhook",
        query: CreateWorkspaceWebhookDocument,
        variables: {
          input: {
            events: ["webhook.test"],
            idempotencyKey: rawKey,
            url: "https://hooks.example.test/principal-api-key",
          },
        },
      }),
      "FORBIDDEN",
    );
    const claims = await fixture.database
      .select({ keyHash: locationMutationIdempotency.keyHash })
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "webhook.create.graphql"),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.keyHash))).toHaveLength(3);
  });

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
    expect(request?.redirect).toBe("error");
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
    const providerFailure = new Error("transport body with private detail");
    Object.defineProperty(providerFailure, "name", {
      configurable: true,
      value: "provider token sk-live-secret https://private.example.test",
    });
    vi.mocked(lookup).mockRejectedValueOnce(providerFailure);
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
    });
    const serializedDelivery = JSON.stringify(reboundDelivery);
    expect(serializedDelivery).not.toContain("temporarily unavailable");
    expect(serializedDelivery).not.toContain("sk-live-secret");
    expect(serializedDelivery).not.toContain("private.example.test");
    expect(serializedDelivery).not.toContain(
      "transport body with private detail",
    );
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
      replayed: false,
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

  it("advances the same delivery through a retry attempt after a provider failure", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/retry",
        },
      },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "retry webhook ID",
    );
    const queued = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId } },
    });
    const deliveryId = required(
      queued.body?.data?.sendWebhookTestEvent.deliveryId,
      "retry delivery ID",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("upstream unavailable", { status: 502 }),
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
      code: "webhook_http_502",
      failureKind: "retryable",
    });
    await expect(
      handler(
        { deliveryId, webhookId },
        { job: { attemptCount: 1 }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ resultReferences: [deliveryId] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      handler(
        { deliveryId, webhookId },
        { job: { attemptCount: 2 }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ resultReferences: [deliveryId] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

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
      attempt: 2,
      responseStatus: 204,
      redactedError: null,
      nextRetryAt: null,
    });
    expect(delivery?.completedAt).toBeInstanceOf(Date);
  });

  it("terminalizes queued deliveries when an administrator disables their webhook", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/cancelled",
        },
      },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "cancelled webhook ID",
    );
    const queued = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId } },
    });
    const deliveryId = required(
      queued.body?.data?.sendWebhookTestEvent.deliveryId,
      "cancelled delivery ID",
    );

    await fixture.database
      .update(webhooks)
      .set({ state: "disabled", deletedAt: new Date() })
      .where(eq(webhooks.id, webhookId));
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const handler = createWebhookDeliveryHandler({
      database: fixture.database,
      encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
    });

    await expect(
      handler(
        { deliveryId, webhookId },
        { job: { attemptCount: 1 }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ resultReferences: [deliveryId] });
    expect(fetchMock).not.toHaveBeenCalled();

    const [delivery] = await fixture.database
      .select({
        completedAt: webhookDeliveries.completedAt,
        nextRetryAt: webhookDeliveries.nextRetryAt,
        redactedError: webhookDeliveries.redactedError,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(delivery).toMatchObject({
      redactedError: { code: "webhook_disabled" },
      nextRetryAt: null,
    });
    expect(delivery?.completedAt).toBeInstanceOf(Date);

    const cancellationAudits = await fixture.database
      .select({
        action: auditEvents.action,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceId, deliveryId),
          eq(auditEvents.action, "webhook.delivery_cancelled"),
        ),
      );
    expect(cancellationAudits).toEqual([
      {
        action: "webhook.delivery_cancelled",
        redactedDiff: { code: "webhook_disabled" },
      },
    ]);

    await expect(
      handler(
        { deliveryId, webhookId },
        { job: { attemptCount: 2 }, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ resultReferences: [deliveryId] });
    expect(fetchMock).not.toHaveBeenCalled();
    const repeatCancellationAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceId, deliveryId),
          eq(auditEvents.action, "webhook.delivery_cancelled"),
        ),
      );
    expect(repeatCancellationAudits).toHaveLength(1);
  });

  it("replays test-event enqueue references with expiry, malformed, concurrency, and tenant fencing", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/idempotency",
        },
      },
    });
    const webhookId = required(
      created.body?.data?.createWebhook.id,
      "idempotent webhook ID",
    );

    const first = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: {
        input: { id: webhookId, idempotencyKey: "webhook-replay-v1" },
      },
    });
    expect(first.body?.errors).toBeUndefined();
    const firstDeliveryId = required(
      first.body?.data?.sendWebhookTestEvent.deliveryId,
      "first delivery ID",
    );
    const replay = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: {
        input: { id: webhookId, idempotencyKey: "webhook-replay-v1" },
      },
    });
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data?.sendWebhookTestEvent.deliveryId).toBe(
      firstDeliveryId,
    );
    const [replayDeliveryCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.workspaceId, owner.workspaceId),
          eq(webhookDeliveries.webhookId, webhookId),
        ),
      );
    expect(Number(replayDeliveryCount?.count)).toBe(1);

    const concurrent = await Promise.all(
      Array.from({ length: 2 }, () =>
        fixture.execute<{
          sendWebhookTestEvent: { deliveryId: string | null };
        }>({
          jar: owner.jar,
          operationName: "SendWorkspaceWebhookTestEvent",
          query: SendWorkspaceWebhookTestEventDocument,
          variables: {
            input: { id: webhookId, idempotencyKey: "webhook-concurrent-v1" },
          },
        }),
      ),
    );
    expect(concurrent.every((result) => !result.body?.errors)).toBe(true);
    const concurrentDeliveryIds = concurrent.map((result) =>
      required(
        result.body?.data?.sendWebhookTestEvent.deliveryId,
        "concurrent delivery ID",
      ),
    );
    expect(concurrentDeliveryIds[0]).toBe(concurrentDeliveryIds[1]);
    const [concurrentDeliveryCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.workspaceId, owner.workspaceId),
          eq(webhookDeliveries.webhookId, webhookId),
        ),
      );
    expect(Number(concurrentDeliveryCount?.count)).toBe(2);
    const [concurrentJobCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, owner.workspaceId),
          eq(jobs.kind, "webhook_delivery"),
        ),
      );
    expect(Number(concurrentJobCount?.count)).toBe(2);

    const malformedKey = "webhook-malformed-v1";
    const malformed = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId, idempotencyKey: malformedKey } },
    });
    expect(malformed.body?.errors).toBeUndefined();
    const [malformedClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "webhook.test-event.send"),
        ),
      )
      .orderBy(sql`${idempotencyKeys.createdAt} desc`)
      .limit(1);
    if (!malformedClaim) throw new Error("Missing malformed-reference claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { deliveryId: ["invalid"] } })
      .where(eq(idempotencyKeys.id, malformedClaim.id));
    const malformedReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId, idempotencyKey: malformedKey } },
    });
    expectGraphQLError(malformedReplay, "VALIDATION_FAILED");

    await fixture.database
      .update(idempotencyKeys)
      .set({
        responseReference: {
          webhookId,
          deliveryId: randomUUID(),
        },
      })
      .where(eq(idempotencyKeys.id, malformedClaim.id));
    const missingDeliveryReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId, idempotencyKey: malformedKey } },
    });
    expectGraphQLError(missingDeliveryReplay, "VALIDATION_FAILED");

    const expiryKey = "webhook-expiry-v1";
    const expiryFirst = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId, idempotencyKey: expiryKey } },
    });
    const expiryFirstDeliveryId = required(
      expiryFirst.body?.data?.sendWebhookTestEvent.deliveryId,
      "expiry first delivery ID",
    );
    const [expiryClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "webhook.test-event.send"),
        ),
      )
      .orderBy(sql`${idempotencyKeys.createdAt} desc`)
      .limit(1);
    if (!expiryClaim) throw new Error("Missing expiry claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(idempotencyKeys.id, expiryClaim.id));
    const expiryTakeover = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: owner.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: { input: { id: webhookId, idempotencyKey: expiryKey } },
    });
    const expiryTakeoverDeliveryId = required(
      expiryTakeover.body?.data?.sendWebhookTestEvent.deliveryId,
      "expiry takeover delivery ID",
    );
    expect(expiryTakeoverDeliveryId).not.toBe(expiryFirstDeliveryId);

    const foreign = await fixture.createActor();
    const foreignCreated = await fixture.execute<{
      createWebhook: { id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "CreateWorkspaceWebhook",
      query: CreateWorkspaceWebhookDocument,
      variables: {
        input: {
          events: ["webhook.test"],
          url: "https://hooks.example.test/foreign-idempotency",
        },
      },
    });
    const foreignWebhookId = required(
      foreignCreated.body?.data?.createWebhook.id,
      "foreign webhook ID",
    );
    const foreignResult = await fixture.execute<{
      sendWebhookTestEvent: { deliveryId: string | null };
    }>({
      jar: foreign.jar,
      operationName: "SendWorkspaceWebhookTestEvent",
      query: SendWorkspaceWebhookTestEventDocument,
      variables: {
        input: { id: foreignWebhookId, idempotencyKey: "webhook-replay-v1" },
      },
    });
    expect(foreignResult.body?.errors).toBeUndefined();
    const foreignDeliveryId = required(
      foreignResult.body?.data?.sendWebhookTestEvent.deliveryId,
      "foreign delivery ID",
    );
    expect(foreignDeliveryId).not.toBe(firstDeliveryId);
    const [foreignClaim] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.operation, "webhook.test-event.send"),
          eq(idempotencyKeys.workspaceId, foreign.workspaceId),
        ),
      );
    expect(Number(foreignClaim?.count)).toBe(1);
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
