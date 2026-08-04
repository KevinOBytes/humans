// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { aiThreads } from "@/db/schema/ai";
import { apiKeys } from "@/db/schema/auth";
import { people } from "@/db/schema/people";
import { workspacePrincipals } from "@/db/schema/principals";
import { OperationLimiter } from "@/graphql/operation-limiter";
import type { RedisStore } from "@/lib/redis";
import type { AiProvider, AiProviderTurn } from "@/modules/ai/provider";
import type { AiAnalysisRuntime } from "@/modules/ai/service";
import { createResearchTools } from "@/modules/ai/tools";
import { createJobsRepository } from "@/modules/jobs/repository";
import { createAiAnalysisHandler } from "@/worker/handlers/ai-analysis";

import {
  GraphQLFixture,
  expectGraphQLError,
  type OperationResult,
  type SessionActor,
} from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "a1".repeat(32);
const hmacKey = "a2".repeat(32);
const providerIdentity = Object.freeze({
  disclosure: Object.freeze({
    model: "graphql-fixture-model",
    provider: "COMPATIBLE" as const,
  }),
  baseUrlFingerprint: "a3".repeat(32),
});
const aiRuntime: AiAnalysisRuntime = {
  encryptionKey,
  hmacKey,
  provider: providerIdentity,
};

const RUN_FIELDS = /* GraphQL */ `
  fragment AiRunProjection on AiRun {
    id
    state
    provider
    model
    answer
    errorCode
    createdAt
    startedAt
    completedAt
    citations {
      resourceKind
      resourceId
      claimText
      locator
    }
    toolCalls {
      name
      state
      inputSummary {
        evidenceCount
        filterCount
        personCount
        resourceCount
        resultCount
        truncated
      }
      resultSummary {
        evidenceCount
        filterCount
        personCount
        resourceCount
        resultCount
        truncated
      }
      startedAt
      completedAt
    }
  }
`;

const START = /* GraphQL */ `
  ${RUN_FIELDS}
  mutation StartAiAnalysis($input: StartAiAnalysisInput!) {
    startAiAnalysis(input: $input) {
      ...AiRunProjection
    }
  }
`;
const READ = /* GraphQL */ `
  ${RUN_FIELDS}
  query AiRun($id: UUID!) {
    aiRun(id: $id) {
      ...AiRunProjection
    }
  }
`;
const CANCEL = /* GraphQL */ `
  ${RUN_FIELDS}
  mutation CancelAiAnalysis($id: UUID!) {
    cancelAiAnalysis(id: $id) {
      ...AiRunProjection
    }
  }
`;

type RunProjection = {
  id: string;
  state: string;
  provider: string;
  model: string;
  answer: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  citations: Array<{
    resourceKind: string;
    resourceId: string;
    claimText: string;
    locator: string | null;
  }>;
  toolCalls: Array<{
    name: string;
    state: string;
    inputSummary: Record<string, number | boolean | null>;
    resultSummary: Record<string, number | boolean | null> | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
};

type Credentials =
  | { jar: SessionActor["jar"]; apiKey?: never; origin?: never }
  | { apiKey: string; jar?: never; origin: null };

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required AI GraphQL fixture is missing");
  return value;
}

function runFrom(
  result: OperationResult<{
    aiRun?: RunProjection;
    cancelAiAnalysis?: RunProjection;
    startAiAnalysis?: RunProjection;
  }>,
): RunProjection {
  return required(
    result.body?.data?.startAiAnalysis ??
      result.body?.data?.aiRun ??
      result.body?.data?.cancelAiAnalysis,
  );
}

