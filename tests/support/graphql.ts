// @vitest-environment node

import { eq } from "drizzle-orm";
import type { GraphQLSchema } from "graphql";
import type { Sql } from "postgres";

import { newId } from "@/db/id";
import { members, sessions, users } from "@/db/schema/auth";
import { createSchemaBuilder } from "@/graphql/builder";
import { requirePermission, type GraphQLContext } from "@/graphql/context";
import type { SafeWorkspace } from "@/graphql/loaders";
import { normalizePagination } from "@/graphql/limits";
import { OperationLimiter } from "@/graphql/operation-limiter";
import { createHumansAuth } from "@/lib/auth/config";
import type { TrustedProxyConfig } from "@/lib/network/client-address";
import type { RedisStore } from "@/lib/redis";
import { createGraphQLHandler, type GraphQLLogger } from "@/graphql/server";
import {
  recordDatabaseQuery,
  type PerformanceDiagnosticSettings,
} from "@/graphql/query-instrumentation";
import {
  provisionOrganizationApiKey,
  provisionWorkspace,
} from "@/modules/auth/workspaces";
import type { FileServiceRuntime } from "@/modules/files/service";
import type { ImportServiceRuntime } from "@/modules/imports/service";
import type { WorkspaceMemberRuntime } from "@/modules/settings/workspace-members";
import {
  disabledSearchIndexMaintenance,
  type SearchIndexMaintenance,
} from "@/modules/search/index-maintenance";
import {
  createTask12Metrics,
  disabledMetricsSink,
  type Task12Metrics,
} from "@/modules/search/metrics";
import type { SearchRuntime } from "@/modules/search/service";
import type { AiAnalysisRuntime } from "@/modules/ai/service";

import {
  CookieJar,
  TestEmailSender,
  authRequest,
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
  responseJson,
  testAdminEnv,
  type TestDatabase,
} from "./auth";

const fixturePassword = [
  "Task7",
  "GraphQL",
  "Fixture",
  "Password!",
  "2026",
].join("");

export const VIEWER_QUERY = /* GraphQL */ `
  query Viewer {
    viewer {
      id
      actorType
      role
      permissions
      workspace {
        id
        organizationId
        name
      }
    }
    workspace {
      id
      organizationId
      name
    }
  }
`;

export function createSyntheticGraphQLSchema(): GraphQLSchema {
  const builder = createSchemaBuilder();
  const Workspace = builder
    .objectRef<SafeWorkspace>("SyntheticWorkspace")
    .implement({
      fields: (t) => ({
        id: t.expose("id", { type: "UUID" }),
        name: t.exposeString("name"),
        organizationId: t.exposeString("organizationId"),
      }),
    });
  type DepthNodeShape = { remaining: number };
  const DepthNode = builder.objectRef<DepthNodeShape>("DepthNode");
  DepthNode.implement({
    fields: (t) => ({
      next: t.field({
        nullable: true,
        type: DepthNode,
        resolve: (node) =>
          node.remaining > 0 ? { remaining: node.remaining - 1 } : null,
      }),
      value: t.string({ resolve: () => "value" }),
    }),
  });
  const breadthFields = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [
      `field${index}`,
      (t: never) => t,
    ]),
  );
  const BreadthNode = builder.objectRef<Record<string, boolean>>("BreadthNode");
  BreadthNode.implement({
    fields: (t) =>
      Object.fromEntries(
        Object.keys(breadthFields).map((field) => [
          field,
          t.boolean({ resolve: () => true }),
        ]),
      ),
  });

  builder.queryType({
    fields: (t) => ({
      breadthRoot: t.field({
        type: BreadthNode,
        resolve: () => ({}),
      }),
      depthRoot: t.field({
        type: DepthNode,
        resolve: () => ({ remaining: 20 }),
      }),
      expensive: t.string({
        args: { first: t.arg.int() },
        complexity: (args) => ({
          field: normalizePagination({ first: args.first }).first * 6,
        }),
        resolve: () => "expensive",
      }),
      internalFailure: t.string({
        args: { secret: t.arg.string({ required: true }) },
        resolve: () => {
          throw new Error("database private failure");
        },
      }),
      paginatedWorkspaces: t.field({
        args: {
          after: t.arg.string(),
          before: t.arg.string(),
          first: t.arg.int(),
          last: t.arg.int(),
        },
        complexity: (args) => ({
          field: 1,
          multiplier: normalizePagination(args).first,
        }),
        type: [Workspace],
        resolve: (_root, args, context) => {
          normalizePagination(args);
          return [context.workspace];
        },
      }),
      tenantProbe: t.boolean({
        args: { workspaceId: t.arg({ required: true, type: "UUID" }) },
        resolve: (_root, _args, context) => {
          requirePermission(context, "workspace", "purge");
          return true;
        },
      }),
      workspace: t.field({
        type: Workspace,
        resolve: (_root, _args, context) => context.workspace,
      }),
      workspaceLoads: t.field({
        args: {
          ids: t.arg({ required: true, type: ["UUID"] }),
        },
        complexity: (args) => ({
          field: 6,
          multiplier: args.ids.length,
        }),
        nullable: { items: true, list: false },
        type: [Workspace],
        resolve: async (_root, args, context: GraphQLContext) =>
          Promise.all(args.ids.map((id) => context.loaders.workspace.load(id))),
      }),
    }),
  });
  return builder.toSchema();
}

