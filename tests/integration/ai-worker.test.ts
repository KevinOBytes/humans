// @vitest-environment node

import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { newId } from "@/db/id";
import { aiCitations, aiMessages, aiRuns, aiToolCalls } from "@/db/schema/ai";
import { members, sessions } from "@/db/schema/auth";
import { auditEvents, jobs } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import type { RedisStore } from "@/lib/redis";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import type { AiProvider, AiProviderTurn } from "@/modules/ai/provider";
import {
  createAiAnalysisService,
  type AiAnalysisRuntime,
} from "@/modules/ai/service";
import { createResearchTools } from "@/modules/ai/tools";
import { createJobsRepository, type JobRow } from "@/modules/jobs/repository";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createAiAnalysisHandler } from "@/worker/handlers/ai-analysis";
import { createJobRegistry } from "@/worker/registry";
import { runJobsOnce } from "@/worker/run-once";

import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "8e".repeat(32);
const hmacKey = "9a".repeat(32);
const providerIdentity = Object.freeze({
  disclosure: Object.freeze({
    model: "worker-fixture-model",
    provider: "COMPATIBLE" as const,
  }),
  baseUrlFingerprint: "9b".repeat(32),
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required AI worker fixture is missing");
  return value;
}

function fakeProvider(
  generate: AiProvider["generate"],
): AiProvider & { generate: ReturnType<typeof vi.fn<AiProvider["generate"]>> } {
  return {
    ...providerIdentity,
    generate: vi.fn<AiProvider["generate"]>(generate),
  };
}

class MemoryRedis implements RedisStore {
  private readonly leases = new Map<string, string>();

  get() {
    return Promise.resolve(null);
  }
  set() {
    return Promise.resolve();
  }
  delete() {
    return Promise.resolve();
  }
  increment() {
    return Promise.resolve(1);
  }
  consumeTokenBucket() {
    return Promise.resolve({
      allowed: true,
      remainingMicrotokens: 0,
      retryAfterMs: 0,
    });
  }
  acquireLease(key: string, token: string) {
    if (this.leases.has(key)) return Promise.resolve(false);
    this.leases.set(key, token);
    return Promise.resolve(true);
  }
  extendLease(key: string, token: string) {
    return Promise.resolve(this.leases.get(key) === token);
  }
  releaseLease(key: string, token: string) {
    if (this.leases.get(key) !== token) return Promise.resolve(false);
    this.leases.delete(key);
    return Promise.resolve(true);
  }
}

liveDescribe("authorized durable AI execution handler", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function aiContext(
    actor: SessionActor,
  ): Promise<ResearchServiceContext> {
    const [session] = await fixture.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, actor.userId),
          eq(sessions.activeOrganizationId, actor.organizationId),
        ),
      )
      .limit(1);
    return {
      actor: {
        type: "user",
        id: actor.userId,
        principalId: actor.principalId,
        sessionId: required(session).id,
        memberId: actor.memberId,
        role: "owner",
      },
      database: fixture.database,
      permissions: rolePermissionKeys("owner"),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    };
  }

  function service(context: ResearchServiceContext) {
    const runtime: AiAnalysisRuntime = {
      encryptionKey,
      hmacKey,
      provider: providerIdentity,
    };
    return createAiAnalysisService(context, runtime);
  }

  async function claimedAnalysis(input: {
    actor: SessionActor;
    personId?: string;
  }) {
    const context = await aiContext(input.actor);
    const run = await service(context).startAiAnalysis({
      idempotencyKey: `worker-ai-${newId()}`,
      question: "Who is this person?",
      scope: input.personId ? { personIds: [input.personId] } : undefined,
    });
    const leaseOwner = newId();
    const [job] = await createJobsRepository(fixture.database).claimDue({
      leaseDurationMs: 60_000,
      leaseOwner,
      limit: 1,
      now: new Date(),
    });
    return { context, job: required(job), run };
  }

  function createTools(
    getPerson: (
      id: string,
    ) => Promise<Readonly<Record<string, unknown>> | null>,
  ) {
    return ({
      run,
    }: {
      run: {
        scope: { personIds: readonly string[]; evidenceIds: readonly string[] };
      };
    }) =>
      createResearchTools({
        scope: run.scope,
        people: { get: getPerson },
        evidence: { getEvidence: async () => null },
        search: { search: async () => ({ nodes: [] }) },
        graph: { query: async () => ({ nodes: [], edges: [] }) },
      });
  }

  function handlerContext(job: JobRow, signal = new AbortController().signal) {
    return {
      job,
      renewLease: vi.fn(async () => true),
      signal,
    };
  }

  function handler(input: {
    provider: AiProvider;
    getPerson?: (
      id: string,
    ) => Promise<Readonly<Record<string, unknown>> | null>;
  }) {
    return createAiAnalysisHandler({
      database: fixture.database,
      encryptionKey,
      hmacKey,
      provider: input.provider,
      createTools: createTools(input.getPerson ?? (async () => null)),
    });
  }

  async function scopedPerson(actor: SessionActor, displayName: string) {
    const response = await fixture.createPerson(actor, { displayName });
    return required(response.body?.data?.createPerson?.person?.id);
  }

  it("persists one authorized cited answer and replays without duplicate output", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Worker Citation Person");
    const claimed = await claimedAnalysis({ actor, personId });
    const turns: AiProviderTurn[] = [
      {
        type: "tool_calls",
        toolCalls: [
          {
            id: "person-call",
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
    const provider = fakeProvider(async () => required(turns.shift()));
    const getPerson = vi.fn(async (id: string) => ({
      id,
      displayName: "Worker Citation Person",
      status: "active",
    }));
    const execute = handler({ provider, getPerson });
    const context = handlerContext(claimed.job);

    await expect(
      execute({ kind: "ai_execute", runId: claimed.run.id }, context),
    ).resolves.toEqual({ resultReferences: [claimed.run.id] });
    await expect(
      execute({ kind: "ai_execute", runId: claimed.run.id }, context),
    ).resolves.toEqual({ resultReferences: [claimed.run.id] });

    const [storedRun] = await fixture.database
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.id, claimed.run.id));
    const toolCalls = await fixture.database.select().from(aiToolCalls);
    const citations = await fixture.database.select().from(aiCitations);
    const assistantMessages = await fixture.database
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.role, "assistant"));
    expect(storedRun).toMatchObject({ state: "completed", errorCode: null });
    expect(toolCalls).toEqual([
      expect.objectContaining({
        approvedToolName: "getperson",
        redactedArguments: { personCount: 1 },
        redactedResultSummary: { personCount: 1, resultCount: 1 },
        resourceReferences: [{ id: personId, kind: "person" }],
      }),
    ]);
    expect(citations).toEqual([
      expect.objectContaining({
        resourceId: personId,
        resourceKind: "person",
        claimText: "The person record is present.",
      }),
    ]);
    expect(assistantMessages).toHaveLength(1);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(
      provider.generate.mock.calls[0]?.[0].tools.map((tool) => tool.name),
    ).toEqual(["getEvidence", "getPerson", "searchGraph", "searchPeople"]);
    expect(getPerson).toHaveBeenCalledTimes(1);
    expect(claimed.job.state).toBe("running");
  });

  it("leaves durable job completion to the existing fenced executor", async () => {
    const actor = await fixture.createActor("owner");
    const context = await aiContext(actor);
    const run = await service(context).startAiAnalysis({
      idempotencyKey: `worker-executor-${newId()}`,
      question: "Complete through the executor",
    });
    const provider = fakeProvider(async () => ({
      type: "answer",
      answer: "Executor-owned completion",
      citations: [],
    }));
    const aiExecute = handler({ provider });
    const registry = createJobRegistry({
      aiExecute,
      fileCleanup: async () => undefined,
      importExecute: async () => undefined,
    });

    await expect(
      runJobsOnce({
        database: fixture.database,
        encryptionKey,
        redis: new MemoryRedis(),
        registry,
        workerId: newId(),
      }),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect((await fixture.database.select().from(jobs))[0]).toMatchObject({
      state: "completed",
      resultReferences: [run.id],
    });
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "completed",
    });
  });

  it("invokes no service after membership revocation during the provider boundary", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Revoked Worker Person");
    const claimed = await claimedAnalysis({ actor, personId });
    const getPerson = vi.fn(async () => ({ id: personId }));
    const provider = fakeProvider(async () => {
      await fixture.database
        .delete(members)
        .where(eq(members.id, actor.memberId));
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "revoked-call",
            name: "getPerson",
            arguments: { personId },
          },
        ],
      };
    });

    await expect(
      handler({ provider, getPerson })(
        { kind: "ai_execute", runId: claimed.run.id },
        handlerContext(claimed.job),
      ),
    ).rejects.toMatchObject({
      code: "authorization_changed",
      failureKind: "permanent",
    });
    expect(getPerson).not.toHaveBeenCalled();
    expect(await fixture.database.select().from(aiToolCalls)).toHaveLength(0);
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "failed",
      errorCode: "authorization_changed",
    });
  });

  it("rejects citations that no successful tool returned", async () => {
    const actor = await fixture.createActor("owner");
    const claimed = await claimedAnalysis({ actor });
    const provider = fakeProvider(async () => ({
      type: "answer",
      answer: "Forged answer",
      citations: [{ resourceId: newId(), excerpt: "Forged claim" }],
    }));

    await expect(
      handler({ provider })(
        { kind: "ai_execute", runId: claimed.run.id },
        handlerContext(claimed.job),
      ),
    ).rejects.toMatchObject({
      code: "provider_invalid_response",
      failureKind: "permanent",
    });
    expect(await fixture.database.select().from(aiCitations)).toHaveLength(0);
    expect(
      await fixture.database
        .select()
        .from(aiMessages)
        .where(eq(aiMessages.role, "assistant")),
    ).toHaveLength(0);
  });

  it("reauthorizes the full resource scope before the final write", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Hidden Worker Person");
    const claimed = await claimedAnalysis({ actor, personId });
    let generation = 0;
    const provider = fakeProvider(async () => {
      generation += 1;
      if (generation === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "hidden-call",
              name: "getPerson",
              arguments: { personId },
            },
          ],
        };
      }
      await fixture.database
        .update(people)
        .set({ deletedAt: new Date(), deletedBy: actor.principalId })
        .where(eq(people.id, personId));
      return {
        type: "answer",
        answer: "Now hidden",
        citations: [{ resourceId: personId, excerpt: "Hidden claim" }],
      };
    });

    await expect(
      handler({ provider, getPerson: async (id) => ({ id }) })(
        { kind: "ai_execute", runId: claimed.run.id },
        handlerContext(claimed.job),
      ),
    ).rejects.toMatchObject({ code: "authorization_changed" });
    expect(await fixture.database.select().from(aiToolCalls)).toHaveLength(1);
    expect(await fixture.database.select().from(aiCitations)).toHaveLength(0);
    expect(
      await fixture.database
        .select()
        .from(aiMessages)
        .where(eq(aiMessages.role, "assistant")),
    ).toHaveLength(0);
  });

  it("stops repeated tool requests at the four-boundary limit", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Bounded Worker Person");
    const claimed = await claimedAnalysis({ actor, personId });
    let call = 0;
    const provider = fakeProvider(async () => ({
      type: "tool_calls",
      toolCalls: [
        {
          id: `bounded-call-${(call += 1)}`,
          name: "getPerson",
          arguments: { personId },
        },
      ],
    }));
    const getPerson = vi.fn(async () => ({ id: personId }));

    await expect(
      handler({ provider, getPerson })(
        { kind: "ai_execute", runId: claimed.run.id },
        handlerContext(claimed.job),
      ),
    ).rejects.toMatchObject({
      code: "analysis_limit_reached",
      failureKind: "permanent",
    });
    expect(provider.generate).toHaveBeenCalledTimes(4);
    expect(getPerson).toHaveBeenCalledTimes(4);
    expect(await fixture.database.select().from(aiToolCalls)).toHaveLength(4);
  });

  it("keeps the four-provider-turn cap across durable executor retries", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Retried Provider Person");
    const context = await aiContext(actor);
    await service(context).startAiAnalysis({
      idempotencyKey: `worker-provider-cap-${newId()}`,
      question: "Keep provider turns bounded across retries",
      scope: { personIds: [personId] },
    });
    let generation = 0;
    const provider = fakeProvider(async () => {
      generation += 1;
      if (generation === 2) {
        throw Object.assign(new Error("temporary provider outage"), {
          code: "PROVIDER_UNAVAILABLE",
        });
      }
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: `provider-cap-call-${generation}`,
            name: "getPerson",
            arguments: { personId },
          },
        ],
      };
    });
    const getPerson = vi.fn(async () => ({ id: personId }));
    const registry = createJobRegistry({
      aiExecute: handler({ provider, getPerson }),
      fileCleanup: async () => undefined,
      importExecute: async () => undefined,
    });
    const redis = new MemoryRedis();

    await expect(
      runJobsOnce({
        database: fixture.database,
        encryptionKey,
        random: () => 0,
        redis,
        registry,
        workerId: newId(),
      }),
    ).resolves.toMatchObject({ claimed: 1, deferred: 1 });
    await fixture.database.update(jobs).set({ scheduledAt: new Date(0) });
    await expect(
      runJobsOnce({
        database: fixture.database,
        encryptionKey,
        redis,
        registry,
        workerId: newId(),
      }),
    ).resolves.toMatchObject({ claimed: 1, deadLettered: 1 });

    expect(provider.generate).toHaveBeenCalledTimes(5);
    expect(getPerson).toHaveBeenCalledTimes(4);
    expect(await fixture.database.select().from(aiToolCalls)).toHaveLength(4);
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "failed",
      errorCode: "analysis_limit_reached",
    });
  });

  it("keeps the four-tool-call cap across durable executor retries", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Retried Tool Person");
    const context = await aiContext(actor);
    await service(context).startAiAnalysis({
      idempotencyKey: `worker-tool-cap-${newId()}`,
      question: "Keep tool calls bounded across retries",
      scope: { personIds: [personId] },
    });
    let generation = 0;
    const provider = fakeProvider(async () => {
      generation += 1;
      if (generation === 1) {
        return {
          type: "tool_calls",
          toolCalls: [1, 2, 3].map((value) => ({
            id: `tool-cap-first-${value}`,
            name: "getPerson" as const,
            arguments: { personId },
          })),
        };
      }
      if (generation === 2) {
        throw Object.assign(new Error("temporary provider outage"), {
          code: "PROVIDER_UNAVAILABLE",
        });
      }
      if (generation === 3) {
        return {
          type: "tool_calls",
          toolCalls: [1, 2].map((value) => ({
            id: `tool-cap-second-${value}`,
            name: "getPerson" as const,
            arguments: { personId },
          })),
        };
      }
      return {
        type: "answer",
        answer: "This must not finalize after a fifth tool call.",
        citations: [],
      };
    });
    const getPerson = vi.fn(async () => ({ id: personId }));
    const registry = createJobRegistry({
      aiExecute: handler({ provider, getPerson }),
      fileCleanup: async () => undefined,
      importExecute: async () => undefined,
    });
    const redis = new MemoryRedis();

    await expect(
      runJobsOnce({
        database: fixture.database,
        encryptionKey,
        random: () => 0,
        redis,
        registry,
        workerId: newId(),
      }),
    ).resolves.toMatchObject({ claimed: 1, deferred: 1 });
    await fixture.database.update(jobs).set({ scheduledAt: new Date(0) });
    await expect(
      runJobsOnce({
        database: fixture.database,
        encryptionKey,
        redis,
        registry,
        workerId: newId(),
      }),
    ).resolves.toMatchObject({ claimed: 1, deadLettered: 1 });

    expect(provider.generate).toHaveBeenCalledTimes(3);
    expect(getPerson).toHaveBeenCalledTimes(3);
    expect(await fixture.database.select().from(aiToolCalls)).toHaveLength(3);
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "failed",
      errorCode: "analysis_limit_reached",
    });
  });

  it("retries provider failures and records only the final stable code", async () => {
    const actor = await fixture.createActor("owner");
    const context = await aiContext(actor);
    const run = await service(context).startAiAnalysis({
      idempotencyKey: `worker-retry-${newId()}`,
      question: "Retry through the durable executor",
    });
    const rawSecret = "sk-secret prompt https://provider.example Authorization";
    const provider = fakeProvider(async () => {
      throw Object.assign(new Error(rawSecret), {
        code: "PROVIDER_UNAVAILABLE",
      });
    });
    const registry = createJobRegistry({
      aiExecute: handler({ provider }),
      fileCleanup: async () => undefined,
      importExecute: async () => undefined,
    });
    const redis = new MemoryRedis();
    const [queuedJob] = await fixture.database.select().from(jobs);
    const summaries = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      summaries.push(
        await runJobsOnce({
          database: fixture.database,
          encryptionKey,
          random: () => 0,
          redis,
          registry,
          workerId: newId(),
        }),
      );
      if (attempt < 5) {
        await fixture.database
          .update(jobs)
          .set({ scheduledAt: new Date(0) })
          .where(eq(jobs.id, required(queuedJob).id));
      }
    }

    expect(summaries.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({ claimed: 1, deferred: 1 }),
      ),
    );
    expect(summaries[4]).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect((await fixture.database.select().from(jobs))[0]).toMatchObject({
      state: "dead_letter",
      errorCode: "provider_unavailable",
      resultReferences: [],
    });
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      id: run.id,
      state: "failed",
      errorCode: "provider_unavailable",
    });
    expect(provider.generate).toHaveBeenCalledTimes(5);
    expect(
      JSON.stringify({
        audits: await fixture.database.select().from(auditEvents),
        runs: await fixture.database.select().from(aiRuns),
        tools: await fixture.database.select().from(aiToolCalls),
      }),
    ).not.toContain(rawSecret);
  });

  it("persists no stale output when cancellation wins during a tool boundary", async () => {
    const actor = await fixture.createActor("owner");
    const personId = await scopedPerson(actor, "Cancelled Worker Person");
    const claimed = await claimedAnalysis({ actor, personId });
    const controller = new AbortController();
    const getPerson = vi.fn(async () => {
      controller.abort();
      return { id: personId };
    });
    const provider = fakeProvider(async () => ({
      type: "tool_calls",
      toolCalls: [
        {
          id: "cancelled-call",
          name: "getPerson",
          arguments: { personId },
        },
      ],
    }));

    await expect(
      handler({ provider, getPerson })(
        { kind: "ai_execute", runId: claimed.run.id },
        handlerContext(claimed.job, controller.signal),
      ),
    ).rejects.toMatchObject({ code: "analysis_cancelled" });
    expect(getPerson).toHaveBeenCalledTimes(1);
    expect(await fixture.database.select().from(aiToolCalls)).toHaveLength(0);
    expect(
      await fixture.database
        .select()
        .from(aiMessages)
        .where(eq(aiMessages.role, "assistant")),
    ).toHaveLength(0);
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "running",
      errorCode: null,
    });
  });

  it("persists nothing when the executor lease is lost before finalization", async () => {
    const actor = await fixture.createActor("owner");
    const claimed = await claimedAnalysis({ actor });
    const provider = fakeProvider(async () => ({
      type: "answer",
      answer: "Stale answer",
      citations: [],
    }));
    const context = handlerContext(claimed.job);
    context.renewLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      handler({ provider })(
        { kind: "ai_execute", runId: claimed.run.id },
        context,
      ),
    ).rejects.toMatchObject({ code: "lease_lost" });
    expect(
      await fixture.database
        .select()
        .from(aiMessages)
        .where(eq(aiMessages.role, "assistant")),
    ).toHaveLength(0);
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "running",
      errorCode: null,
    });
  });

  it("does not call the provider for an already aborted execution", async () => {
    const actor = await fixture.createActor("owner");
    const claimed = await claimedAnalysis({ actor });
    const provider = fakeProvider(async () => ({
      type: "answer",
      answer: "Must not run",
      citations: [],
    }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      handler({ provider })(
        { kind: "ai_execute", runId: claimed.run.id },
        handlerContext(claimed.job, controller.signal),
      ),
    ).rejects.toMatchObject({ code: "analysis_cancelled" });
    expect(provider.generate).not.toHaveBeenCalled();
    expect((await fixture.database.select().from(aiRuns))[0]).toMatchObject({
      state: "pending",
      errorCode: null,
    });
  });
});
