import { and, eq } from "drizzle-orm";
import IORedis from "ioredis";

import { newId } from "@/db/id";
import { databaseConnection, db } from "@/db/client";
import { users } from "@/db/schema/auth";
import { personAddresses, personContactPoints } from "@/db/schema/evidence";
import { addresses, contactPoints } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { relationshipTypes } from "@/db/schema/relationships";
import { createHumansAuth } from "@/lib/auth/config";
import { parseServerEnv } from "@/lib/env/server-schema";
import {
  provisionOrganizationApiKey,
  provisionWorkspace,
} from "@/modules/auth/workspaces";

import { CookieJar, TestEmailSender } from "../support/auth";

const password = ["Task12", "Compose", "Smoke!", "2026"].join("");
const searchNeedle = "Compose Search Needle";
const foreignNeedle = "Compose Foreign Workspace Needle";
const confidentialNeedle = "Compose Confidential Needle";
const protectedNeedle = "+1 212 555 0127";
const task18Address = "18 Compose Protected Lane";

type GraphQLErrorShape = Readonly<{
  extensions?: Readonly<Record<string, unknown>>;
  message: string;
}>;

type GraphQLBody<T> = Readonly<{
  data?: T;
  errors?: readonly GraphQLErrorShape[];
}>;

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
  origin: string;
  query: string;
  variables?: Record<string, unknown>;
}) {
  const requestId = crypto.randomUUID();
  const headers = new Headers({
    "content-type": "application/json",
    origin: input.origin,
    "sec-fetch-site": "same-origin",
    "x-request-id": requestId,
  });
  if (input.apiKey) headers.set("x-api-key", input.apiKey);
  input.jar?.apply(headers);
  const response = await fetch(new URL("/api/graphql", input.baseUrl), {
    body: JSON.stringify({ query: input.query, variables: input.variables }),
    headers,
    method: "POST",
  });
  const body = (await response.json()) as GraphQLBody<T>;
  assert(response.ok, "Task 12 smoke GraphQL request failed");
  assert(
    response.headers.get("cache-control") === "private, no-store",
    "Task 12 smoke GraphQL cache policy is unsafe",
  );
  assert(
    response.headers.get("x-request-id") === requestId,
    "Task 12 smoke request ID did not round trip",
  );
  assert(
    !JSON.stringify(body).includes(protectedNeedle),
    "Task 12 smoke response exposed protected input",
  );
  return { body, requestId };
}

function errorCode(body: GraphQLBody<unknown>): unknown {
  return body.errors?.[0]?.extensions?.code;
}

function assertNoErrors<T>(
  body: GraphQLBody<T>,
  message: string,
): asserts body is GraphQLBody<T> & { data: T } {
  assert(!body.errors?.length && body.data, message);
}

async function redisKeys(redis: IORedis): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [next, page] = await redis.scan(cursor, "COUNT", 100);
    cursor = next;
    keys.push(...page);
  } while (cursor !== "0");
  return keys;
}