export type GraphQLResponseBody<TData = Record<string, unknown>> = {
  data?: TData;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
  }>;
};

export type ExecuteOperationOptions = {
  apiKey?: string;
  body?: string;
  contentLength?: number;
  contentType?: string;
  encoding?: string;
  headers?: Record<string, string>;
  jar?: CookieJar;
  method?: "GET" | "POST" | "OPTIONS";
  operationName?: string;
  origin?: string | null;
  query?: string | { toString(): string };
  variables?: Record<string, unknown>;
};

export type OperationResult<TData = Record<string, unknown>> = {
  body: GraphQLResponseBody<TData> | null;
  headers: Headers;
  requestId: string | null;
  response: Response;
  status: number;
};

export type SessionActor = {
  jar: CookieJar;
  memberId: string;
  organizationId: string;
  principalId: string;
  userId: string;
  workspaceId: string;
};

export class GraphQLFixture {
  readonly connection: Sql;
  readonly database: TestDatabase;
  readonly emailSender = new TestEmailSender();
  readonly capturedLogs: unknown[] = [];
  queryCount = 0;
  runtime!: ReturnType<typeof createHumansAuth>;
  handler!: (request: Request) => Promise<Response>;

  constructor(
    private readonly options: {
      clientAddressConfig?: TrustedProxyConfig;
      databaseQueryDiagnostics?: PerformanceDiagnosticSettings;
      environment?: "development" | "production" | "test";
      operationLimiter?: OperationLimiter;
      metrics?: Task12Metrics;
      searchIndexMaintenance?: SearchIndexMaintenance;
      searchRuntime?: SearchRuntime;
      schema?: GraphQLSchema;
      trustedOrigins?: readonly string[];
      fileRuntime?: FileServiceRuntime;
      importRuntime?: ImportServiceRuntime;
      settingsRuntime?: WorkspaceMemberRuntime;
      aiRuntime?: AiAnalysisRuntime;
    } = {},
  ) {
    this.connection = createTestConnection(16, () => {
      this.queryCount += 1;
      recordDatabaseQuery();
    });
    this.database = createTestDatabase(this.connection);
  }