liveDescribe("canonical AI analyst GraphQL API", () => {
  let fixture: GraphQLFixture;

  beforeAll(() => {
    fixture = new GraphQLFixture({ aiRuntime });
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function start(
    credentials: Credentials,
    input: {
      idempotencyKey: string;
      question: string;
      scope?: { evidenceIds?: string[]; personIds?: string[] };
    },
  ) {
    return fixture.execute<{ startAiAnalysis: RunProjection }>({
      ...credentials,
      operationName: "StartAiAnalysis",
      query: START,
      variables: { input },
    });
  }

  async function read(credentials: Credentials, id: string) {
    return fixture.execute<{ aiRun: RunProjection }>({
      ...credentials,
      operationName: "AiRun",
      query: READ,
      variables: { id },
    });
  }

  async function cancel(credentials: Credentials, id: string) {
    return fixture.execute<{ cancelAiAnalysis: RunProjection }>({
      ...credentials,
      operationName: "CancelAiAnalysis",
      query: CANCEL,
      variables: { id },
    });
  }

  it("starts, replays, reads, conflicts, and cancels a user-owned run", async () => {
    const actor = await fixture.createSessionActor({ role: "analyst" });
    const credentials: Credentials = { jar: actor.jar };
    const idempotencyKey = `graphql-user-${newId()}`;
    const first = await start(credentials, {
      idempotencyKey,
      question: "Which evidence supports this relationship?",
    });

    expect(first.body?.errors).toBeUndefined();
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(runFrom(first)).toMatchObject({
      answer: null,
      citations: [],
      errorCode: null,
      model: "graphql-fixture-model",
      provider: "COMPATIBLE",
      state: "PENDING",
      toolCalls: [],
    });

    const replay = await start(credentials, {
      idempotencyKey,
      question: "Which evidence supports this relationship?",
    });
    expect(runFrom(replay).id).toBe(runFrom(first).id);

    const conflict = await start(credentials, {
      idempotencyKey,
      question: "A different request must not reuse this key.",
    });
    expectGraphQLError(conflict, "CONFLICT");

    const fetched = await read(credentials, runFrom(first).id);
    expect(fetched.body?.errors).toBeUndefined();
    expect(runFrom(fetched).id).toBe(runFrom(first).id);

    const cancelled = await cancel(credentials, runFrom(first).id);
    expect(cancelled.body?.errors).toBeUndefined();
    expect(runFrom(cancelled)).toMatchObject({
      id: runFrom(first).id,
      state: "CANCELLED",
    });
    expect(runFrom(cancelled).completedAt).not.toBeNull();
  });

  it("uses API-key permissions and attributes starts to its workspace principal", async () => {
    const owner = await fixture.createSessionActor();
    const key = await fixture.provisionKey(owner, {
      analysis: ["create", "read", "run", "cancel"],
    });
    const credentials: Credentials = { apiKey: key.key, origin: null };
    const started = await start(credentials, {
      idempotencyKey: `graphql-key-${newId()}`,
      question: "Summarize the scoped workspace.",
    });
    expect(started.body?.errors).toBeUndefined();

    const [principal] = await fixture.database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(
        and(
          eq(workspacePrincipals.workspaceId, owner.workspaceId),
          eq(workspacePrincipals.apiKeyId, key.id),
        ),
      );
    const [thread] = await fixture.database
      .select({ createdBy: aiThreads.createdBy, ownerId: aiThreads.ownerId })
      .from(aiThreads);
    expect(thread).toEqual({
      createdBy: required(principal).id,
      ownerId: required(principal).id,
    });

    expect(
      (await read(credentials, runFrom(started).id)).body?.errors,
    ).toBeUndefined();
    expect(
      (await cancel(credentials, runFrom(started).id)).body?.errors,
    ).toBeUndefined();
  });

  it("requires the exact operation permissions", async () => {
    const owner = await fixture.createSessionActor();
    for (const analysis of [
      ["create", "read"],
      ["read", "run"],
    ] as const) {
      const key = await fixture.provisionKey(owner, { analysis });
      expectGraphQLError(
        await start(
          { apiKey: key.key, origin: null },
          {
            idempotencyKey: `graphql-denied-${newId()}`,
            question: "This start is missing one required permission.",
          },
        ),
        "FORBIDDEN",
      );
    }

    const key = await fixture.provisionKey(owner, {
      analysis: ["create", "read", "run", "cancel"],
    });
    const credentials: Credentials = { apiKey: key.key, origin: null };
    const started = await start(credentials, {
      idempotencyKey: `graphql-permissions-${newId()}`,
      question: "Create an owned run before permission changes.",
    });
    const runId = runFrom(started).id;

    await fixture.database
      .update(apiKeys)
      .set({ permissions: JSON.stringify({ analysis: ["cancel"] }) })
      .where(eq(apiKeys.id, key.id));
    expectGraphQLError(await read(credentials, runId), "FORBIDDEN");

    await fixture.database
      .update(apiKeys)
      .set({ permissions: JSON.stringify({ analysis: ["read"] }) })
      .where(eq(apiKeys.id, key.id));
    expect((await read(credentials, runId)).body?.errors).toBeUndefined();
    expectGraphQLError(await cancel(credentials, runId), "FORBIDDEN");
  });

  it("does not add analysis:read to start or cancel", async () => {
    const owner = await fixture.createSessionActor();
    const key = await fixture.provisionKey(owner, {
      analysis: ["create", "run"],
    });
    const credentials: Credentials = { apiKey: key.key, origin: null };
    const started = await start(credentials, {
      idempotencyKey: `graphql-exact-start-${newId()}`,
      question: "Start with only the two mutation permissions.",
    });
    expect(started.body?.errors).toBeUndefined();
    expect(runFrom(started)).toMatchObject({ state: "PENDING" });
    expectGraphQLError(
      await read(credentials, runFrom(started).id),
      "FORBIDDEN",
    );

    await fixture.database
      .update(apiKeys)
      .set({ permissions: JSON.stringify({ analysis: ["cancel"] }) })
      .where(eq(apiKeys.id, key.id));
    const cancelled = await cancel(credentials, runFrom(started).id);
    expect(cancelled.body?.errors).toBeUndefined();
    expect(runFrom(cancelled)).toMatchObject({ state: "CANCELLED" });
    expectGraphQLError(
      await read(credentials, runFrom(cancelled).id),
      "FORBIDDEN",
    );
  });

  it("returns the same non-disclosing NOT_FOUND envelope across principals and workspaces", async () => {
    const owner = await fixture.createSessionActor();
    const otherWorkspace = await fixture.createSessionActor();
    const peerKey = await fixture.provisionKey(owner, {
      analysis: ["read", "cancel"],
    });
    const started = await start(
      { jar: owner.jar },
      {
        idempotencyKey: `graphql-private-${newId()}`,
        question: "Keep this analysis private to its principal.",
      },
    );
    const runId = runFrom(started).id;
    const credentials: Credentials[] = [
      { apiKey: peerKey.key, origin: null },
      { jar: otherWorkspace.jar },
    ];

    for (const credential of credentials) {
      const hiddenRead = await read(credential, runId);
      const hiddenCancel = await cancel(credential, runId);
      expectGraphQLError(hiddenRead, "NOT_FOUND");
      expectGraphQLError(hiddenCancel, "NOT_FOUND");
      expect(hiddenRead.body?.errors?.[0]?.message).toBe(
        hiddenCancel.body?.errors?.[0]?.message,
      );
      expect(JSON.stringify(hiddenRead.body)).not.toContain(owner.workspaceId);
    }
  });

  it("returns only validated citations and count-only tool summaries", async () => {
    const actor = await fixture.createSessionActor({ role: "analyst" });
    const personId = newId();
    await fixture.database.insert(people).values({
      id: personId,
      workspaceId: actor.workspaceId,
      displayName: "Cited GraphQL Person",
      sensitivity: "internal",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const started = await start(
      { jar: actor.jar },
      {
        idempotencyKey: `graphql-citation-${newId()}`,
        question: "Who is in the requested scope?",
        scope: { personIds: [personId] },
      },
    );
    const runId = runFrom(started).id;
    const leaseOwner = newId();
    const [job] = await createJobsRepository(fixture.database).claimDue({
      leaseDurationMs: 60_000,
      leaseOwner,
      limit: 1,
      now: new Date(),
    });
    const turns: AiProviderTurn[] = [
      {
        type: "tool_calls",
        toolCalls: [
          {
            id: "graphql-person-call",
            name: "getPerson",
            arguments: { personId },
          },
        ],
      },
      {
        type: "answer",
        answer: "The scoped person is present.",
        citations: [
          { resourceId: personId, excerpt: "The person record is present." },
        ],
      },
    ];
    const provider: AiProvider = {
      ...providerIdentity,
      generate: async () => required(turns.shift()),
    };
    const handler = createAiAnalysisHandler({
      database: fixture.database,
      encryptionKey,
      hmacKey,
      provider,
      createTools: ({ run }) =>
        createResearchTools({
          scope: run.scope,
          people: {
            get: async (id) => ({
              id,
              displayName: "Cited GraphQL Person",
              status: "active",
            }),
          },
          evidence: { getEvidence: async () => null },
          graph: { query: async () => ({ edges: [], nodes: [] }) },
          search: { search: async () => ({ nodes: [] }) },
        }),
    });
    await handler(
      { kind: "ai_execute", runId },
      {
        job: required(job),
        renewLease: async () => true,
        signal: new AbortController().signal,
      },
    );

    const result = await read({ jar: actor.jar }, runId);
    expect(result.body?.errors).toBeUndefined();
    expect(runFrom(result)).toMatchObject({
      answer: "The scoped person is present.",
      citations: [
        {
          claimText: "The person record is present.",
          locator: null,
          resourceId: personId,
          resourceKind: "PERSON",
        },
      ],
      model: "graphql-fixture-model",
      provider: "COMPATIBLE",
      state: "COMPLETED",
      toolCalls: [
        {
          inputSummary: { personCount: 1 },
          name: "getperson",
          resultSummary: { personCount: 1, resultCount: 1 },
          state: "COMPLETED",
        },
      ],
    });
    const serialized = JSON.stringify(result.body);
    for (const secret of [
      "question",
      "baseUrl",
      "baseUrlFingerprint",
      "providerRequest",
      "apiKey",
      "rawArguments",
      "rawResult",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps inputs, schema exposure, complexity, and operation admission bounded", async () => {
    const actor = await fixture.createSessionActor({ role: "analyst" });
    const unknownInput = await fixture.execute({
      jar: actor.jar,
      query: START,
      variables: {
        input: {
          idempotencyKey: `graphql-closed-${newId()}`,
          question: "Closed input",
          provider: "openai",
          baseUrl: "https://secret-provider.example/v1",
          toolNames: ["arbitraryNetwork"],
        },
      },
    });
    expectGraphQLError(unknownInput, "VALIDATION_FAILED");

    const oversized = await start(
      { jar: actor.jar },
      {
        idempotencyKey: `graphql-oversized-${newId()}`,
        question: "x".repeat(8_001),
      },
    );
    expectGraphQLError(oversized, "VALIDATION_FAILED");

    const forbiddenSelection = await fixture.execute({
      jar: actor.jar,
      query: `query ForbiddenAiField($id: UUID!) { aiRun(id: $id) { id prompt } }`,
      variables: { id: newId() },
    });
    expectGraphQLError(forbiddenSelection, "VALIDATION_FAILED");

    const aliasBomb = Array.from(
      { length: 16 },
      (_, index) => `a${index}: aiRun(id: "${newId()}") { id }`,
    ).join("\n");
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        query: `query AiAliasBudget { ${aliasBomb} }`,
      }),
      "VALIDATION_FAILED",
    );

    const complexityBomb = Array.from(
      { length: 15 },
      (_, index) => `c${index}: aiRun(id: "${newId()}") { id }`,
    ).join("\n");
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        query: `query AiComplexityBudget { ${complexityBomb} }`,
      }),
      "VALIDATION_FAILED",
    );

    const schema = await fixture.execute<{
      run: { fields: Array<{ name: string }> };
      failure: { enumValues: Array<{ name: string }> };
    }>({
      jar: actor.jar,
      query: `query AiSchemaContract {
        run: __type(name: "AiRun") { fields { name } }
        failure: __type(name: "AiFailureCode") { enumValues { name } }
      }`,
    });
    expect(schema.body?.errors).toBeUndefined();
    const fieldNames = required(schema.body?.data?.run).fields.map(
      (field) => field.name,
    );
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        "answer",
        "citations",
        "errorCode",
        "model",
        "provider",
        "state",
        "toolCalls",
      ]),
    );
    expect(fieldNames).not.toEqual(
      expect.arrayContaining([
        "prompt",
        "baseUrl",
        "baseUrlFingerprint",
        "providerRequest",
        "apiKey",
      ]),
    );
    expect(
      required(schema.body?.data?.failure).enumValues.map((item) => item.name),
    ).toEqual([
      "ANALYSIS_CANCELLED",
      "ANALYSIS_LIMIT_REACHED",
      "AUTHORIZATION_CHANGED",
      "EXECUTION_FAILED",
      "INPUT_UNAVAILABLE",
      "PROVIDER_INVALID_RESPONSE",
      "PROVIDER_RESPONSE_TOO_LARGE",
      "PROVIDER_TIMEOUT",
      "PROVIDER_UNAVAILABLE",
    ]);
  });

  it("returns a correlated PROVIDER_UNAVAILABLE error when AI admission is unavailable", async () => {
    const failingLimiter = new OperationLimiter(
      {
        consumeTokenBucket: async () => {
          throw new Error("private limiter dependency detail");
        },
      } satisfies Pick<RedisStore, "consumeTokenBucket">,
      undefined,
      "a4".repeat(32),
    );
    const isolated = new GraphQLFixture({
      aiRuntime,
      operationLimiter: failingLimiter,
    });
    try {
      await isolated.reset();
      const actor = await isolated.createSessionActor({ role: "analyst" });
      const result = await isolated.execute({
        jar: actor.jar,
        operationName: "StartAiAnalysis",
        query: START,
        variables: {
          input: {
            idempotencyKey: `graphql-unavailable-${newId()}`,
            question: "Admission failure is stable and redacted.",
          },
        },
      });
      expectGraphQLError(result, "PROVIDER_UNAVAILABLE");
      expect(JSON.stringify(result.body)).not.toContain(
        "private limiter dependency detail",
      );
    } finally {
      await isolated.close();
    }
  });
});