async function main() {
  const env = parseServerEnv(process.env);
  const publicBaseUrl = env.NEXT_PUBLIC_APP_URL;
  const baseUrl = process.env.TASK12_SMOKE_BASE_URL ?? publicBaseUrl;
  const origin = new URL(publicBaseUrl).origin;
  const emailSender = new TestEmailSender();
  const runtime = createHumansAuth({
    database: db,
    emailSender,
    settings: env,
  });
  const redis = new IORedis(env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  try {
    const identity = newId();
    const email = `task12-smoke-${identity}@example.test`;
    const username = `Task12_${identity.replaceAll("-", "")}`;
    const signup = await authRequest({
      baseUrl: publicBaseUrl,
      body: {
        displayUsername: username,
        email,
        name: "Task 12 Smoke",
        password,
        username,
      },
      path: "/api/auth/sign-up/email",
      runtime,
    });
    assert(signup.ok, "Task 12 smoke signup failed");
    const verificationUrl = emailSender.messages
      .at(-1)
      ?.text?.match(/https?:\/\/[^\s<>"]+/u)?.[0];
    assert(verificationUrl, "Task 12 smoke verification URL is missing");
    assert(
      (await runtime.handler(new Request(verificationUrl))).status < 400,
      "Task 12 smoke verification failed",
    );

    const jar = new CookieJar();
    const signin = await authRequest({
      baseUrl: publicBaseUrl,
      body: { email, password },
      jar,
      path: "/api/auth/sign-in/email",
      runtime,
    });
    assert(signin.ok, "Task 12 smoke signin failed");
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    assert(user, "Task 12 smoke user is missing");
    const workspace = await provisionWorkspace(db, {
      name: "Task 12 Compose Smoke",
      slug: `task12-smoke-${identity}`,
      userId: user.id,
    });
    const active = await authRequest({
      baseUrl: publicBaseUrl,
      body: { organizationId: workspace.organizationId },
      jar,
      path: "/api/auth/organization/set-active",
      runtime,
    });
    assert(active.ok, "Task 12 smoke active workspace failed");

    const authHeaders = new Headers({ origin });
    jar.apply(authHeaders);
    const apiKey = await provisionOrganizationApiKey({
      auth: runtime,
      database: db,
      headers: authHeaders,
      name: "Task 12 smoke scoped key",
      permissions: {
        analysis: ["read", "run"],
        graph: ["read", "run"],
        person: ["read"],
        relationship: ["read"],
        savedQuery: ["read", "run"],
        search: ["read", "run"],
        workspace: ["read"],
      },
    });

    const createPerson = async (
      displayName: string,
      sensitivity?: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
    ) => {
      const result = await execute<{
        createPerson: { person: { id: string } | null };
      }>({
        baseUrl,
        jar,
        origin,
        query: `mutation($input: CreatePersonInput!) {
          createPerson(input: $input) { person { id } code issues { code } }
        }`,
        variables: {
          input: { displayName, ...(sensitivity ? { sensitivity } : {}) },
        },
      });
      assertNoErrors(result.body, "Task 12 smoke person mutation failed");
      const personId = result.body.data.createPerson.person?.id;
      assert(personId, "Task 12 smoke person was not created");
      return personId;
    };
    const firstPersonId = await createPerson(searchNeedle);
    const secondPersonId = await createPerson("Compose Graph Peer");
    await createPerson(confidentialNeedle, "CONFIDENTIAL");

    const task18Contact = await execute<{
      createPersonContact: {
        code: string | null;
        contact: { associationId: string; contactPointId: string } | null;
      };
    }>({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: CreatePersonContactInput!) {
        createPersonContact(input: $input) {
          contact { associationId contactPointId }
          code
          issues { code }
        }
      }`,
      variables: {
        input: {
          personId: firstPersonId,
          kind: "PHONE",
          value: protectedNeedle,
          usageKind: "mobile",
          isPrimary: true,
          idempotencyKey: `task18-contact-${identity}`,
        },
      },
    });
    assertNoErrors(task18Contact.body, "Task 18 smoke contact mutation failed");
    const task18ContactRow =
      task18Contact.body.data.createPersonContact.contact;
    assert(task18ContactRow, "Task 18 smoke contact was not created");
    const [rawContact] = await db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.id, task18ContactRow.contactPointId));
    assert(
      rawContact?.encryptedDisplayValue.startsWith("hs1.") &&
        !JSON.stringify(rawContact).includes(protectedNeedle),
      "Task 18 smoke contact was not protected at rest",
    );
    const [contactAssociation] = await db
      .select()
      .from(personContactPoints)
      .where(eq(personContactPoints.id, task18ContactRow.associationId));
    assert(
      contactAssociation?.personId === firstPersonId &&
        contactAssociation.isPrimary,
      "Task 18 smoke contact association is invalid",
    );

    const task18AddressResult = await execute<{
      createPersonAddress: {
        code: string | null;
        address: { associationId: string; addressId: string } | null;
      };
    }>({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: CreatePersonAddressInput!) {
        createPersonAddress(input: $input) {
          address { associationId addressId }
          code
          issues { code }
        }
      }`,
      variables: {
        input: {
          personId: firstPersonId,
          addressKind: "residence",
          line1: task18Address,
          locality: "Compose City",
          isPrimary: true,
          idempotencyKey: `task18-address-${identity}`,
        },
      },
    });
    assertNoErrors(
      task18AddressResult.body,
      "Task 18 smoke address mutation failed",
    );
    const task18AddressRow =
      task18AddressResult.body.data.createPersonAddress.address;
    assert(task18AddressRow, "Task 18 smoke address was not created");
    const [rawAddress] = await db
      .select()
      .from(addresses)
      .where(eq(addresses.id, task18AddressRow.addressId));
    assert(
      rawAddress?.normalizedHash?.match(/^[0-9a-f]{64}$/u),
      "Task 18 smoke address canonical hash is invalid",
    );
    const [addressAssociation] = await db
      .select()
      .from(personAddresses)
      .where(eq(personAddresses.id, task18AddressRow.associationId));
    assert(
      addressAssociation?.personId === firstPersonId &&
        addressAssociation.isPrimary,
      "Task 18 smoke address association is invalid",
    );
    const foreignWorkspace = await provisionWorkspace(db, {
      name: "Task 12 Compose Foreign",
      slug: `task12-smoke-foreign-${identity}`,
      userId: user.id,
    });
    const activateForeign = await authRequest({
      baseUrl: publicBaseUrl,
      body: { organizationId: foreignWorkspace.organizationId },
      jar,
      path: "/api/auth/organization/set-active",
      runtime,
    });
    assert(
      activateForeign.ok,
      "Task 12 smoke foreign workspace activation failed",
    );
    const foreignPersonId = await createPerson(foreignNeedle);
    const reactivateMain = await authRequest({
      baseUrl: publicBaseUrl,
      body: { organizationId: workspace.organizationId },
      jar,
      path: "/api/auth/organization/set-active",
      runtime,
    });
    assert(
      reactivateMain.ok,
      "Task 12 smoke main workspace reactivation failed",
    );
    const crossWorkspaceContact = await execute({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: CreatePersonContactInput!) {
        createPersonContact(input: $input) { contact { associationId } code }
      }`,
      variables: {
        input: {
          personId: foreignPersonId,
          kind: "PHONE",
          value: "+1 212 555 0199",
          usageKind: "mobile",
          idempotencyKey: `task18-cross-workspace-${identity}`,
        },
      },
    });
    assert(
      errorCode(crossWorkspaceContact.body) === "NOT_FOUND",
      "Task 18 smoke cross-workspace write was not masked",
    );

    const typeResult = await execute<{
      createRelationshipType: {
        relationshipType: { id: string; version: number } | null;
      };
    }>({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: CreateRelationshipTypeInput!) {
        createRelationshipType(input: $input) {
          relationshipType { id version } code issues { code }
        }
      }`,
      variables: {
        input: {
          allowedMultiplicity: "MANY_TO_MANY",
          directed: false,
          forwardLabel: "compose links",
          inverseLabel: "compose linked by",
          key: `compose-links-${identity}`,
          namespace: "smoke",
        },
      },
    });
    assertNoErrors(
      typeResult.body,
      "Task 12 smoke relationship type mutation failed",
    );
    const relationshipType =
      typeResult.body.data.createRelationshipType.relationshipType;
    assert(relationshipType, "Task 12 smoke relationship type is missing");

    const relationshipResult = await execute<{
      createRelationship: { relationship: { id: string } | null };
    }>({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: CreateRelationshipInput!) {
        createRelationship(input: $input) {
          relationship { id } code issues { code }
        }
      }`,
      variables: {
        input: {
          relationshipTypeId: relationshipType.id,
          sourcePersonId: firstPersonId,
          targetPersonId: secondPersonId,
        },
      },
    });
    assertNoErrors(
      relationshipResult.body,
      "Task 12 smoke relationship mutation failed",
    );
    assert(
      relationshipResult.body.data.createRelationship.relationship?.id,
      "Task 12 smoke relationship is missing",
    );

    const searchInput = {
      filters: {},
      first: 25,
      kinds: ["PERSON"],
      match: { query: searchNeedle, type: "TEXT" },
      version: 1,
    };
    const searchQuery = `query($input: SearchInput!) {
      search(input: $input) {
        nodes { id kind title }
        pageInfo { endCursor hasNextPage }
      }
    }`;
    const assertSearch = (
      body: GraphQLBody<{
        search: { nodes: Array<{ id: string; title: string }> };
      }>,
      message: string,
    ) => {
      assertNoErrors(body, message);
      assert(
        body.data.search.nodes.some(
          ({ id, title }) => id === firstPersonId && title === searchNeedle,
        ),
        message,
      );
    };
    const sessionSearch = await execute<{
      search: { nodes: Array<{ id: string; title: string }> };
    }>({
      baseUrl,
      jar,
      origin,
      query: searchQuery,
      variables: { input: searchInput },
    });
    assertSearch(sessionSearch.body, "Task 12 smoke session search failed");
    const keySearch = await execute<{
      search: { nodes: Array<{ id: string; title: string }> };
    }>({
      apiKey: apiKey.key,
      baseUrl,
      origin,
      query: searchQuery,
      variables: { input: searchInput },
    });
    assertSearch(keySearch.body, "Task 12 smoke API-key search failed");
    const assertHiddenForSessionAndKey = async (
      needle: string,
      label: string,
    ) => {
      const input = {
        ...searchInput,
        match: { query: needle, type: "TEXT" },
      };
      for (const credential of [{ jar }, { apiKey: apiKey.key }]) {
        const result = await execute<{
          search: { nodes: Array<{ id: string; title: string }> };
        }>({
          ...credential,
          baseUrl,
          origin,
          query: searchQuery,
          variables: { input },
        });
        assertNoErrors(result.body, `Task 12 smoke ${label} search failed`);
        assert(
          result.body.data.search.nodes.length === 0,
          `Task 12 smoke exposed ${label}`,
        );
      }
    };
    await assertHiddenForSessionAndKey(
      foreignNeedle,
      "second-workspace result",
    );
    await assertHiddenForSessionAndKey(
      confidentialNeedle,
      "above-ceiling sensitivity result",
    );

    const saved = await execute<{
      createSavedQuery: { id: string; sharing: string };
    }>({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: CreateSavedQueryInput!) {
        createSavedQuery(input: $input) { id sharing version }
      }`,
      variables: {
        input: {
          name: "Compose shared search",
          queryAst: {
            filters: {},
            kinds: ["PERSON"],
            match: { query: searchNeedle, type: "text" },
            pageSize: 25,
            schema: "humans.search-query",
            version: 1,
          },
          sharing: "WORKSPACE",
        },
      },
    });
    assertNoErrors(saved.body, "Task 12 smoke saved query creation failed");
    assert(
      saved.body.data.createSavedQuery.sharing === "WORKSPACE",
      "Task 12 smoke saved query sharing is wrong",
    );
    const savedRun = await execute<{
      runSavedQuery: { nodes: Array<{ id: string; title: string }> };
    }>({
      apiKey: apiKey.key,
      baseUrl,
      origin,
      query: `mutation($id: UUID!) {
        runSavedQuery(id: $id) { nodes { id title } }
      }`,
      variables: { id: saved.body.data.createSavedQuery.id },
    });
    assertNoErrors(savedRun.body, "Task 12 smoke saved query run failed");
    assert(
      savedRun.body.data.runSavedQuery.nodes.some(
        ({ id }) => id === firstPersonId,
      ),
      "Task 12 smoke API key could not run workspace saved query",
    );

    const snapshot = await execute<{
      createGraphSnapshot: { id: string; manifestHash: string };
    }>({
      baseUrl,
      jar,
      origin,
      query: `mutation($input: RunGraphAnalysisInput!) {
        createGraphSnapshot(input: $input) { id manifestHash }
      }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: {
            edgeLimit: 100,
            includeIsolates: true,
            mode: "WORKSPACE",
            nodeLimit: 100,
          },
        },
      },
    });
    assertNoErrors(snapshot.body, "Task 12 smoke snapshot creation failed");
    assert(
      /^[0-9a-f]{64}$/u.test(
        snapshot.body.data.createGraphSnapshot.manifestHash,
      ),
      "Task 12 smoke snapshot manifest hash is invalid",
    );
    const snapshotId = snapshot.body.data.createGraphSnapshot.id;
    const replayQuery = `mutation($input: ReplayGraphSnapshotInput!) {
      replayGraphSnapshot(input: $input) { valid snapshot { id } }
    }`;
    const validReplay = await execute<{
      replayGraphSnapshot: { snapshot: { id: string } | null; valid: boolean };
    }>({
      baseUrl,
      jar,
      origin,
      query: replayQuery,
      variables: { input: { snapshotId } },
    });
    assertNoErrors(validReplay.body, "Task 12 smoke valid replay failed");
    assert(
      validReplay.body.data.replayGraphSnapshot.valid &&
        validReplay.body.data.replayGraphSnapshot.snapshot?.id === snapshotId,
      "Task 12 smoke valid replay result is wrong",
    );

    await db
      .update(relationshipTypes)
      .set({ version: relationshipType.version + 1 })
      .where(
        and(
          eq(relationshipTypes.workspaceId, workspace.workspaceId),
          eq(relationshipTypes.id, relationshipType.id),
        ),
      );
    const invalidReplay = await execute<{
      replayGraphSnapshot: { snapshot: { id: string } | null; valid: boolean };
    }>({
      baseUrl,
      jar,
      origin,
      query: replayQuery,
      variables: { input: { snapshotId } },
    });
    assertNoErrors(invalidReplay.body, "Task 12 smoke invalid replay failed");
    assert(
      !invalidReplay.body.data.replayGraphSnapshot.valid &&
        invalidReplay.body.data.replayGraphSnapshot.snapshot === null,
      "Task 12 smoke invalid replay did not fail generically",
    );
    assert(
      !JSON.stringify(invalidReplay.body).includes(relationshipType.id),
      "Task 12 smoke invalid replay leaked changed resource identity",
    );

    const protectedSearch = await execute<{
      search: { nodes: Array<{ id: string }> };
    }>({
      baseUrl,
      jar,
      origin,
      query: searchQuery,
      variables: {
        input: {
          filters: {},
          first: 25,
          kinds: ["PERSON"],
          match: {
            protectedKind: "PHONE",
            type: "PROTECTED_EXACT",
            value: protectedNeedle,
          },
          version: 1,
        },
      },
    });
    assertNoErrors(
      protectedSearch.body,
      "Task 12 smoke protected exact search failed",
    );

    const keysBeforeDenial = await redisKeys(redis);
    const redisDiagnostics = JSON.stringify(keysBeforeDenial);
    assert(
      !redisDiagnostics.includes(searchNeedle) &&
        !redisDiagnostics.includes(protectedNeedle) &&
        !redisDiagnostics.includes(apiKey.key),
      "Task 12 smoke Redis keys exposed request material",
    );

    const [audits] = await Promise.all([
      db
        .select({ redactedDiff: auditEvents.redactedDiff })
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspace.workspaceId)),
    ]);
    const auditDiagnostics = JSON.stringify(audits);
    assert(
      !auditDiagnostics.includes(searchNeedle) &&
        !auditDiagnostics.includes(protectedNeedle) &&
        !auditDiagnostics.includes(apiKey.key),
      "Task 12 smoke audit events exposed request material",
    );

    let denied: Awaited<ReturnType<typeof execute>> | undefined;
    const expensiveInput = { ...searchInput, first: 100 };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const candidate = await execute({
        baseUrl,
        jar,
        origin,
        query: searchQuery,
        variables: { input: expensiveInput },
      });
      if (errorCode(candidate.body) === "RATE_LIMITED") {
        denied = candidate;
        break;
      }
      assertNoErrors(
        candidate.body,
        "Task 12 smoke search failed before denial",
      );
    }
    assert(denied, "Task 12 smoke did not observe Redis-backed denial");
    assert(
      denied.body.errors?.[0]?.message === "Too many requests." &&
        denied.body.errors[0]?.extensions?.requestId === denied.requestId,
      "Task 12 smoke rate-limit denial was not generic and correlated",
    );

    await redis.flushdb();
    const recovered = await execute<{
      search: { nodes: Array<{ id: string; title: string }> };
    }>({
      baseUrl,
      jar,
      origin,
      query: searchQuery,
      variables: { input: searchInput },
    });
    assertSearch(
      recovered.body,
      "Task 12 smoke did not recover after Redis reset",
    );

    process.stdout.write(
      `Task 12/18 built-server smoke passed: protected contact/address CRUD, workspace isolation, session/scoped-key search, second-workspace and sensitivity denials, shared saved query, snapshot replay invalidation, Redis denial/recovery, and leakage controls (${keysBeforeDenial.length} opaque Redis keys; ${audits.length} redacted audit events)\n`,
    );
  } finally {
    redis.disconnect();
    await databaseConnection.end();
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Task 12 built-server smoke failed: ${reason}\n`);
  process.exitCode = 1;
});