  async reset(): Promise<void> {
    await resetTestDatabase(this.connection);
    this.emailSender.clear();
    this.capturedLogs.length = 0;
    this.queryCount = 0;
    const securityLogger = {
      log: (event: unknown) => this.capturedLogs.push(event),
    };
    this.runtime = createHumansAuth({
      database: this.database,
      emailSender: this.emailSender,
      // This in-process setup client creates many actors from one synthetic
      // address. Browser/production runtimes omit this test-only seam.
      rateLimitEnabled: false,
      securityLogger,
      settings: testAdminEnv,
    });
    const logger: GraphQLLogger = {
      log: (event) => this.capturedLogs.push(event),
    };
    const operationLimiter =
      this.options.operationLimiter ??
      new OperationLimiter(
        {
          consumeTokenBucket: async () => ({
            allowed: true,
            remainingMicrotokens: 1_000_000,
            retryAfterMs: 0,
          }),
        } satisfies Pick<RedisStore, "consumeTokenBucket">,
        logger,
        "59".repeat(32),
      );
    this.handler = createGraphQLHandler({
      auth: this.runtime,
      clientAddressConfig: this.options.clientAddressConfig ?? {
        deploymentMode: "docker",
        mode: "none",
      },
      database: this.database,
      databaseQueryDiagnostics: this.options.databaseQueryDiagnostics,
      environment: this.options.environment ?? "test",
      logger,
      metrics: this.options.metrics ?? createTask12Metrics(disabledMetricsSink),
      operationLimiter,
      searchIndexMaintenance:
        this.options.searchIndexMaintenance ?? disabledSearchIndexMaintenance,
      searchRuntime: this.options.searchRuntime ?? {
        cursorHmacKey: "45".repeat(32),
        encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
        protectedLookupHmacKey: testAdminEnv.PROTECTED_LOOKUP_HMAC_KEY,
      },
      fileRuntime: this.options.fileRuntime,
      importRuntime: this.options.importRuntime,
      settingsRuntime: this.options.settingsRuntime ?? {
        appUrl: testAdminEnv.NEXT_PUBLIC_APP_URL,
        authSecret: testAdminEnv.AUTH_SECRET,
        emailSender: this.emailSender,
        encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      },
      schema: this.options.schema,
      trustedOrigins:
        this.options.trustedOrigins ?? testAdminEnv.AUTH_TRUSTED_ORIGINS,
      aiRuntime: this.options.aiRuntime ?? {
        encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
        hmacKey: testAdminEnv.DATA_ENCRYPTION_KEY,
        provider: {
          baseUrlFingerprint: "46".repeat(32),
          disclosure: { model: "graphql-test-model", provider: "OLLAMA" },
        },
      },
    });
  }

  async close(): Promise<void> {
    await this.connection.end();
  }

