import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { users } from "@/db/schema/auth";
import { ViewerDocument } from "@/graphql/generated/graphql";
import { createHumansAuth } from "@/lib/auth/config";
import { parseServerEnv } from "@/lib/env/server-schema";
import {
  provisionOrganizationApiKey,
  provisionWorkspace,
} from "@/modules/auth/workspaces";

import {
  CookieJar,
  TestEmailSender,
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
} from "../support/auth";

const password = ["Task7", "Built", "Server", "Smoke!", "2026"].join("");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function authRequest(input: {
  baseUrl: string;
  body?: Record<string, unknown>;
  jar?: CookieJar;
  path: string;
  runtime: ReturnType<typeof createHumansAuth>;
}) {
  const headers = new Headers();
  if (input.body) {
    headers.set("content-type", "application/json");
    headers.set("origin", new URL(input.baseUrl).origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  input.jar?.apply(headers);
  const response = await input.runtime.handler(
    new Request(new URL(input.path, input.baseUrl), {
      headers,
      method: input.body ? "POST" : "GET",
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    }),
  );
  input.jar?.capture(response);
  return response;
}

async function queryGraphQL(input: {
  apiKey?: string;
  baseUrl: string;
  jar?: CookieJar;
}) {
  const requestId = crypto.randomUUID();
  const headers = new Headers({
    "content-type": "application/json",
    "x-request-id": requestId,
  });
  if (input.apiKey) headers.set("x-api-key", input.apiKey);
  if (input.jar) {
    input.jar.apply(headers);
    headers.set("origin", new URL(input.baseUrl).origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  const response = await fetch(new URL("/api/graphql", input.baseUrl), {
    body: JSON.stringify({ query: ViewerDocument.toString() }),
    headers,
    method: "POST",
  });
  const body = (await response.json()) as {
    data?: {
      viewer?: {
        actorType?: string;
        permissions?: string[];
        workspace?: { id?: string };
      };
      workspace?: { id?: string };
    };
    errors?: unknown[];
  };
  assert(response.ok, `GraphQL smoke returned HTTP ${response.status}`);
  assert(!body.errors, "GraphQL smoke returned errors");
  assert(
    response.headers.get("cache-control") === "private, no-store",
    "GraphQL smoke did not return private no-store caching",
  );
  assert(
    response.headers.get("x-request-id") === requestId,
    "GraphQL smoke request ID did not round trip",
  );
  return body.data;
}

async function main() {
  const env = parseServerEnv(process.env);
  const baseUrl = process.env.GRAPHQL_SMOKE_BASE_URL ?? env.NEXT_PUBLIC_APP_URL;
  const connection = createTestConnection(8);
  const database = createTestDatabase(connection);
  try {
    await resetTestDatabase(connection);
    const emailSender = new TestEmailSender();
    const runtime = createHumansAuth({
      database,
      emailSender,
      settings: env,
    });
    const email = `graphql-smoke-${newId()}@example.test`;
    const username = `Smoke_${newId().replaceAll("-", "")}`;
    const signup = await authRequest({
      baseUrl,
      body: {
        displayUsername: username,
        email,
        name: "GraphQL Smoke",
        password,
        username,
      },
      path: "/api/auth/sign-up/email",
      runtime,
    });
    assert(signup.ok, "GraphQL smoke signup failed");
    const verificationUrl = emailSender.messages
      .at(-1)
      ?.text?.match(/https?:\/\/[^\s<>"]+/u)?.[0];
    assert(verificationUrl, "GraphQL smoke verification URL is missing");
    assert(
      (await runtime.handler(new Request(verificationUrl))).status < 400,
      "GraphQL smoke verification failed",
    );

    const jar = new CookieJar();
    const signin = await authRequest({
      baseUrl,
      body: { email, password },
      jar,
      path: "/api/auth/sign-in/email",
      runtime,
    });
    assert(signin.ok, "GraphQL smoke signin failed");
    const [user] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    assert(user, "GraphQL smoke user is missing");
    const workspace = await provisionWorkspace(database, {
      name: "GraphQL Smoke Workspace",
      slug: `graphql-smoke-${newId()}`,
      userId: user.id,
    });
    assert(
      (
        await authRequest({
          baseUrl,
          body: { organizationId: workspace.organizationId },
          jar,
          path: "/api/auth/organization/set-active",
          runtime,
        })
      ).ok,
      "GraphQL smoke could not set the active workspace",
    );
    const authHeaders = new Headers({ origin: new URL(baseUrl).origin });
    jar.apply(authHeaders);
    const apiKey = await provisionOrganizationApiKey({
      auth: runtime,
      database,
      headers: authHeaders,
      name: "GraphQL smoke key",
      permissions: { fact: ["read"], person: ["read"] },
    });

    const sessionData = await queryGraphQL({ baseUrl, jar });
    const keyData = await queryGraphQL({ apiKey: apiKey.key, baseUrl });
    assert(
      sessionData?.viewer?.actorType === "USER",
      "GraphQL smoke session actor kind is incorrect",
    );
    assert(
      keyData?.viewer?.actorType === "API_KEY",
      "GraphQL smoke API-key actor kind is incorrect",
    );
    assert(
      sessionData.workspace?.id === workspace.workspaceId &&
        keyData?.workspace?.id === workspace.workspaceId,
      "GraphQL smoke actors did not resolve the same tenant",
    );
    assert(
      keyData.viewer?.permissions?.join(",") === "fact:read,person:read",
      "GraphQL smoke API-key scopes are incorrect",
    );
    process.stdout.write("GraphQL built-server smoke passed\n");
  } finally {
    await connection.end();
  }
}

void main().catch(() => {
  process.stderr.write("GraphQL built-server smoke failed\n");
  process.exitCode = 1;
});
