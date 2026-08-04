import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { users } from "@/db/schema/auth";
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

const password = ["Task8", "Research", "Server", "Smoke!", "2026"].join("");
const privateEvidence = "private smoke evidence body";

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

async function execute<T>(input: {
  apiKey?: string;
  baseUrl: string;
  jar?: CookieJar;
  query: string;
  variables?: Record<string, unknown>;
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
    method: "POST",
    headers,
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
  assert(response.ok, `Research smoke returned HTTP ${response.status}`);
  assert(
    response.headers.get("cache-control") === "private, no-store",
    "Research smoke cache policy is unsafe",
  );
  assert(
    response.headers.get("x-request-id") === requestId,
    "Research smoke request ID did not round trip",
  );
  assert(
    !JSON.stringify(body).includes(privateEvidence),
    "Research smoke exposed private evidence content",
  );
  return { body, requestId };
}

async function main() {
  const env = parseServerEnv(process.env);
  const baseUrl =
    process.env.RESEARCH_SMOKE_BASE_URL ?? env.NEXT_PUBLIC_APP_URL;
  const connection = createTestConnection(8);
  const database = createTestDatabase(connection);
  try {
    await resetTestDatabase(connection);
    const emailSender = new TestEmailSender();
    const runtime = createHumansAuth({ database, emailSender, settings: env });
    const email = `research-smoke-${newId()}@example.test`;
    const username = `Research_${newId().replaceAll("-", "")}`;
    const signup = await authRequest({
      baseUrl,
      body: {
        displayUsername: username,
        email,
        name: "Research Smoke",
        password,
        username,
      },
      path: "/api/auth/sign-up/email",
      runtime,
    });
    assert(signup.ok, "Research smoke signup failed");
    const verificationUrl = emailSender.messages
      .at(-1)
      ?.text?.match(/https?:\/\/[^\s<>"]+/u)?.[0];
    assert(verificationUrl, "Research smoke verification URL is missing");
    assert(
      (await runtime.handler(new Request(verificationUrl))).status < 400,
      "Research smoke verification failed",
    );
    const jar = new CookieJar();
    assert(
      (
        await authRequest({
          baseUrl,
          body: { email, password },
          jar,
          path: "/api/auth/sign-in/email",
          runtime,
        })
      ).ok,
      "Research smoke signin failed",
    );
    const [user] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    assert(user, "Research smoke user is missing");
    const workspace = await provisionWorkspace(database, {
      name: "Research Smoke Workspace",
      slug: `research-smoke-${newId()}`,
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
      "Research smoke active workspace failed",
    );
    const authHeaders = new Headers({ origin: new URL(baseUrl).origin });
    jar.apply(authHeaders);
    const apiKey = await provisionOrganizationApiKey({
      auth: runtime,
      database,
      headers: authHeaders,
      name: "Research smoke key",
      permissions: { person: ["read"], fact: ["read"] },
    });

    const createPerson = async (displayName: string) =>
      execute<{ createPerson: { person: { id: string } | null } }>({
        baseUrl,
        jar,
        query: `mutation($input: CreatePersonInput!) { createPerson(input: $input) { person { id } code issues { code } } }`,
        variables: { input: { displayName } },
      });
    const firstPerson = await createPerson("Research Subject");
    const secondPerson = await createPerson("Research Associate");
    const firstPersonId = firstPerson.body.data?.createPerson.person?.id;
    const secondPersonId = secondPerson.body.data?.createPerson.person?.id;
    assert(
      firstPersonId && secondPersonId,
      "Research smoke person creation failed",
    );

    const definition = await execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      baseUrl,
      jar,
      query: `mutation($input: CreateFactDefinitionInput!) { createFactDefinition(input: $input) { factDefinition { id } code issues { code } } }`,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "claim",
          label: "Claim",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        },
      },
    });
    const definitionId =
      definition.body.data?.createFactDefinition.factDefinition?.id;
    assert(definitionId, "Research smoke fact definition failed");
    const createFact = async (value: string, state: string) =>
      execute<{ createFact: { fact: { id: string } | null } }>({
        baseUrl,
        jar,
        query: `mutation($input: CreateFactInput!) { createFact(input: $input) { fact { id state version } code issues { code } } }`,
        variables: {
          input: {
            personId: firstPersonId,
            definitionId,
            value: { text: value },
            state,
          },
        },
      });
    const factA = await createFact("claim-a", "ASSERTED");
    const factB = await createFact("claim-b", "DISPUTED");
    const factId = factA.body.data?.createFact.fact?.id;
    assert(
      factId && factB.body.data?.createFact.fact?.id,
      "Research smoke contradictory facts failed",
    );

    const relationshipType = await execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      baseUrl,
      jar,
      query: `mutation($input: CreateRelationshipTypeInput!) { createRelationshipType(input: $input) { relationshipType { id } code issues { code } } }`,
      variables: {
        input: {
          namespace: "social",
          key: "knows",
          forwardLabel: "knows",
          inverseLabel: "known by",
          directed: false,
          allowedMultiplicity: "MANY_TO_MANY",
        },
      },
    });
    const relationship = await execute<{
      createRelationship: { relationship: { id: string } | null };
    }>({
      baseUrl,
      jar,
      query: `mutation($input: CreateRelationshipInput!) { createRelationship(input: $input) { relationship { id } code issues { code } } }`,
      variables: {
        input: {
          sourcePersonId: firstPersonId,
          targetPersonId: secondPersonId,
          relationshipTypeId:
            relationshipType.body.data?.createRelationshipType.relationshipType
              ?.id,
        },
      },
    });
    assert(
      relationship.body.data?.createRelationship.relationship?.id,
      "Research smoke relationship failed",
    );

    const source = await execute<{
      createSource: { source: { id: string } | null };
    }>({
      baseUrl,
      jar,
      query: `mutation($input: CreateSourceInput!) { createSource(input: $input) { source { id } code issues { code } } }`,
      variables: { input: { kind: "archive", title: "Research smoke source" } },
    });
    const sourceId = source.body.data?.createSource.source?.id;
    assert(sourceId, "Research smoke source failed");
    const evidence = await execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      baseUrl,
      jar,
      query: `mutation($input: CreateEvidenceItemInput!) { createEvidenceItem(input: $input) { evidenceItem { id checksum } code issues { code } } }`,
      variables: {
        input: {
          sourceId,
          extractedText: privateEvidence,
          checksum: `sha256:${"d".repeat(64)}`,
        },
      },
    });
    const evidenceId = evidence.body.data?.createEvidenceItem.evidenceItem?.id;
    assert(evidenceId, "Research smoke evidence failed");
    const citation = await execute<{
      linkFactEvidence: { factEvidence: { id: string } | null };
    }>({
      baseUrl,
      jar,
      query: `mutation($input: LinkFactEvidenceInput!) { linkFactEvidence(input: $input) { factEvidence { id } code issues { code } } }`,
      variables: {
        input: { factId, evidenceItemId: evidenceId, locator: "p. 1" },
      },
    });
    assert(
      citation.body.data?.linkFactEvidence.factEvidence?.id,
      "Research smoke citation failed",
    );

    const sessionRead = await execute<{
      viewer: { actorType: string; workspace: { id: string } };
      person: {
        facts: {
          nodes: Array<{
            id: string;
            evidence: {
              nodes: Array<{ evidenceItem: { source: { id: string } } }>;
            };
          }>;
        };
      };
    }>({
      baseUrl,
      jar,
      query: `query($personId: UUID!) { viewer { actorType workspace { id } } person(id: $personId) { facts(first: 2) { nodes { id evidence(first: 1) { nodes { evidenceItem { source { id } } } } } } } }`,
      variables: { personId: firstPersonId },
    });
    assert(
      !sessionRead.body.errors,
      `Research smoke session query returned errors: ${JSON.stringify(sessionRead.body.errors)}`,
    );
    assert(
      sessionRead.body.data?.viewer.workspace.id === workspace.workspaceId,
      "Research smoke session tenant mismatch",
    );
    assert(
      sessionRead.body.data?.person.facts.nodes.length === 2,
      "Research smoke contradictory facts are missing",
    );
    const auditRead = await execute<{
      auditEvents: { nodes: Array<{ action: string }> };
    }>({
      baseUrl,
      jar,
      query: `query { auditEvents(first: 20) { nodes { action resourceKind resourceId } } }`,
    });
    assert(
      !auditRead.body.errors,
      "Research smoke audit query returned errors",
    );
    assert(
      auditRead.body.data?.auditEvents.nodes.some(
        (event) => event.action === "fact.evidence.link",
      ),
      "Research smoke audit metadata is missing",
    );

    const keyRead = await execute<{
      viewer: { actorType: string; workspace: { id: string } };
      person: { id: string } | null;
    }>({
      baseUrl,
      apiKey: apiKey.key,
      query: `query($id: UUID!) { viewer { actorType workspace { id } } person(id: $id) { id } }`,
      variables: { id: firstPersonId },
    });
    assert(
      !keyRead.body.errors && keyRead.body.data?.viewer.actorType === "API_KEY",
      "Research smoke API-key read failed",
    );
    assert(
      keyRead.body.data?.viewer.workspace.id === workspace.workspaceId,
      "Research smoke API-key tenant mismatch",
    );
    const denied = await execute({
      baseUrl,
      apiKey: apiKey.key,
      query: `query($id: UUID!) { evidenceItem(id: $id) { id } }`,
      variables: { id: evidenceId },
    });
    assert(
      denied.body.errors?.[0]?.extensions?.code === "FORBIDDEN",
      "Research smoke API-key scope denial failed",
    );
    assert(
      denied.body.errors[0]?.extensions?.requestId === denied.requestId,
      "Research smoke denial correlation failed",
    );
    process.stdout.write("Research API built-server smoke passed\n");
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Research API built-server smoke failed: ${reason}\n`);
  process.exitCode = 1;
});
