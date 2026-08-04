// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  evidenceExcerpts,
  evidenceItems,
  factEvidence,
  factTags,
  notes,
  personTags,
  relationshipEvidence,
  relationshipTags,
  sources,
  tags,
} from "@/db/schema/evidence";
import {
  factDefinitions,
  factRelationships,
  factRevisions,
  facts,
  personFieldSelections,
} from "@/db/schema/facts";
import { files } from "@/db/schema/files";
import { places } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { users } from "@/db/schema/auth";
import { workspacePrincipals } from "@/db/schema/principals";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import { newId } from "@/db/id";

import { expectGraphQLError } from "../support/graphql";
import {
  CREATE_PERSON_MUTATION,
  ResearchFixture,
} from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is missing");
  return value;
}

liveDescribe("research authorization", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it.each(["analyst", "viewer"] as const)(
    "denies person creation to a %s before resource lookup",
    async (role) => {
      const actor = await fixture.createActor(role);
      const result = await fixture.createPerson(actor, {
        displayName: "Denied Person",
      });

      expectGraphQLError(result, "FORBIDDEN");
      expect(JSON.stringify(result.body)).not.toContain("Denied Person");
    },
  );

  it("intersects API-key authority with its explicit person scopes", async () => {
    const owner = await fixture.createActor();
    const readKey = await fixture.provisionKey(owner, { person: ["read"] });
    const result = await fixture.execute({
      apiKey: readKey.key,
      query: CREATE_PERSON_MUTATION,
      variables: { input: { displayName: "Denied by key scope" } },
    });

    expectGraphQLError(result, "FORBIDDEN");
    expect(JSON.stringify(result.body)).not.toContain("Denied by key scope");
  });

  it("does not make person read scope transitive to nested facts", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, { displayName: "Scoped" });
    const personId = person.body?.data?.createPerson?.person?.id;
    const personOnlyKey = await fixture.provisionKey(owner, {
      person: ["read"],
    });
    const result = await fixture.execute({
      apiKey: personOnlyKey.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          person(id: $id) {
            id
            facts(first: 1) {
              nodes {
                id
              }
            }
          }
        }
      `,
      variables: { id: personId },
    });

    expectGraphQLError(result, "FORBIDDEN");
  });

  it("restricts audit browsing to audit readers", async () => {
    const contributor = await fixture.createActor("contributor");
    const denied = await fixture.execute({
      jar: contributor.jar,
      query: /* GraphQL */ `
        query {
          auditEvents(first: 1) {
            nodes {
              id
            }
          }
        }
      `,
    });
    expectGraphQLError(denied, "FORBIDDEN");

    const owner = await fixture.createActor();
    const key = await fixture.provisionKey(owner, { audit: ["read"] });
    const allowed = await fixture.execute({
      apiKey: key.key,
      query: /* GraphQL */ `
        query {
          auditEvents(first: 1) {
            nodes {
              id
            }
          }
        }
      `,
    });
    expect(allowed.body?.errors).toBeUndefined();
  });

  it("returns tenant-safe user, API-key, legacy, and deleted attribution", async () => {
    const owner = await fixture.createActor();
    const userPerson = await fixture.createPerson(owner, {
      displayName: "Attributed user row",
    });
    const userPersonId = required(
      userPerson.body?.data?.createPerson?.person?.id,
    );
    const key = await fixture.provisionKey(owner, {
      audit: ["read"],
      person: ["create", "read"],
    });
    const keyed = await fixture.execute({
      apiKey: key.key,
      query: CREATE_PERSON_MUTATION,
      variables: { input: { displayName: "Attributed key row" } },
    });
    expect(keyed.body?.errors).toBeUndefined();
    const attribution = await fixture.execute<{
      person: {
        createdBy: { principalId: string; kind: string; label: string };
      };
      auditEvents: {
        nodes: Array<{
          actor: { principalId: string | null; kind: string; label: string };
        }>;
      };
    }>({
      apiKey: key.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          person(id: $id) {
            createdBy {
              principalId
              kind
              label
            }
          }
          auditEvents(first: 10, filter: { action: "person.create" }) {
            nodes {
              actor {
                principalId
                kind
                label
              }
            }
          }
        }
      `,
      variables: { id: userPersonId },
    });
    expect(attribution.body?.errors).toBeUndefined();
    expect(attribution.body?.data?.person.createdBy).toMatchObject({
      principalId: owner.principalId,
      kind: "USER",
      label: expect.any(String),
    });
    expect(
      attribution.body?.data?.auditEvents.nodes.map(
        (node: { actor: { kind: string } }) => node.actor.kind,
      ),
    ).toEqual(expect.arrayContaining(["USER", "API_KEY"]));
    expect(JSON.stringify(attribution.body)).not.toContain(key.key);

    const departing = await fixture.createWorkspaceMember(owner, "contributor");
    const departedPerson = await fixture.createPerson(departing, {
      displayName: "Departed attribution row",
    });
    const departedPersonId = required(
      departedPerson.body?.data?.createPerson?.person?.id,
    );
    await fixture.database.delete(users).where(eq(users.id, departing.userId));
    const departed = await fixture.execute<{
      person: {
        createdBy: { principalId: string; kind: string; label: string };
      };
    }>({
      apiKey: key.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          person(id: $id) {
            createdBy {
              principalId
              kind
              label
            }
          }
        }
      `,
      variables: { id: departedPersonId },
    });
    expect(departed.body?.data?.person.createdBy).toMatchObject({
      principalId: departing.principalId,
      kind: "USER",
      label: "Former user",
    });

    const legacyPrincipalId = newId();
    const legacyPersonId = newId();
    await fixture.connection.unsafe(
      "ALTER TABLE workspace_principals DISABLE TRIGGER workspace_principals_validate_trigger",
    );
    try {
      await fixture.database.insert(workspacePrincipals).values({
        id: legacyPrincipalId,
        workspaceId: owner.workspaceId,
        principalType: "legacy_user",
        userId: `legacy-${newId()}`,
      });
    } finally {
      await fixture.connection.unsafe(
        "ALTER TABLE workspace_principals ENABLE TRIGGER workspace_principals_validate_trigger",
      );
    }
    await fixture.database.insert(people).values({
      id: legacyPersonId,
      workspaceId: owner.workspaceId,
      displayName: "Legacy attribution row",
      createdBy: legacyPrincipalId,
      updatedBy: legacyPrincipalId,
    });
    const legacy = await fixture.execute<{
      person: {
        createdBy: { principalId: string; kind: string; label: string };
      };
    }>({
      apiKey: key.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          person(id: $id) {
            createdBy {
              principalId
              kind
              label
            }
          }
        }
      `,
      variables: { id: legacyPersonId },
    });
    expect(legacy.body?.data?.person.createdBy).toEqual({
      principalId: legacyPrincipalId,
      kind: "LEGACY",
      label: "Legacy actor",
    });

    const foreign = await fixture.createActor();
    const invalidActorPersonId = newId();
    const crossWorkspaceActorPersonId = newId();
    await fixture.database.insert(people).values([
      {
        id: invalidActorPersonId,
        workspaceId: owner.workspaceId,
        displayName: "Invalid attribution token",
        createdBy: "seed-user-beta",
        updatedBy: "seed-user-beta",
      },
      {
        id: crossWorkspaceActorPersonId,
        workspaceId: owner.workspaceId,
        displayName: "Cross workspace attribution token",
        createdBy: foreign.principalId,
        updatedBy: foreign.principalId,
      },
    ]);
    fixture.queryCount = 0;
    const generic = await fixture.execute<{
      invalid: {
        createdBy: { principalId: string | null; kind: string; label: string };
      };
      cross: {
        createdBy: { principalId: string | null; kind: string; label: string };
      };
    }>({
      apiKey: key.key,
      query: /* GraphQL */ `
        query ($invalid: UUID!, $cross: UUID!) {
          invalid: person(id: $invalid) {
            createdBy {
              principalId
              kind
              label
            }
          }
          cross: person(id: $cross) {
            createdBy {
              principalId
              kind
              label
            }
          }
        }
      `,
      variables: {
        invalid: invalidActorPersonId,
        cross: crossWorkspaceActorPersonId,
      },
    });
    expect(generic.body?.errors).toBeUndefined();
    expect(generic.body?.data).toEqual({
      invalid: {
        createdBy: { principalId: null, kind: "LEGACY", label: "Legacy actor" },
      },
      cross: {
        createdBy: { principalId: null, kind: "LEGACY", label: "Legacy actor" },
      },
    });
    expect(JSON.stringify(generic.body)).not.toContain("seed-user-beta");
    expect(JSON.stringify(generic.body)).not.toContain(key.key);
    expect(fixture.queryCount).toBeLessThanOrEqual(12);
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["contributor", true],
    ["analyst", false],
    ["viewer", false],
  ] as const)(
    "enforces the research write role matrix for %s",
    async (role, allowed) => {
      const actor = await fixture.createActor(role);
      const result = await fixture.createPerson(actor, {
        displayName: `Role ${role}`,
      });
      if (allowed) {
        expect(result.body?.errors).toBeUndefined();
        expect(result.body?.data?.createPerson?.person?.displayName).toBe(
          `Role ${role}`,
        );
      } else {
        expectGraphQLError(result, "FORBIDDEN");
      }
    },
  );

  it("authorizes, redacts, paginates, and batches selected person fields", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const peopleResults = await Promise.all(
      ["Selection A", "Selection B", "Selection C"].map((displayName) =>
        fixture.createPerson(owner, { displayName }),
      ),
    );
    const personIds = peopleResults.map((result) =>
      required(result.body?.data?.createPerson?.person?.id),
    );
    const foreignPerson = await fixture.createPerson(foreign, {
      displayName: "Foreign selection subject",
    });
    const foreignPersonId = required(
      foreignPerson.body?.data?.createPerson?.person?.id,
    );
    const fields = [
      { fieldKey: "a_hidden", sensitivity: "confidential" as const },
      { fieldKey: "b_visible", sensitivity: "internal" as const },
      { fieldKey: "c_visible", sensitivity: "internal" as const },
    ];
    const definitionIds = fields.map(() => newId());
    await fixture.database.insert(factDefinitions).values(
      fields.map((field, index) => ({
        id: definitionIds[index]!,
        workspaceId: owner.workspaceId,
        namespace: "profile",
        fieldKey: field.fieldKey,
        label: field.fieldKey,
        allowedValueType: "text" as const,
        state: "active" as const,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    const seeded = personIds.flatMap((personId, personIndex) =>
      fields.map((field, fieldIndex) => ({
        definitionId: definitionIds[fieldIndex]!,
        factId: newId(),
        field,
        personId,
        personIndex,
        selectionId: newId(),
      })),
    );
    await fixture.database.insert(facts).values(
      seeded.map((row) => ({
        id: row.factId,
        workspaceId: owner.workspaceId,
        personId: row.personId,
        factDefinitionId: row.definitionId,
        namespace: "profile",
        fieldKey: row.field.fieldKey,
        label: row.field.fieldKey,
        valueType: "text" as const,
        valueText: `${row.field.fieldKey}-${row.personIndex}`,
        sensitivity: row.field.sensitivity,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(personFieldSelections).values(
      seeded.map((row) => ({
        id: row.selectionId,
        workspaceId: owner.workspaceId,
        personId: row.personId,
        namespace: "profile",
        fieldKey: row.field.fieldKey,
        factId: row.factId,
        selectedBy: owner.principalId,
        selectionReason: `reason-${row.field.fieldKey}-${row.personIndex}`,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );

    const selectionQuery = /* GraphQL */ `
      query ($personId: UUID!, $after: String) {
        person(id: $personId) {
          fieldSelections(first: 1, after: $after) {
            nodes {
              id
              factId
              namespace
              fieldKey
              selectionReason
              version
              fact {
                id
                value {
                  text
                }
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `;
    const personOnly = await fixture.provisionKey(owner, {
      person: ["read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: personOnly.key,
        query: selectionQuery,
        variables: { personId: personIds[0] },
      }),
      "FORBIDDEN",
    );
    const factOnly = await fixture.provisionKey(owner, { fact: ["read"] });
    expectGraphQLError(
      await fixture.execute({
        apiKey: factOnly.key,
        query: selectionQuery,
        variables: { personId: personIds[0] },
      }),
      "FORBIDDEN",
    );
    const reader = await fixture.provisionKey(owner, {
      fact: ["read"],
      person: ["read"],
    });
    fixture.queryCount = 0;
    const batched = await fixture.execute<
      Record<
        string,
        {
          fieldSelections: {
            nodes: Array<{
              fact: { id: string; value: { text: string } } | null;
              factId: string;
              fieldKey: string;
              selectionReason: string;
            }>;
            pageInfo: { endCursor: string; hasNextPage: boolean };
          };
        } | null
      >
    >({
      apiKey: reader.key,
      query: /* GraphQL */ `
        query {
          ${personIds
            .map(
              (id, index) => `p${index}: person(id: "${id}") {
                fieldSelections(first: 1) {
                  nodes {
                    factId
                    fieldKey
                    selectionReason
                    fact { id value { text } }
                  }
                  pageInfo { endCursor hasNextPage }
                }
              }`,
            )
            .join("\n")}
          foreign: person(id: "${foreignPersonId}") {
            fieldSelections(first: 1) { nodes { id } pageInfo { endCursor } }
          }
        }
      `,
    });
    expect(batched.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(14);
    expect(batched.body?.data?.foreign).toBeNull();
    for (let index = 0; index < personIds.length; index += 1) {
      const page = batched.body?.data?.[`p${index}`]?.fieldSelections;
      const visible = seeded.find(
        (row) =>
          row.personIndex === index && row.field.fieldKey === "b_visible",
      )!;
      expect(page).toEqual({
        nodes: [
          {
            fact: {
              id: visible.factId,
              value: { text: `b_visible-${index}` },
            },
            factId: visible.factId,
            fieldKey: "b_visible",
            selectionReason: `reason-b_visible-${index}`,
          },
        ],
        pageInfo: { endCursor: expect.any(String), hasNextPage: true },
      });
    }
    const serialized = JSON.stringify(batched.body);
    for (const hidden of seeded.filter(
      (row) => row.field.fieldKey === "a_hidden",
    )) {
      expect(serialized).not.toContain(hidden.factId);
      expect(serialized).not.toContain(hidden.selectionId);
      expect(serialized).not.toContain(`reason-a_hidden-${hidden.personIndex}`);
    }

    const firstPage = batched.body?.data?.p0?.fieldSelections;
    const secondPage = await fixture.execute<{
      person: {
        fieldSelections: {
          nodes: Array<{ factId: string; fieldKey: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>({
      apiKey: reader.key,
      query: selectionQuery,
      variables: {
        after: required(firstPage?.pageInfo.endCursor),
        personId: personIds[0],
      },
    });
    const finalVisible = seeded.find(
      (row) => row.personIndex === 0 && row.field.fieldKey === "c_visible",
    )!;
    expect(secondPage.body?.errors).toBeUndefined();
    expect(secondPage.body?.data?.person?.fieldSelections).toMatchObject({
      nodes: [{ factId: finalVisible.factId, fieldKey: "c_visible" }],
      pageInfo: { hasNextPage: false },
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: reader.key,
        query: selectionQuery,
        variables: {
          after: `${required(firstPage?.pageInfo.endCursor)}=`,
          personId: personIds[0],
        },
      }),
      "VALIDATION_FAILED",
    );
  });

  it("masks cross-workspace source reads, filters, mutation references, and version probes", async () => {
    const local = await fixture.createActor();
    const foreign = await fixture.createActor();
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: foreign.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Foreign source" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);

    const root = await fixture.execute({
      jar: local.jar,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          source(id: $id) {
            id
          }
        }
      `,
      variables: { id: sourceId },
    });
    expect(root.body?.errors).toBeUndefined();
    expect(root.body?.data).toEqual({ source: null });

    const evidenceReader = await fixture.provisionKey(local, {
      evidence: ["read"],
    });
    const filtered = await fixture.execute({
      apiKey: evidenceReader.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          evidenceItems(filter: { sourceId: $id }, first: 1) {
            nodes {
              id
            }
          }
        }
      `,
      variables: { id: sourceId },
    });
    expect(filtered.body?.errors).toBeUndefined();
    expect(filtered.body?.data).toEqual({ evidenceItems: { nodes: [] } });
    const missing = await fixture.execute({
      apiKey: evidenceReader.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          evidenceItems(sourceId: $id, first: 1) {
            nodes {
              id
            }
          }
        }
      `,
      variables: { id: newId() },
    });
    expect(missing.body).toEqual(filtered.body);
    const hiddenSourceId = newId();
    await fixture.database.insert(sources).values({
      id: hiddenSourceId,
      workspaceId: local.workspaceId,
      kind: "archive",
      title: "Hidden local source",
      sensitivity: "confidential",
      createdBy: local.principalId,
      updatedBy: local.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: newId(),
      workspaceId: local.workspaceId,
      sourceId: hiddenSourceId,
      checksum: `sha256:${"d".repeat(64)}`,
      createdBy: local.principalId,
      updatedBy: local.principalId,
    });
    const hidden = await fixture.execute({
      apiKey: evidenceReader.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          evidenceItems(filter: { sourceId: $id }, first: 1) {
            nodes {
              id
            }
          }
        }
      `,
      variables: { id: hiddenSourceId },
    });
    expect(hidden.body).toEqual(filtered.body);
    const noEvidenceRead = await fixture.provisionKey(local, {
      source: ["read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: noEvidenceRead.key,
        query: /* GraphQL */ `
          query ($id: UUID!) {
            evidenceItems(sourceId: $id, first: 1) {
              nodes {
                id
              }
            }
          }
        `,
        variables: { id: sourceId },
      }),
      "FORBIDDEN",
    );

    const reference = await fixture.execute({
      jar: local.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            evidenceItem {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: { input: { sourceId, checksum: `sha256:${"a".repeat(64)}` } },
    });
    expectGraphQLError(reference, "NOT_FOUND");

    const versionProbe = await fixture.execute({
      jar: local.jar,
      query: /* GraphQL */ `
        mutation ($input: UpdateSourceInput!) {
          updateSource(input: $input) {
            source {
              id
            }
            code
            currentVersion
          }
        }
      `,
      variables: {
        input: { id: sourceId, expectedVersion: 999, title: "Probe" },
      },
    });
    expectGraphQLError(versionProbe, "NOT_FOUND");
  });

  it("filters confidential linked evidence for an ungranted same-workspace viewer", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const person = await fixture.createPerson(owner, {
      displayName: "Sensitivity subject",
    });
    const personId = required(person.body?.data?.createPerson?.person?.id);
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            factDefinition {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "claim",
          label: "Claim",
          allowedValueType: "TEXT",
          state: "ACTIVE",
        },
      },
    });
    const fact = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactInput!) {
          createFact(input: $input) {
            fact {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: {
        input: {
          personId,
          definitionId:
            definition.body?.data?.createFactDefinition.factDefinition?.id,
          value: { text: "Visible fact" },
        },
      },
    });
    const factId = required(fact.body?.data?.createFact.fact?.id);
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Confidential source" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const evidence = await fixture.execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            evidenceItem {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: { input: { sourceId, checksum: `sha256:${"b".repeat(64)}` } },
    });
    const evidenceId = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem?.id,
    );
    await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: LinkFactEvidenceInput!) {
          linkFactEvidence(input: $input) {
            factEvidence {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: { input: { factId, evidenceItemId: evidenceId } },
    });
    await fixture.database
      .update(evidenceItems)
      .set({ sensitivity: "confidential" })
      .where(eq(evidenceItems.id, evidenceId));
    await fixture.database
      .update(sources)
      .set({ sensitivity: "confidential" })
      .where(eq(sources.id, sourceId));

    const result = await fixture.execute<{
      fact: { evidence: { nodes: unknown[] } } | null;
      source: unknown;
      evidenceItem: unknown;
    }>({
      jar: viewer.jar,
      query: /* GraphQL */ `
        query ($factId: UUID!, $sourceId: UUID!, $evidenceId: UUID!) {
          fact(id: $factId) {
            evidence(first: 10) {
              nodes {
                id
              }
            }
          }
          source(id: $sourceId) {
            id
          }
          evidenceItem(id: $evidenceId) {
            id
          }
        }
      `,
      variables: { factId, sourceId, evidenceId },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data).toEqual({
      fact: { evidence: { nodes: [] } },
      source: null,
      evidenceItem: null,
    });

    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: "Evidence readers",
      sensitivityCeiling: "confidential",
      resourceKinds: ["evidence"],
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      policyId,
      memberId: viewer.memberId,
      resourceId: evidenceId,
      resourceKind: "evidence",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const granted = await fixture.execute<{
      evidenceItem: { id: string; source: unknown } | null;
      fact: { evidence: { nodes: unknown[] } } | null;
    }>({
      jar: viewer.jar,
      query: /* GraphQL */ `
        query ($id: UUID!, $factId: UUID!) {
          evidenceItem(id: $id) {
            id
            source {
              id
            }
          }
          fact(id: $factId) {
            evidence(first: 10) {
              nodes {
                id
              }
            }
          }
        }
      `,
      variables: { id: evidenceId, factId },
    });
    expect(granted.body?.errors).toBeUndefined();
    expect(granted.body?.data).toEqual({
      evidenceItem: { id: evidenceId, source: null },
      fact: { evidence: { nodes: [{ id: expect.any(String) }] } },
    });

    const sourcePolicyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: sourcePolicyId,
      workspaceId: owner.workspaceId,
      name: "Source readers",
      sensitivityCeiling: "confidential",
      resourceKinds: ["source"],
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      policyId: sourcePolicyId,
      memberId: viewer.memberId,
      resourceId: sourceId,
      resourceKind: "source",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const fullyGranted = await fixture.execute({
      jar: viewer.jar,
      query: /* GraphQL */ `
        query ($factId: UUID!) {
          fact(id: $factId) {
            evidence(first: 10) {
              nodes {
                evidenceItem {
                  id
                }
              }
            }
          }
        }
      `,
      variables: { factId },
    });
    expect(fullyGranted.body?.errors).toBeUndefined();
    expect(fullyGranted.body?.data).toEqual({
      fact: {
        evidence: { nodes: [{ evidenceItem: { id: evidenceId } }] },
      },
    });
  });

  it("does not make evidence scope transitive to source reads", async () => {
    const owner = await fixture.createActor();
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Scoped source" } },
    });
    const evidence = await fixture.execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            evidenceItem {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          sourceId: source.body?.data?.createSource.source?.id,
          checksum: `sha256:${"c".repeat(64)}`,
        },
      },
    });
    const key = await fixture.provisionKey(owner, { evidence: ["read"] });
    const result = await fixture.execute({
      apiKey: key.key,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          evidenceItem(id: $id) {
            id
            source {
              id
            }
          }
        }
      `,
      variables: {
        id: evidence.body?.data?.createEvidenceItem.evidenceItem?.id,
      },
    });
    expectGraphQLError(result, "FORBIDDEN");
  });

  it("reserves archived person state for the delete mutation", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.createPerson(owner, {
      displayName: "Archive boundary",
    });
    const personId = required(created.body?.data?.createPerson?.person?.id);
    const updateKey = await fixture.provisionKey(owner, {
      person: ["read", "update"],
    });
    const denied = await fixture.execute<{
      updatePerson: { code: string | null; person: unknown };
    }>({
      apiKey: updateKey.key,
      query: /* GraphQL */ `
        mutation ($input: UpdatePersonInput!) {
          updatePerson(input: $input) {
            person {
              id
              status
              version
            }
            code
            issues {
              code
              path
            }
          }
        }
      `,
      variables: {
        input: { id: personId, expectedVersion: 1, status: "ARCHIVED" },
      },
    });
    expect(denied.body?.errors).toBeUndefined();
    expect(denied.body?.data?.updatePerson).toMatchObject({
      code: "VALIDATION_FAILED",
      person: null,
    });
    const [unchanged] = await fixture.database
      .select({ deletedAt: people.deletedAt, status: people.status })
      .from(people)
      .where(eq(people.id, personId));
    expect(unchanged).toEqual({ deletedAt: null, status: "active" });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, personId),
            eq(auditEvents.action, "person.update"),
          ),
        ),
    ).toEqual([]);

    const deleteKey = await fixture.provisionKey(owner, {
      person: ["delete"],
    });
    const archived = await fixture.execute<{
      archivePerson: { code: string | null; person: { status: string } | null };
    }>({
      apiKey: deleteKey.key,
      query: /* GraphQL */ `
        mutation ($input: ArchivePersonInput!) {
          archivePerson(input: $input) {
            person {
              id
              status
              version
            }
            code
          }
        }
      `,
      variables: { input: { id: personId, expectedVersion: 1 } },
    });
    expect(archived.body?.errors).toBeUndefined();
    expect(archived.body?.data?.archivePerson).toMatchObject({
      code: null,
      person: { status: "ARCHIVED" },
    });
  });

  it("uses evidence update and tag update for exact write permissions", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Exact permission subject",
    });
    const personId = required(person.body?.data?.createPerson?.person?.id);
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Exact permissions" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const evidence = await fixture.execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            evidenceItem {
              id
            }
          }
        }
      `,
      variables: {
        input: { sourceId, checksum: `sha256:${"d".repeat(64)}` },
      },
    });
    const evidenceItemId = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem?.id,
    );
    const createOnly = await fixture.provisionKey(owner, {
      evidence: ["create", "read"],
      source: ["read"],
    });
    const excerptMutation = /* GraphQL */ `
      mutation ($input: CreateEvidenceExcerptInput!) {
        createEvidenceExcerpt(input: $input) {
          evidenceExcerpt {
            id
          }
          code
        }
      }
    `;
    const excerptInput = {
      evidenceItemId,
      excerpt: "Safe excerpt",
      checksum: `sha256:${"e".repeat(64)}`,
    };
    expectGraphQLError(
      await fixture.execute({
        apiKey: createOnly.key,
        query: excerptMutation,
        variables: { input: excerptInput },
      }),
      "FORBIDDEN",
    );
    const updateEvidence = await fixture.provisionKey(owner, {
      evidence: ["update"],
    });
    const allowedExcerpt = await fixture.execute({
      apiKey: updateEvidence.key,
      query: excerptMutation,
      variables: { input: excerptInput },
    });
    expect(allowedExcerpt.body?.errors).toBeUndefined();

    const tag = await fixture.execute<{
      createTag: { tag: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateTagInput!) {
          createTag(input: $input) {
            tag {
              id
            }
          }
        }
      `,
      variables: { input: { name: "Exact update" } },
    });
    const tagId = required(tag.body?.data?.createTag.tag?.id);
    const tagMutation = (name: "tagPerson" | "untagPerson") => /* GraphQL */ `
      mutation ($input: TagPersonInput!) {
        ${name}(input: $input) { personTag { id } code }
      }
    `;
    const legacyTagKey = await fixture.provisionKey(owner, {
      person: ["read", "update"],
      tag: ["create", "delete"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: legacyTagKey.key,
        query: tagMutation("tagPerson"),
        variables: { input: { personId, tagId } },
      }),
      "FORBIDDEN",
    );
    const exactTagKey = await fixture.provisionKey(owner, {
      person: ["update"],
      tag: ["update"],
    });
    const tagged = await fixture.execute({
      apiKey: exactTagKey.key,
      query: tagMutation("tagPerson"),
      variables: { input: { personId, tagId } },
    });
    expect(tagged.body?.errors).toBeUndefined();
    const firstUntag = await fixture.execute({
      apiKey: exactTagKey.key,
      query: tagMutation("untagPerson"),
      variables: { input: { personId, tagId } },
    });
    const repeatedUntag = await fixture.execute<{
      untagPerson: { code: string | null; personTag: null };
    }>({
      apiKey: exactTagKey.key,
      query: tagMutation("untagPerson"),
      variables: { input: { personId, tagId } },
    });
    expect(firstUntag.body?.errors).toBeUndefined();
    expect(repeatedUntag.body?.errors).toBeUndefined();
    expect(repeatedUntag.body?.data?.untagPerson).toEqual({
      code: null,
      personTag: null,
    });
    const untagAudits = await fixture.database
      .select({ redactedDiff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, personId),
          eq(auditEvents.action, "untag.person"),
        ),
      )
      .orderBy(auditEvents.occurredAt);
    expect(untagAudits).toHaveLength(2);
    expect(untagAudits[0]?.redactedDiff).toMatchObject({
      changedFields: ["tagId"],
      metadata: { state: "changed" },
    });
    expect(untagAudits[1]?.redactedDiff).toMatchObject({
      changedFields: [],
      metadata: { state: "unchanged" },
    });
  });

  it("does not expose linked resource IDs without linked read authority", async () => {
    const owner = await fixture.createActor();
    const subject = await fixture.createPerson(owner, {
      displayName: "Linked ID subject",
    });
    const referenced = await fixture.createPerson(owner, {
      displayName: "Linked ID referenced person",
    });
    const target = await fixture.createPerson(owner, {
      displayName: "Linked ID relationship target",
    });
    const subjectId = required(subject.body?.data?.createPerson?.person?.id);
    const referencedPersonId = required(
      referenced.body?.data?.createPerson?.person?.id,
    );
    const targetId = required(target.body?.data?.createPerson?.person?.id);
    const placeId = newId();
    const fileId = newId();
    await fixture.database.insert(places).values({
      id: placeId,
      workspaceId: owner.workspaceId,
      name: "Scoped place",
      kind: "city",
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: owner.workspaceId,
      storageProvider: "s3",
      storageBucket: "fixture",
      storageKey: `fixture/${fileId}`,
      originalName: "fixture.txt",
      byteSize: 7,
      checksum: `sha256:${"f".repeat(64)}`,
      quarantineState: "available",
      scanState: "not_required",
      uploadedBy: owner.userId,
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const createFact = async (
      fieldKey: string,
      allowedValueType: string,
      value: Record<string, unknown>,
    ) => {
      const definition = await fixture.execute<{
        createFactDefinition: { factDefinition: { id: string } | null };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateFactDefinitionInput!) {
            createFactDefinition(input: $input) {
              factDefinition {
                id
              }
            }
          }
        `,
        variables: {
          input: {
            namespace: "person",
            fieldKey,
            label: fieldKey,
            allowedValueType,
            state: "ACTIVE",
          },
        },
      });
      const fact = await fixture.execute<{
        createFact: { fact: { id: string } | null };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateFactInput!) {
            createFact(input: $input) {
              fact {
                id
              }
            }
          }
        `,
        variables: {
          input: {
            personId: subjectId,
            definitionId:
              definition.body?.data?.createFactDefinition.factDefinition?.id,
            value,
          },
        },
      });
      return required(fact.body?.data?.createFact.fact?.id);
    };
    const personFactId = await createFact("linked_person", "PERSON_REFERENCE", {
      referencedPersonId,
    });
    const placeFactId = await createFact("linked_place", "PLACE_REFERENCE", {
      placeId,
    });
    const fileFactId = await createFact("linked_file", "FILE_REFERENCE", {
      fileId,
    });
    const relationshipType = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipTypeInput!) {
          createRelationshipType(input: $input) {
            relationshipType {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          key: "linked_ids",
          forwardLabel: "links",
          inverseLabel: "linked by",
        },
      },
    });
    const relationship = await fixture.execute<{
      createRelationship: { relationship: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipInput!) {
          createRelationship(input: $input) {
            relationship {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          sourcePersonId: subjectId,
          targetPersonId: targetId,
          relationshipTypeId:
            relationshipType.body?.data?.createRelationshipType.relationshipType
              ?.id,
        },
      },
    });
    const relationshipId = required(
      relationship.body?.data?.createRelationship.relationship?.id,
    );
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Linked ID source" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const evidence = await fixture.execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            evidenceItem {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          sourceId,
          fileId,
          checksum: `sha256:${"1".repeat(64)}`,
        },
      },
    });
    const evidenceItemId = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem?.id,
    );
    const query = /* GraphQL */ `
      query (
        $personFactId: UUID!
        $placeFactId: UUID!
        $fileFactId: UUID!
        $relationshipId: UUID!
        $evidenceItemId: UUID!
      ) {
        personFact: fact(id: $personFactId) {
          personId
          value {
            referencedPersonId
          }
          revisions(first: 10) {
            nodes {
              beforeSnapshot
              afterSnapshot
            }
          }
        }
        placeFact: fact(id: $placeFactId) {
          personId
          value {
            placeId
          }
        }
        fileFact: fact(id: $fileFactId) {
          personId
          value {
            fileId
          }
        }
        relationship(id: $relationshipId) {
          sourcePersonId
          targetPersonId
        }
        evidenceItem(id: $evidenceItemId) {
          sourceId
          fileId
        }
      }
    `;
    const variables = {
      personFactId,
      placeFactId,
      fileFactId,
      relationshipId,
      evidenceItemId,
    };
    const parentOnly = await fixture.provisionKey(owner, {
      evidence: ["read"],
      fact: ["read"],
      relationship: ["read"],
    });
    const hidden = await fixture.execute({
      apiKey: parentOnly.key,
      query,
      variables,
    });
    expect(hidden.body?.errors).toBeUndefined();
    expect(hidden.body?.data).toEqual({
      personFact: {
        personId: null,
        value: { referencedPersonId: null },
        revisions: {
          nodes: [
            {
              beforeSnapshot: null,
              afterSnapshot: expect.objectContaining({
                personId: null,
                referencedPersonId: null,
              }),
            },
          ],
        },
      },
      placeFact: { personId: null, value: { placeId: null } },
      fileFact: { personId: null, value: { fileId: null } },
      relationship: { sourcePersonId: null, targetPersonId: null },
      evidenceItem: { sourceId: null, fileId: null },
    });
    const linkedReads = await fixture.provisionKey(owner, {
      evidence: ["read"],
      fact: ["read"],
      file: ["read"],
      person: ["read"],
      relationship: ["read"],
      source: ["read"],
    });
    const visible = await fixture.execute({
      apiKey: linkedReads.key,
      query,
      variables,
    });
    expect(visible.body?.errors).toBeUndefined();
    expect(visible.body?.data).toMatchObject({
      personFact: { personId: subjectId, value: { referencedPersonId } },
      placeFact: { personId: subjectId, value: { placeId: null } },
      fileFact: { personId: subjectId, value: { fileId } },
      relationship: { sourcePersonId: subjectId, targetPersonId: targetId },
      evidenceItem: { sourceId, fileId },
    });
    const relationshipCitation = (
      mutation: "linkRelationshipEvidence" | "unlinkRelationshipEvidence",
    ) => /* GraphQL */ `
      mutation ($input: ${mutation === "linkRelationshipEvidence" ? "LinkRelationshipEvidenceInput" : "UnlinkRelationshipEvidenceInput"}!) {
        ${mutation}(input: $input) {
          relationshipEvidence {
            id
            evidenceItemId
            createdAt
            createdBy { kind }
            evidenceItem { id }
          }
          code
        }
      }
    `;
    const relationshipWriter = await fixture.provisionKey(owner, {
      relationship: ["update"],
      evidence: ["read"],
    });
    const linkedRelationshipEvidence = await fixture.execute({
      apiKey: relationshipWriter.key,
      query: relationshipCitation("linkRelationshipEvidence"),
      variables: { input: { relationshipId, evidenceItemId } },
    });
    expect(linkedRelationshipEvidence.body?.errors).toBeUndefined();
    expect(
      linkedRelationshipEvidence.body?.data?.linkRelationshipEvidence,
    ).toMatchObject({
      relationshipEvidence: {
        createdAt: expect.any(String),
        createdBy: { kind: "API_KEY" },
      },
    });
    const unlinkOnly = await fixture.provisionKey(owner, {
      relationship: ["update"],
    });
    const unlinkedRelationshipEvidence = await fixture.execute({
      apiKey: unlinkOnly.key,
      query: relationshipCitation("unlinkRelationshipEvidence"),
      variables: { input: { relationshipId, evidenceItemId } },
    });
    expect(unlinkedRelationshipEvidence.body?.errors).toBeUndefined();
    expect(
      unlinkedRelationshipEvidence.body?.data?.unlinkRelationshipEvidence,
    ).toMatchObject({
      relationshipEvidence: {
        evidenceItemId,
        evidenceItem: null,
      },
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: unlinkOnly.key,
        query: relationshipCitation("linkRelationshipEvidence"),
        variables: { input: { relationshipId, evidenceItemId } },
      }),
      "FORBIDDEN",
    );
    await fixture.execute({
      apiKey: relationshipWriter.key,
      query: relationshipCitation("linkRelationshipEvidence"),
      variables: { input: { relationshipId, evidenceItemId } },
    });
    const readableRelationshipUnlink = await fixture.execute({
      apiKey: relationshipWriter.key,
      query: relationshipCitation("unlinkRelationshipEvidence"),
      variables: { input: { relationshipId, evidenceItemId } },
    });
    expect(
      readableRelationshipUnlink.body?.data?.unlinkRelationshipEvidence,
    ).toMatchObject({
      relationshipEvidence: {
        evidenceItemId,
        evidenceItem: { id: evidenceItemId },
      },
    });
  });

  it("rejects a fact revision that references a hidden record without side effects", async () => {
    const owner = await fixture.createActor();
    const contributor = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const subject = await fixture.createPerson(owner, {
      displayName: "Revision subject",
    });
    const referenced = await fixture.createPerson(owner, {
      displayName: "Hidden revision reference",
    });
    const subjectId = required(subject.body?.data?.createPerson?.person?.id);
    const referencedPersonId = required(
      referenced.body?.data?.createPerson?.person?.id,
    );
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            factDefinition {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "hidden_revision_reference",
          label: "Hidden revision reference",
          allowedValueType: "PERSON_REFERENCE",
          state: "ACTIVE",
        },
      },
    });
    const created = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactInput!) {
          createFact(input: $input) {
            fact {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          personId: subjectId,
          definitionId:
            definition.body?.data?.createFactDefinition.factDefinition?.id,
          value: { referencedPersonId },
        },
      },
    });
    const factId = required(created.body?.data?.createFact.fact?.id);
    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, referencedPersonId));

    const result = await fixture.execute({
      jar: contributor.jar,
      query: /* GraphQL */ `
        mutation ($input: ReviseFactInput!) {
          reviseFact(input: $input) {
            fact {
              id
            }
            code
            issues {
              code
              path
            }
          }
        }
      `,
      variables: {
        input: {
          id: factId,
          expectedVersion: 1,
          value: { referencedPersonId },
        },
      },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.reviseFact).toMatchObject({
      fact: null,
      code: "VALIDATION_FAILED",
      issues: [{ code: "NOT_FOUND", path: ["value"] }],
    });
    expect(
      await fixture.database
        .select({ id: factRevisions.id })
        .from(factRevisions)
        .where(eq(factRevisions.factId, factId)),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, factId),
            eq(auditEvents.action, "fact.revise"),
          ),
        ),
    ).toEqual([]);
  });

  it("composes note subject and fact citation permissions", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Composite authorization subject",
    });
    const personId = required(person.body?.data?.createPerson?.person?.id);
    const createdNote = await fixture.execute<{
      createNote: { note: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateNoteInput!) {
          createNote(input: $input) {
            note {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          subject: { personId },
          content: { plainText: "Composite note" },
        },
      },
    });
    const noteId = required(createdNote.body?.data?.createNote.note?.id);
    const noteCreator = await fixture.provisionKey(owner, {
      note: ["create"],
      person: ["read"],
    });
    const minimallyCreated = await fixture.execute<{
      createNote: { note: { id: string } | null };
    }>({
      apiKey: noteCreator.key,
      query: /* GraphQL */ `
        mutation ($input: CreateNoteInput!) {
          createNote(input: $input) {
            note {
              id
            }
            code
          }
        }
      `,
      variables: {
        input: {
          subject: { personId },
          content: { plainText: "Minimally scoped note" },
        },
      },
    });
    expect(minimallyCreated.body?.errors).toBeUndefined();
    const minimallyCreatedId = required(
      minimallyCreated.body?.data?.createNote.note?.id,
    );
    const noteQuery = /* GraphQL */ `
      query ($id: UUID!) {
        note(id: $id) {
          id
          personId
          plainText
          version
        }
        notes(first: 10) {
          nodes {
            id
            personId
          }
        }
      }
    `;
    const noteOnly = await fixture.provisionKey(owner, { note: ["read"] });
    const hiddenNote = await fixture.execute({
      apiKey: noteOnly.key,
      query: noteQuery,
      variables: { id: noteId },
    });
    expect(hiddenNote.body?.errors).toBeUndefined();
    expect(hiddenNote.body?.data).toEqual({
      note: null,
      notes: { nodes: [] },
    });
    const hiddenMutationShape = (result: {
      body: unknown;
      status: number;
    }) => ({
      status: result.status,
      body: JSON.parse(
        JSON.stringify(result.body, (key, value) =>
          key === "requestId" ? undefined : value,
        ),
      ),
    });
    for (const [permission, mutation, input] of [
      [
        "update",
        "updateNote",
        (id: string) => ({
          id,
          expectedVersion: 1,
          content: { plainText: "oracle" },
        }),
      ],
      ["delete", "archiveNote", (id: string) => ({ id, expectedVersion: 1 })],
    ] as const) {
      const key = await fixture.provisionKey(owner, {
        note: [permission],
      });
      const document = /* GraphQL */ `
        mutation ($input: ${mutation === "updateNote" ? "UpdateNoteInput" : "ArchiveNoteInput"}!) {
          ${mutation}(input: $input) { code }
        }
      `;
      const hidden = await fixture.execute({
        apiKey: key.key,
        query: document,
        variables: { input: input(noteId) },
      });
      const random = await fixture.execute({
        apiKey: key.key,
        query: document,
        variables: { input: input(newId()) },
      });
      expect(hidden.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      expect(hiddenMutationShape(hidden)).toEqual(hiddenMutationShape(random));
    }
    const subjectReader = await fixture.provisionKey(owner, {
      note: ["read"],
      person: ["read"],
    });
    const readable = await fixture.execute({
      apiKey: subjectReader.key,
      query: noteQuery,
      variables: { id: noteId },
    });
    expect(readable.body?.errors).toBeUndefined();
    expect(readable.body?.data).toMatchObject({
      note: { id: noteId, personId, plainText: "Composite note", version: 1 },
      notes: { nodes: expect.arrayContaining([{ id: noteId, personId }]) },
    });
    const noteWriterWithoutSubjectUpdate = await fixture.provisionKey(owner, {
      note: ["read", "update"],
      person: ["read"],
    });
    const updateNote = /* GraphQL */ `
      mutation ($input: UpdateNoteInput!) {
        updateNote(input: $input) {
          note {
            id
            version
          }
          code
        }
      }
    `;
    const updated = await fixture.execute({
      apiKey: noteWriterWithoutSubjectUpdate.key,
      query: updateNote,
      variables: {
        input: {
          id: noteId,
          expectedVersion: 1,
          content: { plainText: "Authorized" },
        },
      },
    });
    expect(updated.body?.errors).toBeUndefined();
    const noteArchiver = await fixture.provisionKey(owner, {
      note: ["delete"],
      person: ["read"],
    });
    const archived = await fixture.execute({
      apiKey: noteArchiver.key,
      query: /* GraphQL */ `
        mutation ($input: ArchiveNoteInput!) {
          archiveNote(input: $input) {
            note {
              id
            }
            code
          }
        }
      `,
      variables: { input: { id: minimallyCreatedId, expectedVersion: 1 } },
    });
    expect(archived.body?.errors).toBeUndefined();

    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            factDefinition {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "citation_scope",
          label: "Citation scope",
          allowedValueType: "TEXT",
          state: "ACTIVE",
        },
      },
    });
    const fact = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactInput!) {
          createFact(input: $input) {
            fact {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          personId,
          definitionId:
            definition.body?.data?.createFactDefinition.factDefinition?.id,
          value: { text: "Citation" },
        },
      },
    });
    const factId = required(fact.body?.data?.createFact.fact?.id);
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Citation source" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const evidence = await fixture.execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            evidenceItem {
              id
            }
          }
        }
      `,
      variables: {
        input: { sourceId, checksum: `sha256:${"2".repeat(64)}` },
      },
    });
    const evidenceItemId = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem?.id,
    );
    await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: LinkFactEvidenceInput!) {
          linkFactEvidence(input: $input) {
            factEvidence {
              id
            }
          }
        }
      `,
      variables: { input: { factId, evidenceItemId } },
    });
    const factCitation = (
      mutation: "linkFactEvidence" | "unlinkFactEvidence",
    ) => /* GraphQL */ `
      mutation ($input: ${mutation === "linkFactEvidence" ? "LinkFactEvidenceInput" : "UnlinkFactEvidenceInput"}!) {
        ${mutation}(input: $input) {
          factEvidence { id evidenceItemId evidenceItem { id } }
          code
        }
      }
    `;
    const factUnlinker = await fixture.provisionKey(owner, {
      fact: ["update"],
    });
    const unlinked = await fixture.execute({
      apiKey: factUnlinker.key,
      query: factCitation("unlinkFactEvidence"),
      variables: { input: { factId, evidenceItemId } },
    });
    expect(unlinked.body?.errors).toBeUndefined();
    expect(unlinked.body?.data?.unlinkFactEvidence).toMatchObject({
      factEvidence: { evidenceItemId, evidenceItem: null },
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: factUnlinker.key,
        query: factCitation("linkFactEvidence"),
        variables: { input: { factId, evidenceItemId } },
      }),
      "FORBIDDEN",
    );
    const factLinker = await fixture.provisionKey(owner, {
      fact: ["update"],
      evidence: ["read"],
    });
    const relinked = await fixture.execute({
      apiKey: factLinker.key,
      query: factCitation("linkFactEvidence"),
      variables: { input: { factId, evidenceItemId } },
    });
    expect(relinked.body?.errors).toBeUndefined();
    const readableFactUnlink = await fixture.execute({
      apiKey: factLinker.key,
      query: factCitation("unlinkFactEvidence"),
      variables: { input: { factId, evidenceItemId } },
    });
    expect(readableFactUnlink.body?.data?.unlinkFactEvidence).toMatchObject({
      factEvidence: {
        evidenceItemId,
        evidenceItem: { id: evidenceItemId },
      },
    });
    await fixture.execute({
      apiKey: factLinker.key,
      query: factCitation("linkFactEvidence"),
      variables: { input: { factId, evidenceItemId } },
    });
    const citations = /* GraphQL */ `
      query ($id: UUID!) {
        fact(id: $id) {
          evidence(first: 10) {
            nodes {
              id
              evidenceItem {
                id
                sourceId
              }
            }
          }
        }
      }
    `;
    const noSourceScope = await fixture.provisionKey(owner, {
      evidence: ["read"],
      fact: ["read"],
    });
    const safelyRedacted = await fixture.execute({
      apiKey: noSourceScope.key,
      query: citations,
      variables: { id: factId },
    });
    expect(safelyRedacted.body?.errors).toBeUndefined();
    expect(safelyRedacted.body?.data).toMatchObject({
      fact: {
        evidence: {
          nodes: [{ evidenceItem: { id: evidenceItemId, sourceId: null } }],
        },
      },
    });
    const citationReader = await fixture.provisionKey(owner, {
      evidence: ["read"],
      fact: ["read"],
      source: ["read"],
    });
    const cited = await fixture.execute({
      apiKey: citationReader.key,
      query: citations,
      variables: { id: factId },
    });
    expect(cited.body?.errors).toBeUndefined();
    expect(cited.body?.data).toMatchObject({
      fact: {
        evidence: {
          nodes: [{ evidenceItem: { id: evidenceItemId, sourceId } }],
        },
      },
    });
  });

  it("clears nested request caches between serial owning mutations", async () => {
    const owner = await fixture.createActor();
    const firstPerson = await fixture.createPerson(owner, {
      displayName: "Serial cache subject",
    });
    const secondPerson = await fixture.createPerson(owner, {
      displayName: "Serial cache target",
    });
    const personId = required(firstPerson.body?.data?.createPerson?.person?.id);
    const targetPersonId = required(
      secondPerson.body?.data?.createPerson?.person?.id,
    );
    const definitionId = newId();
    const firstFactId = newId();
    const secondFactId = newId();
    const relationshipTypeId = newId();
    const relationshipId = newId();
    const sourceId = newId();
    const evidenceItemId = newId();
    const tagId = newId();

    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: owner.workspaceId,
      namespace: "person",
      fieldKey: "serial-cache",
      label: "Serial cache",
      allowedValueType: "text",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(facts).values([
      {
        id: firstFactId,
        workspaceId: owner.workspaceId,
        personId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "serial-cache",
        label: "Serial cache first",
        valueType: "text",
        valueText: "first",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: secondFactId,
        workspaceId: owner.workspaceId,
        personId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "serial-cache",
        label: "Serial cache second",
        valueType: "text",
        valueText: "second",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(factRevisions).values([
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        factId: firstFactId,
        revision: 1,
        afterSnapshot: { valueText: "first" },
        createdBy: owner.principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        factId: secondFactId,
        revision: 1,
        afterSnapshot: { valueText: "second" },
        createdBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: owner.workspaceId,
      key: "serial-cache",
      forwardLabel: "serial cache",
      inverseLabel: "serial cached by",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationships).values({
      id: relationshipId,
      workspaceId: owner.workspaceId,
      sourcePersonId: personId,
      targetPersonId,
      relationshipTypeId,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: owner.workspaceId,
      kind: "archive",
      title: "Serial cache source",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceItemId,
      workspaceId: owner.workspaceId,
      sourceId,
      checksum: `sha256:${"c".repeat(64)}`,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(tags).values({
      id: tagId,
      workspaceId: owner.workspaceId,
      name: "Serial cache",
      normalizedName: "serial-cache",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });

    type ConnectionNode = { id: string; plainText?: string; revision?: number };
    type Connection = { nodes: ConnectionNode[] };
    type FactSnapshot = {
      version: number;
      revisions: Connection;
      relationships: Connection;
      evidence: Connection;
      notes: Connection;
      tags: Connection;
    };
    type RelationshipSnapshot = {
      version: number;
      evidence: Connection;
      tags: Connection;
    };
    type SerialMutationData = {
      [key: string]: null | {
        fact?: FactSnapshot | null;
        factRelationship?: { id: string } | null;
        factEvidence?: {
          id: string;
          evidenceItem: { excerpts: Connection } | null;
        } | null;
        relationshipEvidence?: { id: string } | null;
        evidenceExcerpt?: { id: string } | null;
        note?: { id: string; version?: number } | null;
        relationship?: RelationshipSnapshot | null;
      };
    };

    const added = await fixture.execute<SerialMutationData>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation {
          prime: reviseFact(input: { id: "${firstFactId}", expectedVersion: 1, confidence: 0.9 }) {
            fact {
              version
              revisions(first: 10) { nodes { id revision } }
              relationships(first: 1) { nodes { id } }
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id plainText } }
              tags(first: 1) { nodes { id } }
            }
          }
          relation: createFactRelationship(input: {
            sourceFactId: "${firstFactId}"
            targetFactId: "${secondFactId}"
            relationshipType: SUPPORTS
          }) { factRelationship { id } }
          citation: linkFactEvidence(input: {
            factId: "${firstFactId}"
            evidenceItemId: "${evidenceItemId}"
          }) {
            factEvidence {
              id
              evidenceItem { excerpts(first: 1) { nodes { id } } }
            }
          }
          excerpt: createEvidenceExcerpt(input: {
            evidenceItemId: "${evidenceItemId}"
            excerpt: "serial excerpt"
            checksum: "sha256:${"d".repeat(64)}"
          }) { evidenceExcerpt { id } }
          note: createNote(input: {
            subject: { factId: "${firstFactId}" }
            content: { plainText: "serial note" }
          }) { note { id version } }
          tag: tagFact(input: { factId: "${firstFactId}", tagId: "${tagId}" }) {
            factTag { id }
          }
          refresh: reviseFact(input: { id: "${firstFactId}", expectedVersion: 2, confidence: 0.8 }) {
            fact {
              version
              revisions(first: 10) { nodes { id revision } }
              relationships(first: 1) { nodes { id } }
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id plainText } }
              tags(first: 1) { nodes { id } }
            }
          }
          refreshedExcerpt: linkFactEvidence(input: {
            factId: "${firstFactId}"
            evidenceItemId: "${evidenceItemId}"
          }) {
            factEvidence {
              id
              evidenceItem { excerpts(first: 1) { nodes { id } } }
            }
          }
        }
      `,
    });
    expect(added.body?.errors).toBeUndefined();
    expect(added.body?.data?.prime?.fact).toMatchObject({
      version: 2,
      relationships: { nodes: [] },
      evidence: { nodes: [] },
      notes: { nodes: [] },
      tags: { nodes: [] },
    });
    expect(added.body?.data?.prime?.fact?.revisions.nodes).toHaveLength(2);
    expect(
      added.body?.data?.citation?.factEvidence?.evidenceItem?.excerpts.nodes,
    ).toEqual([]);
    expect(added.body?.data?.refresh?.fact).toMatchObject({
      version: 3,
      relationships: { nodes: [{ id: expect.any(String) }] },
      evidence: { nodes: [{ id: expect.any(String) }] },
      notes: { nodes: [{ id: expect.any(String), plainText: "serial note" }] },
      tags: { nodes: [{ id: tagId }] },
    });
    expect(added.body?.data?.refresh?.fact?.revisions.nodes).toHaveLength(3);
    expect(
      added.body?.data?.refreshedExcerpt?.factEvidence?.evidenceItem?.excerpts
        .nodes,
    ).toEqual([{ id: expect.any(String) }]);

    const factRelationshipId = required(
      added.body?.data?.relation?.factRelationship?.id,
    );
    const noteId = required(added.body?.data?.note?.note?.id);
    const removed = await fixture.execute<SerialMutationData>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation {
          prime: reviseFact(input: { id: "${firstFactId}", expectedVersion: 3, confidence: 0.7 }) {
            fact {
              version
              revisions(first: 10) { nodes { id revision } }
              relationships(first: 1) { nodes { id } }
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id plainText } }
              tags(first: 1) { nodes { id } }
            }
          }
          updateNote(input: {
            id: "${noteId}"
            expectedVersion: 1
            content: { plainText: "updated serial note" }
          }) { note { id version } }
          refreshedNote: reviseFact(input: { id: "${firstFactId}", expectedVersion: 4, confidence: 0.6 }) {
            fact { version notes(first: 1) { nodes { id plainText } } }
          }
          archiveRelation: archiveFactRelationship(input: {
            id: "${factRelationshipId}"
            expectedVersion: 1
          }) { factRelationship { id } }
          unlink: unlinkFactEvidence(input: {
            factId: "${firstFactId}"
            evidenceItemId: "${evidenceItemId}"
          }) { factEvidence { id } }
          archiveNote(input: { id: "${noteId}", expectedVersion: 2 }) {
            note { id version }
          }
          untag: untagFact(input: { factId: "${firstFactId}", tagId: "${tagId}" }) {
            factTag { id }
          }
          final: reviseFact(input: { id: "${firstFactId}", expectedVersion: 5, confidence: 0.5 }) {
            fact {
              version
              revisions(first: 10) { nodes { id revision } }
              relationships(first: 1) { nodes { id } }
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id plainText } }
              tags(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(removed.body?.errors).toBeUndefined();
    expect(removed.body?.data?.refreshedNote?.fact?.notes.nodes).toEqual([
      { id: noteId, plainText: "updated serial note" },
    ]);
    expect(removed.body?.data?.final?.fact).toMatchObject({
      version: 6,
      relationships: { nodes: [] },
      evidence: { nodes: [] },
      notes: { nodes: [] },
      tags: { nodes: [] },
    });
    expect(removed.body?.data?.final?.fact?.revisions.nodes).toHaveLength(6);

    const relationshipCache = await fixture.execute<SerialMutationData>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation {
          prime: updateRelationship(input: { id: "${relationshipId}", expectedVersion: 1, strength: 0.1 }) {
            relationship {
              version
              evidence(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
          link: linkRelationshipEvidence(input: {
            relationshipId: "${relationshipId}"
            evidenceItemId: "${evidenceItemId}"
          }) { relationshipEvidence { id } }
          tag: tagRelationship(input: { relationshipId: "${relationshipId}", tagId: "${tagId}" }) {
            relationshipTag { id }
          }
          added: updateRelationship(input: { id: "${relationshipId}", expectedVersion: 2, strength: 0.2 }) {
            relationship {
              version
              evidence(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
          unlink: unlinkRelationshipEvidence(input: {
            relationshipId: "${relationshipId}"
            evidenceItemId: "${evidenceItemId}"
          }) { relationshipEvidence { id } }
          untag: untagRelationship(input: { relationshipId: "${relationshipId}", tagId: "${tagId}" }) {
            relationshipTag { id }
          }
          final: updateRelationship(input: { id: "${relationshipId}", expectedVersion: 3, strength: 0.3 }) {
            relationship {
              version
              evidence(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(relationshipCache.body?.errors).toBeUndefined();
    expect(relationshipCache.body?.data?.prime?.relationship).toMatchObject({
      version: 2,
      evidence: { nodes: [] },
      tags: { nodes: [] },
    });
    expect(relationshipCache.body?.data?.added?.relationship).toMatchObject({
      version: 3,
      evidence: { nodes: [{ id: expect.any(String) }] },
      tags: { nodes: [{ id: tagId }] },
    });
    expect(relationshipCache.body?.data?.final?.relationship).toMatchObject({
      version: 4,
      evidence: { nodes: [] },
      tags: { nodes: [] },
    });
  });

  it("does not leak nested pages after a parent becomes hidden in the same request", async () => {
    const owner = await fixture.createActor();
    const contributor = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const peopleResponses = await Promise.all(
      ["Archive subject", "Lifecycle A", "Lifecycle B"].map((displayName) =>
        fixture.createPerson(owner, { displayName }),
      ),
    );
    const [archivedPersonId, personAId, personBId] = peopleResponses.map(
      (response) => required(response.body?.data?.createPerson?.person?.id),
    );
    const definitionId = newId();
    const relationshipTypeId = newId();
    const personRelationshipId = newId();
    const hiddenRelationshipId = newId();
    const archivedRelationshipId = newId();
    const personFactId = newId();
    const hiddenFactId = newId();
    const relatedFactId = newId();
    const sourceId = newId();
    const hiddenEvidenceId = newId();
    const citationEvidenceId = newId();
    const tagId = newId();
    const personNoteId = newId();
    const hiddenRelationshipNoteId = newId();
    const archivedRelationshipNoteId = newId();
    const factNoteId = newId();
    const evidenceNoteId = newId();

    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: owner.workspaceId,
      namespace: "person",
      fieldKey: "lifecycle-cache",
      label: "Lifecycle cache",
      allowedValueType: "text",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: owner.workspaceId,
      key: "lifecycle-cache",
      forwardLabel: "lifecycle cache",
      inverseLabel: "lifecycle cached by",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationships).values([
      {
        id: personRelationshipId,
        workspaceId: owner.workspaceId,
        sourcePersonId: archivedPersonId,
        targetPersonId: personAId,
        relationshipTypeId,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: hiddenRelationshipId,
        workspaceId: owner.workspaceId,
        sourcePersonId: personAId,
        targetPersonId: personBId,
        relationshipTypeId,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: archivedRelationshipId,
        workspaceId: owner.workspaceId,
        sourcePersonId: personBId,
        targetPersonId: personAId,
        relationshipTypeId,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(facts).values([
      {
        id: personFactId,
        workspaceId: owner.workspaceId,
        personId: archivedPersonId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "lifecycle-cache",
        label: "Archived person lifecycle fact",
        valueType: "text",
        valueText: "archived parent",
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: hiddenFactId,
        workspaceId: owner.workspaceId,
        personId: personAId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "lifecycle-cache",
        label: "Hidden lifecycle fact",
        valueType: "text",
        valueText: "hidden",
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: relatedFactId,
        workspaceId: owner.workspaceId,
        personId: personAId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "lifecycle-cache",
        label: "Related lifecycle fact",
        valueType: "text",
        valueText: "related",
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(factRevisions).values([
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        factId: personFactId,
        revision: 1,
        afterSnapshot: { valueText: "archived parent" },
        createdBy: owner.principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        factId: hiddenFactId,
        revision: 1,
        afterSnapshot: { valueText: "hidden" },
        createdBy: owner.principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        factId: relatedFactId,
        revision: 1,
        afterSnapshot: { valueText: "related" },
        createdBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(factRelationships).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      sourceFactId: hiddenFactId,
      targetFactId: relatedFactId,
      relationshipType: "supports",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: owner.workspaceId,
      kind: "archive",
      title: "Lifecycle cache source",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(evidenceItems).values([
      {
        id: hiddenEvidenceId,
        workspaceId: owner.workspaceId,
        sourceId,
        checksum: `sha256:${"8".repeat(64)}`,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: citationEvidenceId,
        workspaceId: owner.workspaceId,
        sourceId,
        checksum: `sha256:${"9".repeat(64)}`,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(evidenceExcerpts).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      evidenceItemId: hiddenEvidenceId,
      excerpt: "hidden evidence excerpt",
      checksum: `sha256:${"a".repeat(64)}`,
      createdBy: owner.principalId,
    });
    await fixture.database.insert(factEvidence).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      factId: hiddenFactId,
      evidenceItemId: citationEvidenceId,
      createdBy: owner.principalId,
    });
    await fixture.database.insert(relationshipEvidence).values([
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId: hiddenRelationshipId,
        evidenceItemId: citationEvidenceId,
        createdBy: owner.principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId: archivedRelationshipId,
        evidenceItemId: citationEvidenceId,
        createdBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(tags).values({
      id: tagId,
      workspaceId: owner.workspaceId,
      name: "Lifecycle cache",
      normalizedName: "lifecycle-cache",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(factTags).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      factId: hiddenFactId,
      tagId,
      createdBy: owner.principalId,
    });
    await fixture.database.insert(personTags).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      personId: archivedPersonId,
      tagId,
      createdBy: owner.principalId,
    });
    await fixture.database.insert(relationshipTags).values([
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId: hiddenRelationshipId,
        tagId,
        createdBy: owner.principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId: archivedRelationshipId,
        tagId,
        createdBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(notes).values([
      {
        id: personNoteId,
        workspaceId: owner.workspaceId,
        personId: archivedPersonId,
        plainText: "person lifecycle note",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: hiddenRelationshipNoteId,
        workspaceId: owner.workspaceId,
        relationshipId: hiddenRelationshipId,
        plainText: "hidden relationship lifecycle note",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: archivedRelationshipNoteId,
        workspaceId: owner.workspaceId,
        relationshipId: archivedRelationshipId,
        plainText: "archived relationship lifecycle note",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: factNoteId,
        workspaceId: owner.workspaceId,
        factId: hiddenFactId,
        plainText: "fact lifecycle note",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: evidenceNoteId,
        workspaceId: owner.workspaceId,
        evidenceItemId: hiddenEvidenceId,
        plainText: "evidence lifecycle note",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);

    type NestedPage = { nodes: Array<{ id: string }> };
    type ParentSnapshot = {
      status?: string;
      sensitivity?: string;
      version: number;
      facts?: NestedPage;
      revisions?: NestedPage;
      relationships?: NestedPage;
      evidence?: NestedPage;
      excerpts?: NestedPage;
      notes: NestedPage;
      tags?: NestedPage;
    };
    type LifecycleMutationData = Record<
      string,
      | null
      | { person: ParentSnapshot | null }
      | { relationship: ParentSnapshot | null }
      | { fact: ParentSnapshot | null }
      | { evidenceItem: ParentSnapshot | null }
    >;

    const personArchive = await fixture.execute<LifecycleMutationData>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation {
          prime: updatePerson(input: {
            id: "${archivedPersonId}"
            expectedVersion: 1
            biography: "prime archive cache"
          }) {
            person {
              version
              facts(first: 1) { nodes { id } }
              relationships(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
          archive: archivePerson(input: {
            id: "${archivedPersonId}"
            expectedVersion: 2
          }) {
            person {
              status version
              facts(first: 1) { nodes { id } }
              relationships(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(personArchive.body?.errors).toBeUndefined();
    expect(personArchive.body?.data?.prime).toMatchObject({
      person: {
        version: 2,
        facts: { nodes: [{ id: personFactId }] },
        relationships: { nodes: [{ id: personRelationshipId }] },
        notes: { nodes: [{ id: personNoteId }] },
        tags: { nodes: [{ id: tagId }] },
      },
    });
    expect.soft(personArchive.body?.data?.archive).toMatchObject({
      person: {
        status: "ARCHIVED",
        version: 3,
        facts: { nodes: [] },
        relationships: { nodes: [] },
        notes: { nodes: [] },
        tags: { nodes: [] },
      },
    });

    const relationshipUpdate = await fixture.execute<LifecycleMutationData>({
      jar: contributor.jar,
      query: /* GraphQL */ `
        mutation {
          prime: updateRelationship(input: {
            id: "${hiddenRelationshipId}"
            expectedVersion: 1
            strength: 0.4
          }) {
            relationship {
              version
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
          hide: updateRelationship(input: {
            id: "${hiddenRelationshipId}"
            expectedVersion: 2
            sensitivity: CONFIDENTIAL
          }) {
            relationship {
              version sensitivity
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(relationshipUpdate.body?.errors).toBeUndefined();
    expect(relationshipUpdate.body?.data?.prime).toMatchObject({
      relationship: {
        version: 2,
        evidence: { nodes: [{ id: expect.any(String) }] },
        notes: { nodes: [{ id: hiddenRelationshipNoteId }] },
        tags: { nodes: [{ id: tagId }] },
      },
    });
    expect.soft(relationshipUpdate.body?.data?.hide).toMatchObject({
      relationship: {
        version: 3,
        sensitivity: "CONFIDENTIAL",
        evidence: { nodes: [] },
        notes: { nodes: [] },
        tags: { nodes: [] },
      },
    });

    const relationshipArchive = await fixture.execute<LifecycleMutationData>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation {
          prime: updateRelationship(input: {
            id: "${archivedRelationshipId}"
            expectedVersion: 1
            strength: 0.5
          }) {
            relationship {
              version
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
          archive: archiveRelationship(input: {
            id: "${archivedRelationshipId}"
            expectedVersion: 2
          }) {
            relationship {
              version
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(relationshipArchive.body?.errors).toBeUndefined();
    expect(relationshipArchive.body?.data?.prime).toMatchObject({
      relationship: {
        version: 2,
        evidence: { nodes: [{ id: expect.any(String) }] },
        notes: { nodes: [{ id: archivedRelationshipNoteId }] },
        tags: { nodes: [{ id: tagId }] },
      },
    });
    expect.soft(relationshipArchive.body?.data?.archive).toMatchObject({
      relationship: {
        version: 3,
        evidence: { nodes: [] },
        notes: { nodes: [] },
        tags: { nodes: [] },
      },
    });

    const factUpdate = await fixture.execute<LifecycleMutationData>({
      jar: contributor.jar,
      query: /* GraphQL */ `
        mutation {
          prime: reviseFact(input: {
            id: "${hiddenFactId}"
            expectedVersion: 1
            confidence: 0.8
          }) {
            fact {
              version
              revisions(first: 10) { nodes { id } }
              relationships(first: 1) { nodes { id } }
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
          hide: reviseFact(input: {
            id: "${hiddenFactId}"
            expectedVersion: 2
            sensitivity: CONFIDENTIAL
          }) {
            fact {
              version sensitivity
              revisions(first: 10) { nodes { id } }
              relationships(first: 1) { nodes { id } }
              evidence(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
              tags(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(factUpdate.body?.errors).toBeUndefined();
    expect(factUpdate.body?.data?.prime).toMatchObject({
      fact: {
        version: 2,
        relationships: { nodes: [{ id: expect.any(String) }] },
        evidence: { nodes: [{ id: expect.any(String) }] },
        notes: { nodes: [{ id: factNoteId }] },
        tags: { nodes: [{ id: tagId }] },
      },
    });
    expect.soft(factUpdate.body?.data?.hide).toMatchObject({
      fact: {
        version: 3,
        sensitivity: "CONFIDENTIAL",
        revisions: { nodes: [] },
        relationships: { nodes: [] },
        evidence: { nodes: [] },
        notes: { nodes: [] },
        tags: { nodes: [] },
      },
    });

    const evidenceUpdate = await fixture.execute<LifecycleMutationData>({
      jar: contributor.jar,
      query: /* GraphQL */ `
        mutation {
          prime: updateEvidenceItem(input: {
            id: "${hiddenEvidenceId}"
            expectedVersion: 1
            externalLocator: "https://example.test/prime"
          }) {
            evidenceItem {
              version
              excerpts(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
            }
          }
          hide: updateEvidenceItem(input: {
            id: "${hiddenEvidenceId}"
            expectedVersion: 2
            sensitivity: CONFIDENTIAL
          }) {
            evidenceItem {
              version sensitivity
              excerpts(first: 1) { nodes { id } }
              notes(first: 1) { nodes { id } }
            }
          }
        }
      `,
    });
    expect(evidenceUpdate.body?.errors).toBeUndefined();
    expect(evidenceUpdate.body?.data?.prime).toMatchObject({
      evidenceItem: {
        version: 2,
        excerpts: { nodes: [{ id: expect.any(String) }] },
        notes: { nodes: [{ id: evidenceNoteId }] },
      },
    });
    expect.soft(evidenceUpdate.body?.data?.hide).toMatchObject({
      evidenceItem: {
        version: 3,
        sensitivity: "CONFIDENTIAL",
        excerpts: { nodes: [] },
        notes: { nodes: [] },
      },
    });

    const fresh = await fixture.execute<{
      person: { id: string } | null;
      personNote: { id: string } | null;
      hiddenRelationship: { id: string } | null;
      hiddenRelationshipNote: { id: string } | null;
      archivedRelationship: { id: string } | null;
      archivedRelationshipNote: { id: string } | null;
      hiddenFact: { id: string } | null;
      factNote: { id: string } | null;
      hiddenEvidence: { id: string } | null;
      evidenceNote: { id: string } | null;
    }>({
      jar: contributor.jar,
      query: /* GraphQL */ `
        query {
          person: person(id: "${archivedPersonId}") { id }
          personNote: note(id: "${personNoteId}") { id }
          hiddenRelationship: relationship(id: "${hiddenRelationshipId}") { id }
          hiddenRelationshipNote: note(id: "${hiddenRelationshipNoteId}") { id }
          archivedRelationship: relationship(id: "${archivedRelationshipId}") { id }
          archivedRelationshipNote: note(id: "${archivedRelationshipNoteId}") { id }
          hiddenFact: fact(id: "${hiddenFactId}") { id }
          factNote: note(id: "${factNoteId}") { id }
          hiddenEvidence: evidenceItem(id: "${hiddenEvidenceId}") { id }
          evidenceNote: note(id: "${evidenceNoteId}") { id }
        }
      `,
    });
    expect(fresh.body?.errors).toBeUndefined();
    expect(fresh.body?.data).toEqual({
      person: null,
      personNote: null,
      hiddenRelationship: null,
      hiddenRelationshipNote: null,
      archivedRelationship: null,
      archivedRelationshipNote: null,
      hiddenFact: null,
      factNote: null,
      hiddenEvidence: null,
      evidenceNote: null,
    });
  });

  it("paginates after sensitivity filtering and does not starve grouped parents", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const personA = await fixture.createPerson(owner, {
      displayName: "Pagination A",
    });
    const personB = await fixture.createPerson(owner, {
      displayName: "Pagination B",
    });
    const personC = await fixture.createPerson(owner, {
      displayName: "Pagination C",
    });
    const personAId = required(personA.body?.data?.createPerson?.person?.id);
    const personBId = required(personB.body?.data?.createPerson?.person?.id);
    const personCId = required(personC.body?.data?.createPerson?.person?.id);
    const definitionId = newId();
    const relationshipTypeId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: owner.workspaceId,
      namespace: "person",
      fieldKey: "pagination",
      label: "Pagination",
      allowedValueType: "text",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: owner.workspaceId,
      key: "pagination",
      forwardLabel: "paginates",
      inverseLabel: "paginated by",
      allowsSelf: false,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const base = Date.UTC(2026, 6, 31, 12, 0, 0);
    const moments = Array.from(
      { length: 20 },
      (_, index) => new Date(base + index * 1_000),
    );
    const visiblePattern = [
      "internal",
      "internal",
      "confidential",
      "internal",
      "confidential",
    ] as const;
    const factIds = Array.from({ length: 5 }, () => newId());
    const sourceIds = Array.from({ length: 5 }, () => newId());
    const evidenceIds = Array.from({ length: 5 }, () => newId());
    const relationshipIds = Array.from({ length: 5 }, () => newId());
    const noteIds = Array.from({ length: 5 }, () => newId());
    await fixture.database.insert(facts).values(
      factIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        personId: personAId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "pagination",
        label: `Fact ${index}`,
        valueType: "text" as const,
        valueText: `fact-${index}`,
        sensitivity: visiblePattern[index]!,
        assertedAt: moments[index],
        createdAt: moments[index],
        updatedAt: moments[index],
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(sources).values(
      sourceIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        kind: "archive",
        title: `Source ${index}`,
        sensitivity: visiblePattern[index]!,
        createdAt: moments[index],
        updatedAt: moments[index],
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    const evidenceSourceId = newId();
    await fixture.database.insert(sources).values({
      id: evidenceSourceId,
      workspaceId: owner.workspaceId,
      kind: "archive",
      title: "Evidence page source",
      sensitivity: "confidential",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(evidenceItems).values(
      evidenceIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        sourceId: evidenceSourceId,
        checksum: `sha256:${String(index + 3).repeat(64)}`,
        sensitivity: visiblePattern[index]!,
        createdAt: moments[index],
        updatedAt: moments[index],
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(relationships).values(
      relationshipIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        sourcePersonId: personAId,
        targetPersonId: personCId,
        relationshipTypeId,
        sensitivity: visiblePattern[index]!,
        createdAt: moments[index],
        updatedAt: moments[index],
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(notes).values(
      noteIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        plainText: `note-${index}`,
        sensitivity: visiblePattern[index]!,
        createdAt: moments[index],
        updatedAt: moments[index],
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    const hiddenPrefix = Array.from({ length: 120 }, (_, index) => ({
      id: newId(),
      at: new Date(base + 100_000 + index * 1_000),
      index,
    }));
    await fixture.database.insert(facts).values(
      hiddenPrefix.map(({ id, at, index }) => ({
        id,
        workspaceId: owner.workspaceId,
        personId: personAId,
        factDefinitionId: definitionId,
        namespace: "person",
        fieldKey: "pagination",
        label: `Hidden fact ${index}`,
        valueType: "text" as const,
        valueText: `hidden-fact-${index}`,
        sensitivity: "confidential" as const,
        assertedAt: at,
        createdAt: at,
        updatedAt: at,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(sources).values(
      hiddenPrefix.map(({ id, at, index }) => ({
        id,
        workspaceId: owner.workspaceId,
        kind: "archive",
        title: `Hidden source ${index}`,
        sensitivity: "confidential" as const,
        createdAt: at,
        updatedAt: at,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(evidenceItems).values(
      hiddenPrefix.map(({ id, at, index }) => ({
        id,
        workspaceId: owner.workspaceId,
        sourceId: evidenceSourceId,
        checksum: `sha256:${index.toString(16).padStart(64, "0")}`,
        sensitivity: "confidential" as const,
        createdAt: at,
        updatedAt: at,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(relationships).values(
      hiddenPrefix.map(({ id, at }) => ({
        id,
        workspaceId: owner.workspaceId,
        sourcePersonId: personAId,
        targetPersonId: personCId,
        relationshipTypeId,
        sensitivity: "confidential" as const,
        createdAt: at,
        updatedAt: at,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(notes).values(
      hiddenPrefix.map(({ id, at, index }) => ({
        id,
        workspaceId: owner.workspaceId,
        plainText: `hidden-note-${index}`,
        sensitivity: "confidential" as const,
        createdAt: at,
        updatedAt: at,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    const pageQuery = /* GraphQL */ `
      query (
        $afterFact: String
        $afterSource: String
        $afterEvidence: String
        $afterRelationship: String
        $afterNote: String
      ) {
        facts(first: 2, after: $afterFact) {
          nodes {
            id
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
        sources(first: 2, after: $afterSource) {
          nodes {
            id
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
        evidenceItems(first: 2, after: $afterEvidence) {
          nodes {
            id
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
        relationships(first: 2, after: $afterRelationship) {
          nodes {
            id
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
        notes(first: 2, after: $afterNote) {
          nodes {
            id
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    `;
    fixture.queryCount = 0;
    const firstPage = await fixture.execute<{
      facts: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
      sources: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
      evidenceItems: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
      relationships: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
      notes: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
    }>({ jar: viewer.jar, query: pageQuery });
    expect(firstPage.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(20);
    for (const [name, ids] of [
      ["facts", factIds],
      ["sources", sourceIds],
      ["evidenceItems", evidenceIds],
      ["relationships", relationshipIds],
      ["notes", noteIds],
    ] as const) {
      const page = firstPage.body?.data?.[name];
      expect(
        page?.nodes.map((row) => row.id),
        name,
      ).toEqual([ids[3], ids[1]]);
      expect(page?.pageInfo.hasNextPage, name).toBe(true);
      expect(page?.pageInfo.endCursor, name).toEqual(expect.any(String));
    }
    const secondPage = await fixture.execute({
      jar: viewer.jar,
      query: pageQuery,
      variables: {
        afterFact: firstPage.body?.data?.facts.pageInfo.endCursor,
        afterSource: firstPage.body?.data?.sources.pageInfo.endCursor,
        afterEvidence: firstPage.body?.data?.evidenceItems.pageInfo.endCursor,
        afterRelationship:
          firstPage.body?.data?.relationships.pageInfo.endCursor,
        afterNote: firstPage.body?.data?.notes.pageInfo.endCursor,
      },
    });
    expect(secondPage.body?.errors).toBeUndefined();
    for (const [name, id] of [
      ["facts", factIds[0]],
      ["sources", sourceIds[0]],
      ["evidenceItems", evidenceIds[0]],
      ["relationships", relationshipIds[0]],
      ["notes", noteIds[0]],
    ] as const) {
      expect(
        (
          secondPage.body?.data?.[name] as {
            nodes: Array<{ id: string }>;
            pageInfo: { hasNextPage: boolean };
          }
        ).nodes,
      ).toEqual([{ id }]);
      expect(
        (
          secondPage.body?.data?.[name] as {
            pageInfo: { hasNextPage: boolean };
          }
        ).pageInfo.hasNextPage,
      ).toBe(false);
    }

    const citationPolicyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: citationPolicyId,
      workspaceId: owner.workspaceId,
      name: "Pagination citation source",
      sensitivityCeiling: "confidential",
      resourceKinds: ["source"],
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      policyId: citationPolicyId,
      memberId: viewer.memberId,
      resourceId: evidenceSourceId,
      resourceKind: "source",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const citationIds = Array.from({ length: 5 }, () => newId());
    await fixture.database.insert(factEvidence).values(
      citationIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        factId: factIds[0]!,
        evidenceItemId: evidenceIds[index]!,
        createdAt: moments[index],
        createdBy: owner.principalId,
      })),
    );
    await fixture.database.insert(factEvidence).values(
      hiddenPrefix.map(({ id: evidenceItemId, at }) => ({
        id: newId(),
        workspaceId: owner.workspaceId,
        factId: factIds[0]!,
        evidenceItemId,
        createdAt: at,
        createdBy: owner.principalId,
      })),
    );
    const citationQuery = /* GraphQL */ `
      query ($after: String) {
        fact(id: "${factIds[0]}") {
          evidence(first: 2, after: $after) {
            nodes { id }
            pageInfo { endCursor hasNextPage }
          }
        }
      }
    `;
    fixture.queryCount = 0;
    const firstCitations = await fixture.execute<{
      fact: {
        evidence: {
          nodes: Array<{ id: string }>;
          pageInfo: { endCursor: string; hasNextPage: boolean };
        };
      } | null;
    }>({ jar: viewer.jar, query: citationQuery });
    expect(firstCitations.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(12);
    expect(firstCitations.body?.data?.fact?.evidence.nodes).toEqual([
      { id: citationIds[3] },
      { id: citationIds[1] },
    ]);
    expect(firstCitations.body?.data?.fact?.evidence.pageInfo.hasNextPage).toBe(
      true,
    );
    const secondCitations = await fixture.execute<{
      fact: {
        evidence: {
          nodes: Array<{ id: string }>;
          pageInfo: { endCursor: string; hasNextPage: boolean };
        };
      } | null;
    }>({
      jar: viewer.jar,
      query: citationQuery,
      variables: {
        after: firstCitations.body?.data?.fact?.evidence.pageInfo.endCursor,
      },
    });
    expect(secondCitations.body?.errors).toBeUndefined();
    expect(secondCitations.body?.data?.fact?.evidence).toEqual({
      nodes: [{ id: citationIds[0] }],
      pageInfo: { endCursor: expect.any(String), hasNextPage: false },
    });

    const aRelationships = Array.from({ length: 14 }, (_, index) => ({
      id: newId(),
      workspaceId: owner.workspaceId,
      sourcePersonId: personAId,
      targetPersonId: personCId,
      relationshipTypeId,
      createdAt: new Date(base + 30_000 + index * 1_000),
      updatedAt: new Date(base + 30_000 + index * 1_000),
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    }));
    const bRelationships = Array.from({ length: 3 }, (_, index) => ({
      id: newId(),
      workspaceId: owner.workspaceId,
      sourcePersonId: personBId,
      targetPersonId: personCId,
      relationshipTypeId,
      createdAt: new Date(base + 21_000 + index * 1_000),
      updatedAt: new Date(base + 21_000 + index * 1_000),
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    }));
    await fixture.database
      .insert(relationships)
      .values([...aRelationships, ...bRelationships]);
    const bFacts = Array.from({ length: 3 }, (_, index) => ({
      id: newId(),
      workspaceId: owner.workspaceId,
      personId: personBId,
      factDefinitionId: definitionId,
      namespace: "person",
      fieldKey: "pagination",
      label: `B fact ${index}`,
      valueType: "text" as const,
      valueText: `b-fact-${index}`,
      createdAt: new Date(base + 40_000 + index * 1_000),
      updatedAt: new Date(base + 40_000 + index * 1_000),
      assertedAt: new Date(base + 40_000 + index * 1_000),
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    }));
    const cFacts = Array.from({ length: 3 }, (_, index) => ({
      id: newId(),
      workspaceId: owner.workspaceId,
      personId: personCId,
      factDefinitionId: definitionId,
      namespace: "person",
      fieldKey: "pagination",
      label: `C fact ${index}`,
      valueType: "text" as const,
      valueText: `c-fact-${index}`,
      createdAt: new Date(base + 50_000 + index * 1_000),
      updatedAt: new Date(base + 50_000 + index * 1_000),
      assertedAt: new Date(base + 50_000 + index * 1_000),
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    }));
    await fixture.database.insert(facts).values([...bFacts, ...cFacts]);
    fixture.queryCount = 0;
    const grouped = await fixture.execute<{
      a: {
        facts: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean };
        };
        relationships: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
      b: {
        facts: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean };
        };
        relationships: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    }>({
      jar: viewer.jar,
      query: /* GraphQL */ `
        query ($a: UUID!, $b: UUID!) {
          a: person(id: $a) {
            facts(first: 2) {
              nodes {
                id
              }
              pageInfo {
                hasNextPage
              }
            }
            relationships(first: 2) {
              nodes {
                id
              }
              pageInfo {
                hasNextPage
              }
            }
          }
          b: person(id: $b) {
            facts(first: 2) {
              nodes {
                id
              }
              pageInfo {
                hasNextPage
              }
            }
            relationships(first: 2) {
              nodes {
                id
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      `,
      variables: { a: personAId, b: personBId },
    });
    expect(grouped.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(12);
    expect(grouped.body?.data?.a.relationships.nodes).toHaveLength(2);
    expect(grouped.body?.data?.a.relationships.pageInfo.hasNextPage).toBe(true);
    expect(grouped.body?.data?.b.relationships.nodes).toHaveLength(2);
    expect(grouped.body?.data?.b.relationships.pageInfo.hasNextPage).toBe(true);
    expect(grouped.body?.data?.a.facts.nodes).toHaveLength(2);
    expect(grouped.body?.data?.a.facts.pageInfo.hasNextPage).toBe(true);
    expect(grouped.body?.data?.b.facts.nodes).toHaveLength(2);
    expect(grouped.body?.data?.b.facts.pageInfo.hasNextPage).toBe(true);

    const nestedFactIds = [factIds[0]!, bFacts[0]!.id, bFacts[1]!.id];
    const nestedRelationshipIds = [
      relationshipIds[0]!,
      bRelationships[0]!.id,
      bRelationships[1]!.id,
    ];
    const nestedEvidenceIds = [
      evidenceIds[0]!,
      evidenceIds[1]!,
      evidenceIds[3]!,
    ];
    const nestedPersonIds = [personAId, personBId, personCId];
    await fixture.database.insert(factRevisions).values(
      nestedFactIds.flatMap((factId, parentIndex) =>
        [1, 2].map((revision) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          factId,
          revision,
          beforeSnapshot:
            revision === 1 ? null : { personId: nestedPersonIds[parentIndex] },
          afterSnapshot: {
            personId: nestedPersonIds[parentIndex],
            valueText: `revision-${revision}`,
          },
          createdAt: new Date(base + 200_000 + revision * 1_000),
          createdBy: owner.principalId,
        })),
      ),
    );
    await fixture.database.insert(factRelationships).values(
      nestedFactIds.map((sourceFactId, index) => ({
        id: newId(),
        workspaceId: owner.workspaceId,
        sourceFactId,
        targetFactId: nestedFactIds[(index + 1) % nestedFactIds.length]!,
        relationshipType: "supports" as const,
        createdAt: new Date(base + 210_000 + index * 1_000),
        updatedAt: new Date(base + 210_000 + index * 1_000),
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(factEvidence).values(
      nestedFactIds.slice(1).flatMap((factId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          factId,
          evidenceItemId:
            nestedEvidenceIds[(index + offset + 1) % nestedEvidenceIds.length]!,
          createdAt: new Date(base + 220_000 + index * 10_000 + offset * 1_000),
          createdBy: owner.principalId,
        })),
      ),
    );
    await fixture.database.insert(relationshipEvidence).values(
      nestedRelationshipIds.flatMap((relationshipId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          relationshipId,
          evidenceItemId:
            nestedEvidenceIds[(index + offset) % nestedEvidenceIds.length]!,
          createdAt: new Date(base + 230_000 + index * 10_000 + offset * 1_000),
          createdBy: owner.principalId,
        })),
      ),
    );
    await fixture.database.insert(evidenceExcerpts).values(
      nestedEvidenceIds.flatMap((evidenceItemId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          evidenceItemId,
          excerpt: `nested excerpt ${index}-${offset}`,
          checksum: `sha256:${(index * 2 + offset + 7).toString(16).padStart(64, "0")}`,
          createdAt: new Date(base + 240_000 + index * 10_000 + offset * 1_000),
          createdBy: owner.principalId,
        })),
      ),
    );
    await fixture.database.insert(notes).values([
      ...nestedPersonIds.flatMap((personId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          personId,
          plainText: `person note ${index}-${offset}`,
          createdBy: owner.principalId,
          updatedBy: owner.principalId,
        })),
      ),
      ...nestedFactIds.flatMap((factId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          factId,
          plainText: `fact note ${index}-${offset}`,
          createdBy: owner.principalId,
          updatedBy: owner.principalId,
        })),
      ),
      ...nestedRelationshipIds.flatMap((relationshipId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          relationshipId,
          plainText: `relationship note ${index}-${offset}`,
          createdBy: owner.principalId,
          updatedBy: owner.principalId,
        })),
      ),
      ...nestedEvidenceIds.flatMap((evidenceItemId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          evidenceItemId,
          plainText: `evidence note ${index}-${offset}`,
          createdBy: owner.principalId,
          updatedBy: owner.principalId,
        })),
      ),
    ]);
    const nestedTagIds = Array.from({ length: 3 }, () => newId());
    await fixture.database.insert(tags).values(
      nestedTagIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        name: `Nested ${index}`,
        normalizedName: `nested-${index}`,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(personTags).values(
      nestedPersonIds.flatMap((personId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          personId,
          tagId: nestedTagIds[(index + offset) % nestedTagIds.length]!,
          createdBy: owner.principalId,
        })),
      ),
    );
    await fixture.database.insert(factTags).values(
      nestedFactIds.flatMap((factId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          factId,
          tagId: nestedTagIds[(index + offset) % nestedTagIds.length]!,
          createdBy: owner.principalId,
        })),
      ),
    );
    await fixture.database.insert(relationshipTags).values(
      nestedRelationshipIds.flatMap((relationshipId, index) =>
        [0, 1].map((offset) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          relationshipId,
          tagId: nestedTagIds[(index + offset) % nestedTagIds.length]!,
          createdBy: owner.principalId,
        })),
      ),
    );

    type NestedConnection = {
      nodes: Array<{ id: string; createdBy?: { kind: string } }>;
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    };
    type NestedResult = {
      [key: string]: null | {
        revisions?: NestedConnection;
        relationships?: NestedConnection;
        evidence?: NestedConnection;
        notes?: NestedConnection;
        tags?: NestedConnection;
        firstAgain?: NestedConnection;
        excerpts?: NestedConnection;
        facts?: NestedConnection;
      };
    };
    fixture.queryCount = 0;
    const nestedFacts = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedFactIds
            .map(
              (id, index) => `f${index}: fact(id: "${id}") {
            revisions(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            relationships(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            evidence(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            notes(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            tags(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
          }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(nestedFacts.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(18);

    fixture.queryCount = 0;
    const nestedRelationships = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedRelationshipIds
            .map(
              (id, index) => `r${index}: relationship(id: "${id}") {
            evidence(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            notes(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            tags(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
          }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(nestedRelationships.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(14);

    fixture.queryCount = 0;
    const nestedEvidence = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedEvidenceIds
            .map(
              (id, index) => `e${index}: evidenceItem(id: "${id}") {
            excerpts(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            notes(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
          }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(nestedEvidence.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(12);

    fixture.queryCount = 0;
    const nestedPeople = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedPersonIds
            .map(
              (id, index) => `p${index}: person(id: "${id}") {
            facts(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            relationships(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            notes(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
            tags(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }
          }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(nestedPeople.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(14);
    for (let index = 0; index < 3; index += 1) {
      expect(
        nestedFacts.body?.data?.[`f${index}`]?.revisions?.nodes,
      ).toHaveLength(1);
      expect(
        nestedFacts.body?.data?.[`f${index}`]?.revisions?.pageInfo.hasNextPage,
      ).toBe(true);
      expect(
        nestedFacts.body?.data?.[`f${index}`]?.relationships?.nodes,
      ).toHaveLength(1);
      expect(
        nestedFacts.body?.data?.[`f${index}`]?.evidence?.nodes.length,
      ).toBeGreaterThan(0);
      expect(nestedFacts.body?.data?.[`f${index}`]?.notes?.nodes).toHaveLength(
        1,
      );
      expect(nestedFacts.body?.data?.[`f${index}`]?.tags?.nodes).toHaveLength(
        1,
      );
      expect(
        nestedRelationships.body?.data?.[`r${index}`]?.evidence?.nodes,
      ).toHaveLength(1);
      expect(
        nestedRelationships.body?.data?.[`r${index}`]?.notes?.nodes,
      ).toHaveLength(1);
      expect(
        nestedRelationships.body?.data?.[`r${index}`]?.tags?.nodes,
      ).toHaveLength(1);
      expect(
        nestedEvidence.body?.data?.[`e${index}`]?.excerpts?.nodes,
      ).toHaveLength(1);
      expect(
        nestedEvidence.body?.data?.[`e${index}`]?.notes?.nodes,
      ).toHaveLength(1);
      expect(nestedPeople.body?.data?.[`p${index}`]?.notes?.nodes).toHaveLength(
        1,
      );
      expect(nestedPeople.body?.data?.[`p${index}`]?.tags?.nodes).toHaveLength(
        1,
      );
      for (const connection of [
        nestedFacts.body?.data?.[`f${index}`]?.revisions,
        nestedFacts.body?.data?.[`f${index}`]?.relationships,
        nestedFacts.body?.data?.[`f${index}`]?.evidence,
        nestedFacts.body?.data?.[`f${index}`]?.notes,
        nestedFacts.body?.data?.[`f${index}`]?.tags,
        nestedRelationships.body?.data?.[`r${index}`]?.evidence,
        nestedRelationships.body?.data?.[`r${index}`]?.notes,
        nestedRelationships.body?.data?.[`r${index}`]?.tags,
        nestedEvidence.body?.data?.[`e${index}`]?.excerpts,
        nestedEvidence.body?.data?.[`e${index}`]?.notes,
        nestedPeople.body?.data?.[`p${index}`]?.facts,
        nestedPeople.body?.data?.[`p${index}`]?.relationships,
        nestedPeople.body?.data?.[`p${index}`]?.notes,
        nestedPeople.body?.data?.[`p${index}`]?.tags,
      ]) {
        expect(connection?.pageInfo).toEqual({
          endCursor: expect.any(String),
          hasNextPage: true,
        });
      }
    }

    const cursorFor = (
      data: NestedResult | null | undefined,
      root: string,
      field: string,
    ) =>
      required(
        (data?.[root] as Record<string, NestedConnection> | null | undefined)?.[
          field
        ]?.pageInfo.endCursor,
      );

    const secondNestedFacts: Record<string, NestedResult | null | undefined> =
      {};
    for (const field of [
      "revisions",
      "relationships",
      "evidence",
      "notes",
      "tags",
    ] as const) {
      fixture.queryCount = 0;
      const response = await fixture.execute<NestedResult>({
        jar: owner.jar,
        query: /* GraphQL */ `
          query {
            ${nestedFactIds
              .map(
                (id, index) => `f${index}: fact(id: "${id}") {
                  ${field}(first: 1, after: "${cursorFor(nestedFacts.body?.data, `f${index}`, field)}") { nodes { id } pageInfo { endCursor hasNextPage } }
                  ${index === 0 && (field === "revisions" || field === "tags") ? `firstAgain: ${field}(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } }` : ""}
                }`,
              )
              .join("\n")}
          }
        `,
      });
      expect(response.body?.errors).toBeUndefined();
      expect(fixture.queryCount).toBeLessThanOrEqual(9);
      secondNestedFacts[field] = response.body?.data;
    }

    fixture.queryCount = 0;
    const secondNestedRelationships = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedRelationshipIds
            .map(
              (id, index) => `r${index}: relationship(id: "${id}") {
                evidence(first: 1, after: "${cursorFor(nestedRelationships.body?.data, `r${index}`, "evidence")}") { nodes { id } pageInfo { endCursor hasNextPage } }
                notes(first: 1, after: "${cursorFor(nestedRelationships.body?.data, `r${index}`, "notes")}") { nodes { id } pageInfo { endCursor hasNextPage } }
                tags(first: 1, after: "${cursorFor(nestedRelationships.body?.data, `r${index}`, "tags")}") { nodes { id } pageInfo { endCursor hasNextPage } }
              }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(secondNestedRelationships.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(14);

    fixture.queryCount = 0;
    const secondNestedEvidence = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedEvidenceIds
            .map(
              (id, index) => `e${index}: evidenceItem(id: "${id}") {
                excerpts(first: 1, after: "${cursorFor(nestedEvidence.body?.data, `e${index}`, "excerpts")}") { nodes { id } pageInfo { endCursor hasNextPage } }
                notes(first: 1, after: "${cursorFor(nestedEvidence.body?.data, `e${index}`, "notes")}") { nodes { id } pageInfo { endCursor hasNextPage } }
              }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(secondNestedEvidence.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(12);

    fixture.queryCount = 0;
    const secondNestedPeople = await fixture.execute<NestedResult>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          ${nestedPersonIds
            .map(
              (id, index) => `p${index}: person(id: "${id}") {
                facts(first: 1, after: "${cursorFor(nestedPeople.body?.data, `p${index}`, "facts")}") { nodes { id } pageInfo { endCursor hasNextPage } }
                relationships(first: 1, after: "${cursorFor(nestedPeople.body?.data, `p${index}`, "relationships")}") { nodes { id } pageInfo { endCursor hasNextPage } }
                notes(first: 1, after: "${cursorFor(nestedPeople.body?.data, `p${index}`, "notes")}") { nodes { id } pageInfo { endCursor hasNextPage } }
                tags(first: 1, after: "${cursorFor(nestedPeople.body?.data, `p${index}`, "tags")}") { nodes { id } pageInfo { endCursor hasNextPage } }
              }`,
            )
            .join("\n")}
        }
      `,
    });
    expect(secondNestedPeople.body?.errors).toBeUndefined();
    expect(fixture.queryCount).toBeLessThanOrEqual(14);

    for (let index = 0; index < 3; index += 1) {
      for (const connection of [
        secondNestedFacts.revisions?.[`f${index}`]?.revisions,
        secondNestedFacts.relationships?.[`f${index}`]?.relationships,
        secondNestedFacts.evidence?.[`f${index}`]?.evidence,
        secondNestedFacts.notes?.[`f${index}`]?.notes,
        secondNestedFacts.tags?.[`f${index}`]?.tags,
        secondNestedRelationships.body?.data?.[`r${index}`]?.evidence,
        secondNestedRelationships.body?.data?.[`r${index}`]?.notes,
        secondNestedRelationships.body?.data?.[`r${index}`]?.tags,
        secondNestedEvidence.body?.data?.[`e${index}`]?.excerpts,
        secondNestedEvidence.body?.data?.[`e${index}`]?.notes,
        secondNestedPeople.body?.data?.[`p${index}`]?.facts,
        secondNestedPeople.body?.data?.[`p${index}`]?.relationships,
        secondNestedPeople.body?.data?.[`p${index}`]?.notes,
        secondNestedPeople.body?.data?.[`p${index}`]?.tags,
      ])
        expect(connection?.nodes).toHaveLength(1);
    }
    expect(secondNestedFacts.revisions?.f0?.firstAgain?.nodes[0]?.id).toBe(
      nestedFacts.body?.data?.f0?.revisions?.nodes[0]?.id,
    );
    expect(secondNestedFacts.revisions?.f0?.revisions?.nodes[0]?.id).not.toBe(
      nestedFacts.body?.data?.f0?.revisions?.nodes[0]?.id,
    );
    expect(secondNestedFacts.tags?.f0?.firstAgain?.nodes[0]?.id).toBe(
      nestedFacts.body?.data?.f0?.tags?.nodes[0]?.id,
    );
    expect(secondNestedFacts.tags?.f0?.tags?.nodes[0]?.id).not.toBe(
      nestedFacts.body?.data?.f0?.tags?.nodes[0]?.id,
    );
  });
});
