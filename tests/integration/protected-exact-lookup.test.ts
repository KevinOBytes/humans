// @vitest-environment node

import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { sessions } from "@/db/schema/auth";
import { personContactPoints } from "@/db/schema/evidence";
import { contactPoints } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { people, personIdentifiers } from "@/db/schema/people";
import { workspacePrincipals } from "@/db/schema/principals";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import type { ResearchServiceContext } from "@/modules/audit/service";
import {
  createProtectedExactLookupService,
  type ProtectedExactLookupPage,
} from "@/modules/people/protected-exact-service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { prepareProtectedExactV1 } from "@/lib/security/protected-exact";

import type { SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const blindIndexKey = "91".repeat(32);
const encryptionKey = "82".repeat(32);
const phone = "+1 (212) 555-0199";
const identifier = { namespace: "Employee.ID", value: "Case Sensitive 42" };

async function contextFor(
  fixture: ResearchFixture,
  actor: SessionActor,
): Promise<ResearchServiceContext> {
  const [session] = await fixture.database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, actor.userId));
  if (!session) throw new Error("The fixture session is missing.");
  return {
    actor: {
      type: "user",
      id: actor.userId,
      principalId: actor.principalId,
      sessionId: session.id,
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

async function addPerson(
  fixture: ResearchFixture,
  actor: SessionActor,
  label: string,
  sensitivity: "public" | "internal" | "confidential" | "restricted",
) {
  const id = newId();
  await fixture.database.insert(people).values({
    id,
    workspaceId: actor.workspaceId,
    displayName: label,
    sensitivity,
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  return id;
}

async function addPhone(input: {
  actor: SessionActor;
  deleted?: boolean;
  expired?: boolean;
  fixture: ResearchFixture;
  legacy?: boolean;
  personId: string;
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
}) {
  const prepared = prepareProtectedExactV1({
    blindIndexKey,
    encryptionKey,
    lookup: { kind: "PHONE", value: phone },
    workspaceId: input.actor.workspaceId,
  });
  const contactPointId = newId();
  await input.fixture.database.insert(contactPoints).values({
    id: contactPointId,
    workspaceId: input.actor.workspaceId,
    kind: "phone",
    encryptedDisplayValue: prepared.encryptedValue,
    blindIndex: input.legacy ? "legacy-phone-blind" : prepared.blindIndex,
    blindIndexVersion: input.legacy ? null : 1,
    sensitivity: input.sensitivity ?? "public",
    deletedAt: input.deleted ? new Date() : null,
    createdBy: input.actor.principalId,
    updatedBy: input.actor.principalId,
  });
  await input.fixture.database.insert(personContactPoints).values({
    id: newId(),
    workspaceId: input.actor.workspaceId,
    personId: input.personId,
    contactPointId,
    usageKind: "mobile",
    validUntil: input.expired ? new Date(Date.now() - 60_000) : null,
    createdBy: input.actor.principalId,
    updatedBy: input.actor.principalId,
  });
  return contactPointId;
}

async function addIdentifier(input: {
  actor: SessionActor;
  deleted?: boolean;
  expired?: boolean;
  fixture: ResearchFixture;
  legacy?: boolean;
  personId: string;
  revoked?: boolean;
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
}) {
  const prepared = prepareProtectedExactV1({
    blindIndexKey,
    encryptionKey,
    lookup: { kind: "PERSON_IDENTIFIER", ...identifier },
    workspaceId: input.actor.workspaceId,
  });
  const id = newId();
  await input.fixture.database.insert(personIdentifiers).values({
    id,
    workspaceId: input.actor.workspaceId,
    personId: input.personId,
    namespace: prepared.namespace!,
    identifierType: "custom",
    encryptedRawValue: prepared.encryptedValue,
    blindIndex: input.legacy ? "legacy-identifier-blind" : prepared.blindIndex,
    blindIndexVersion: input.legacy ? null : 1,
    verificationState: input.revoked ? "revoked" : "verified",
    sensitivity: input.sensitivity ?? "public",
    validUntil: input.expired ? new Date(Date.now() - 60_000) : null,
    deletedAt: input.deleted ? new Date() : null,
    createdBy: input.actor.principalId,
    updatedBy: input.actor.principalId,
  });
  return id;
}

async function grantResources(input: {
  actor: SessionActor;
  fixture: ResearchFixture;
  resources: readonly { id: string; kind: string }[];
}) {
  const policyId = newId();
  await input.fixture.database.insert(accessPolicies).values({
    id: policyId,
    workspaceId: input.actor.workspaceId,
    name: `Task 12 ${policyId}`,
    sensitivityCeiling: "restricted",
    resourceKinds: [...new Set(input.resources.map(({ kind }) => kind))],
    state: "active",
    createdBy: input.actor.principalId,
    updatedBy: input.actor.principalId,
  });
  await input.fixture.database.insert(resourceGrants).values(
    input.resources.map(({ id, kind }) => ({
      id: newId(),
      workspaceId: input.actor.workspaceId,
      policyId,
      memberId: input.actor.memberId,
      resourceId: id,
      resourceKind: kind,
      createdBy: input.actor.principalId,
      updatedBy: input.actor.principalId,
    })),
  );
}

function expectIds(
  page: ProtectedExactLookupPage,
  ids: readonly string[],
): void {
  expect(page.nodes.map(({ personId }) => personId)).toEqual(
    [...ids].sort((left, right) => left.localeCompare(right)),
  );
}

liveDescribe("protected exact lookup", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture();
    await fixture.reset();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("checks coarse permissions before normalization or database access", async () => {
    const database = new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be accessed");
        },
      },
    ) as Database;
    const context = {
      actor: {
        type: "apiKey",
        id: "key",
        principalId: newId(),
        role: null,
      },
      database,
      permissions: new Set<string>(),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: newId(),
    } satisfies ResearchServiceContext;
    const service = createProtectedExactLookupService(context, {
      blindIndexKey: "not-a-key",
    });

    await expect(
      service.lookup({
        first: 0,
        lookup: { kind: "PHONE", value: "not-a-phone" },
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("applies tenant, lifecycle, dual visibility, pagination, and v1-only rules in SQL", async () => {
    const actor = await fixture.createActor("owner");
    const foreign = await fixture.createActor("owner");
    const publicPerson = await addPerson(fixture, actor, "Public", "public");
    const internalPerson = await addPerson(
      fixture,
      actor,
      "Internal",
      "internal",
    );
    const grantedPerson = await addPerson(
      fixture,
      actor,
      "Granted",
      "confidential",
    );
    const hiddenPerson = await addPerson(
      fixture,
      actor,
      "Hidden",
      "restricted",
    );
    const deletedPerson = await addPerson(fixture, actor, "Deleted", "public");
    await fixture.database
      .update(people)
      .set({ deletedAt: new Date() })
      .where(eq(people.id, deletedPerson));
    const expiredPerson = await addPerson(fixture, actor, "Expired", "public");
    const legacyPerson = await addPerson(fixture, actor, "Legacy", "public");

    const publicContact = await addPhone({
      actor,
      fixture,
      personId: publicPerson,
    });
    await addPhone({ actor, fixture, personId: publicPerson });
    await addPhone({ actor, fixture, personId: internalPerson });
    const grantedContact = await addPhone({
      actor,
      fixture,
      personId: grantedPerson,
      sensitivity: "confidential",
    });
    await addPhone({
      actor,
      fixture,
      personId: hiddenPerson,
      sensitivity: "restricted",
    });
    await addPhone({ actor, fixture, personId: deletedPerson });
    await addPhone({ actor, expired: true, fixture, personId: expiredPerson });
    await addPhone({ actor, fixture, legacy: true, personId: legacyPerson });
    const foreignPerson = await addPerson(
      fixture,
      foreign,
      "Foreign",
      "public",
    );
    await addPhone({ actor: foreign, fixture, personId: foreignPerson });

    const publicIdentifier = await addIdentifier({
      actor,
      fixture,
      personId: publicPerson,
    });
    const grantedIdentifier = await addIdentifier({
      actor,
      fixture,
      personId: grantedPerson,
      sensitivity: "confidential",
    });
    await addIdentifier({
      actor,
      fixture,
      personId: hiddenPerson,
      revoked: true,
    });
    await addIdentifier({
      actor,
      expired: true,
      fixture,
      personId: expiredPerson,
    });
    await addIdentifier({
      actor,
      fixture,
      legacy: true,
      personId: legacyPerson,
    });
    await addIdentifier({ actor: foreign, fixture, personId: foreignPerson });

    await grantResources({
      actor,
      fixture,
      resources: [
        { id: grantedPerson, kind: "person" },
        { id: grantedContact, kind: "contactPoint" },
        { id: grantedIdentifier, kind: "personIdentifier" },
      ],
    });
    const service = createProtectedExactLookupService(
      await contextFor(fixture, actor),
      { blindIndexKey },
    );
    const [auditBefore] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));

    const firstPhone = await service.lookup({
      first: 1,
      lookup: { kind: "PHONE", value: phone },
    });
    expect(firstPhone.nodes).toHaveLength(1);
    expect(firstPhone.nextPersonId).toBe(firstPhone.nodes[0]!.personId);
    const remainingPhone = await service.lookup({
      afterPersonId: firstPhone.nextPersonId,
      first: 100,
      lookup: { kind: "PHONE", value: "0012125550199" },
    });
    expectIds(
      {
        nodes: [...firstPhone.nodes, ...remainingPhone.nodes],
        nextPersonId: null,
      },
      [publicPerson, internalPerson, grantedPerson],
    );
    expect(remainingPhone.nextPersonId).toBeNull();

    const identifierPage = await service.lookup({
      first: 100,
      lookup: { kind: "PERSON_IDENTIFIER", ...identifier },
    });
    expectIds(identifierPage, [publicPerson, grantedPerson]);
    expect(identifierPage.nextPersonId).toBeNull();
    expect(JSON.stringify(identifierPage)).toEqual(
      expect.not.stringContaining(identifier.value),
    );
    expect(JSON.stringify(identifierPage)).not.toContain(publicIdentifier);
    expect(JSON.stringify(identifierPage)).not.toContain(publicContact);

    const [auditAfter] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditAfter).toEqual(auditBefore);
    expect(JSON.stringify(fixture.capturedLogs)).not.toContain(phone);
    expect(JSON.stringify(fixture.capturedLogs)).not.toContain(
      identifier.value,
    );

    await expect(
      service.lookup({ first: 101, lookup: { kind: "PHONE", value: phone } }),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    await expect(
      service.lookup({
        afterPersonId: foreignPerson,
        first: 1,
        lookup: { kind: "PHONE", value: "+12125550000" },
      }),
    ).resolves.toEqual({ nodes: [], nextPersonId: null });
  });

  it("keeps member grants unavailable to API-key principals", async () => {
    const actor = await fixture.createActor("owner");
    const publicPerson = await addPerson(
      fixture,
      actor,
      "Public key",
      "public",
    );
    const protectedPerson = await addPerson(
      fixture,
      actor,
      "Protected key",
      "confidential",
    );
    await addPhone({ actor, fixture, personId: publicPerson });
    const protectedContact = await addPhone({
      actor,
      fixture,
      personId: protectedPerson,
      sensitivity: "confidential",
    });
    await grantResources({
      actor,
      fixture,
      resources: [
        { id: protectedPerson, kind: "person" },
        { id: protectedContact, kind: "contactPoint" },
      ],
    });
    const key = await fixture.provisionKey(actor, {
      person: ["read"],
      search: ["read"],
    });
    const [principal] = await fixture.database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.apiKeyId, key.id));
    if (!principal) throw new Error("API-key principal is missing.");
    const context: ResearchServiceContext = {
      actor: {
        type: "apiKey",
        id: key.id,
        principalId: principal.id,
        role: null,
      },
      database: fixture.database,
      permissions: new Set(["person:read", "search:read"]),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    };

    const page = await createProtectedExactLookupService(context, {
      blindIndexKey,
    }).lookup({ first: 100, lookup: { kind: "PHONE", value: phone } });
    expectIds(page, [publicPerson]);
  });
});