  async createUser(input: {
    email: string;
    globalRole?: "admin" | "user";
    username: string;
  }): Promise<{ jar: CookieJar; userId: string }> {
    const signUp = await authRequest(
      this.runtime.handler,
      "/api/auth/sign-up/email",
      {
        body: {
          displayUsername: input.username,
          email: input.email,
          name: input.username,
          password: fixturePassword,
          username: input.username,
        },
      },
    );
    if (!signUp.ok) throw new Error("GraphQL fixture signup failed");
    const verification = [...this.emailSender.messages]
      .reverse()
      .find((message) => /verify/iu.test(message.subject));
    const verificationUrl = `${verification?.text ?? ""}`.match(
      /https?:\/\/[^\s<>"]+/u,
    )?.[0];
    if (!verificationUrl) {
      throw new Error("GraphQL fixture verification URL was not captured");
    }
    const verified = await this.runtime.handler(new Request(verificationUrl));
    if (verified.status >= 400) {
      throw new Error("GraphQL fixture verification failed");
    }

    const jar = new CookieJar();
    const signIn = await authRequest(
      this.runtime.handler,
      "/api/auth/sign-in/email",
      {
        body: { email: input.email, password: fixturePassword },
        jar,
      },
    );
    if (!signIn.ok) throw new Error("GraphQL fixture signin failed");
    const [user] = await this.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email.toLowerCase()));
    if (!user) throw new Error("GraphQL fixture user is missing");
    if (input.globalRole) {
      await this.database
        .update(users)
        .set({ role: input.globalRole })
        .where(eq(users.id, user.id));
    }
    return { jar, userId: user.id };
  }

  async createSessionActor(
    input: {
      email?: string;
      globalRole?: "admin" | "user";
      name?: string;
      role?: "admin" | "analyst" | "contributor" | "owner" | "viewer";
      username?: string;
    } = {},
  ): Promise<SessionActor> {
    const suffix = newId();
    const user = await this.createUser({
      email: input.email ?? `actor-${suffix}@example.test`,
      globalRole: input.globalRole,
      username: input.username ?? `Actor_${suffix.replaceAll("-", "")}`,
    });
    const workspace = await provisionWorkspace(this.database, {
      userId: user.userId,
      name: input.name ?? `Workspace ${suffix}`,
      slug: `workspace-${suffix}`,
    });
    if (input.role && input.role !== "owner") {
      await this.database
        .update(members)
        .set({ role: input.role })
        .where(eq(members.id, workspace.memberId));
    }
    const setActive = await authRequest(
      this.runtime.handler,
      "/api/auth/organization/set-active",
      {
        body: { organizationId: workspace.organizationId },
        jar: user.jar,
      },
    );
    if (!setActive.ok) throw new Error("GraphQL fixture active tenant failed");
    return { ...user, ...workspace };
  }

  async provisionKey(
    actor: SessionActor,
    permissions: Record<string, readonly string[]> = { person: ["read"] },
  ) {
    const headers = new Headers({
      origin: new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin,
    });
    actor.jar.apply(headers);
    return provisionOrganizationApiKey({
      auth: this.runtime,
      database: this.database,
      headers,
      name: `GraphQL ${newId().slice(0, 8)}`,
      permissions: permissions as never,
    });
  }

  async removeMembership(actor: SessionActor): Promise<void> {
    await this.database.delete(members).where(eq(members.id, actor.memberId));
  }

  async clearActiveOrganization(actor: SessionActor): Promise<void> {
    await this.database
      .update(sessions)
      .set({ activeOrganizationId: null })
      .where(eq(sessions.userId, actor.userId));
  }

  async execute<TData = Record<string, unknown>>(
    options: ExecuteOperationOptions = {},
  ): Promise<OperationResult<TData>> {
    const method = options.method ?? "POST";
    const headers = new Headers(options.headers);
    if (options.apiKey) headers.set("x-api-key", options.apiKey);
    options.jar?.apply(headers);
    if (method === "POST") {
      headers.set("content-type", options.contentType ?? "application/json");
    }
    if (options.encoding) headers.set("content-encoding", options.encoding);
    if (options.contentLength !== undefined) {
      headers.set("content-length", String(options.contentLength));
    }
    if (options.origin !== null && options.origin !== undefined) {
      headers.set("origin", options.origin);
    } else if (options.jar && options.origin !== null) {
      headers.set("origin", new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin);
      headers.set("sec-fetch-site", "same-origin");
    }

    const query = options.query?.toString() ?? VIEWER_QUERY;
    const body =
      options.body ??
      JSON.stringify({
        operationName: options.operationName,
        query,
        variables: options.variables,
      });
    const url = new URL("/api/graphql", testAdminEnv.NEXT_PUBLIC_APP_URL);
    if (method === "GET") {
      url.searchParams.set("query", query);
      if (options.operationName) {
        url.searchParams.set("operationName", options.operationName);
      }
      if (options.variables) {
        url.searchParams.set("variables", JSON.stringify(options.variables));
      }
    }
    return this.executeRequest<TData>(
      new Request(url, {
        method,
        headers,
        ...(method === "POST" ? { body } : {}),
      }),
    );
  }

  async executeRequest<TData = Record<string, unknown>>(
    request: Request,
  ): Promise<OperationResult<TData>> {
    const response = await this.handler(request);
    const responseType = response.headers.get("content-type") ?? "";
    const responseBody = responseType.includes("application/json")
      ? await responseJson<GraphQLResponseBody<TData>>(response)
      : null;
    return {
      body: responseBody,
      headers: response.headers,
      requestId: response.headers.get("x-request-id"),
      response,
      status: response.status,
    };
  }
}

export function expectGraphQLError(
  result: OperationResult,
  code: string,
): void {
  const actual = result.body?.errors?.[0]?.extensions?.code;
  if (actual !== code) {
    throw new Error(
      `Expected GraphQL error ${code}, received ${String(actual)}: ${JSON.stringify(result.body)}`,
    );
  }
  if (
    !result.requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      result.requestId,
    )
  ) {
    throw new Error("Expected a valid GraphQL request ID");
  }
  if (result.body?.errors?.[0]?.extensions?.requestId !== result.requestId) {
    throw new Error(
      "Expected the GraphQL error request ID to match the response",
    );
  }
}
