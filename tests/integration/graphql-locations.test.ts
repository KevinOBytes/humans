// @vitest-environment node

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { apiKeys, sessions } from "@/db/schema/auth";
import {
  evidenceItems,
  personAddresses,
  personContactPoints,
  sources,
} from "@/db/schema/evidence";
import {
  addresses,
  contactPoints,
  locationMutationIdempotency,
} from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";

import { expectGraphQLError, type OperationResult } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const CREATE_PHONE = /* GraphQL */ `
  mutation CreatePhone($input: CreatePhoneContactInput!) {
    createPhoneContact(input: $input) {
      code
      issues {
        code
        message
        path
      }
      contact {
        associationId
        contactPointId
        displayValue
        usageKind
        isPrimary
        sensitivity
        version
        contactVersion
      }
    }
  }
`;
const CREATE_CONTACT = /* GraphQL */ `
  mutation CreateContact($input: CreatePersonContactInput!) {
    createPersonContact(input: $input) {
      code
      issues {
        code
        message
        path
      }
      contact {
        associationId
        contactPointId
        kind
        displayValue
        usageKind
        isPrimary
        sensitivity
        version
        contactVersion
        evidence {
          id
        }
      }
    }
  }
`;
const UPDATE_CONTACT = /* GraphQL */ `
  mutation UpdateContact($input: UpdatePhoneContactInput!) {
    updatePersonContact(input: $input) {
      code
      currentVersion
      issues {
        code
        message
        path
      }
      contact {
        associationId
        contactPointId
        kind
        displayValue
        usageKind
        isPrimary
        validFrom
        validUntil
        version
        contactVersion
      }
    }
  }
`;
const PERSON_LOCATIONS = /* GraphQL */ `
  query PersonLocations(
    $id: UUID!
    $first: Int
    $contactAfter: String
    $addressAfter: String
  ) {
    person(id: $id) {
      id
      contacts(first: $first, after: $contactAfter) {
        nodes {
          associationId
          contactPointId
          displayValue
          usageKind
          isPrimary
          version
          contactVersion
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
      addresses(first: $first, after: $addressAfter) {
        nodes {
          associationId
          addressId
          line1
          locality
          region
          countryCode
          isPrimary
          version
          addressVersion
          place {
            id
            name
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
const CONTACT_EDIT_PROJECTION = /* GraphQL */ `
  query ContactEditProjection($associationId: UUID!) {
    contactEditProjection(associationId: $associationId) {
      associationId
      displayValue
      version
      contactVersion
    }
  }
`;
const CONTACT_DISPLAY_PROJECTION = /* GraphQL */ `
  query ContactDisplayProjection($associationId: UUID!) {
    contactDisplayProjection(associationId: $associationId) {
      associationId
      displayValue
    }
  }
`;
const ADDRESS_EDIT_PROJECTION = /* GraphQL */ `
  query AddressEditProjection($associationId: UUID!) {
    addressEditProjection(associationId: $associationId) {
      associationId
      line1
      locality
      version
      addressVersion
    }
  }
`;
const CREATE_PLACE = /* GraphQL */ `
  mutation CreatePlace($input: CreatePlaceInput!) {
    createPlace(input: $input) {
      code
      issues {
        code
        message
        path
      }
      place {
        id
        name
        version
      }
    }
  }
`;
const UPDATE_PLACE = /* GraphQL */ `
  mutation UpdatePlace($input: UpdatePlaceInput!) {
    updatePlace(input: $input) {
      code
      currentVersion
      issues {
        code
        message
        path
      }
      place {
        id
        name
        parentPlaceId
        locality
        region
        version
      }
    }
  }
`;
const ARCHIVE_PLACE = /* GraphQL */ `
  mutation ArchivePlace($input: ArchivePlaceInput!) {
    archivePlace(input: $input) {
      code
      currentVersion
      place {
        id
        version
      }
    }
  }
`;
const PLACES = /* GraphQL */ `
  query Places($first: Int!, $after: String) {
    places(first: $first, after: $after) {
      nodes {
        id
        name
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;
const CREATE_ADDRESS = /* GraphQL */ `
  mutation CreateAddress($input: CreatePersonAddressInput!) {
    createPersonAddress(input: $input) {
      code
      issues {
        code
        message
        path
      }
      address {
        associationId
        addressId
        line1
        locality
        isPrimary
        version
        addressVersion
        evidence {
          id
        }
        place {
          id
          name
        }
      }
    }
  }
`;
const UPDATE_ADDRESS = /* GraphQL */ `
  mutation UpdateAddress($input: UpdatePersonAddressInput!) {
    updatePersonAddress(input: $input) {
      code
      currentVersion
      issues {
        code
        message
        path
      }
      address {
        associationId
        addressId
        line1
        locality
        place {
          id
          name
        }
        isPrimary
        validFrom
        validUntil
        version
        addressVersion
        evidence {
          id
        }
      }
    }
  }
`;
const ARCHIVE_PHONE = /* GraphQL */ `
  mutation ArchivePhone($input: ArchivePhoneContactInput!) {
    archivePhoneContact(input: $input) {
      code
      currentVersion
      contact {
        associationId
        version
        contactVersion
      }
    }
  }
`;
const ARCHIVE_ADDRESS = /* GraphQL */ `
  mutation ArchiveAddress($input: ArchivePersonAddressInput!) {
    archivePersonAddress(input: $input) {
      code
      currentVersion
      address {
        associationId
        version
        addressVersion
      }
    }
  }
`;

type PhonePayload = {
  createPhoneContact: {
    code: string | null;
    issues: unknown[];
    contact: {
      associationId: string;
      contactPointId: string;
      displayValue: string;
      isPrimary: boolean;
      sensitivity: string;
      version: number;
      contactVersion: number;
    } | null;
  };
};
type AddressPayload = {
  createPersonAddress: {
    code: string | null;
    address: {
      associationId: string;
      addressId: string;
      line1: string;
      locality: string;
      isPrimary: boolean;
      version: number;
      addressVersion: number;
      place: { id: string; name: string } | null;
    } | null;
  };
};

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

liveDescribe("protected contacts and locations GraphQL", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture({
      searchIndexMaintenance: createSearchIndexMaintenance({
        metrics: createTask12Metrics(disabledMetricsSink),
      }),
    });
    await fixture.reset();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("creates and reads an encrypted phone without leaking it into raw rows or audit", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Protected Person",
    });
    const personId = person.body?.data?.createPerson?.person?.id;
    expect(personId).toBeTruthy();
    const plaintext = "+1 (202) 555-0147";

    const created = await fixture.execute<PhonePayload>({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: plaintext,
          usageKind: "mobile",
          sensitivity: "INTERNAL",
          isPrimary: true,
          idempotencyKey: "phone-create-1",
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    expect(created.body?.data?.createPhoneContact.contact?.displayValue).toBe(
      plaintext,
    );
    const contact = created.body?.data?.createPhoneContact.contact;
    expect(contact).toBeTruthy();

    const [raw] = await fixture.database
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.id, contact!.contactPointId));
    expect(raw?.encryptedDisplayValue).toMatch(/^hs1\./u);
    expect(JSON.stringify(raw)).not.toContain(plaintext);
    expect(raw?.blindIndex).toMatch(/^[0-9a-f]{64}$/u);

    const events = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, contact!.contactPointId));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(plaintext);
    expect(fixture.capturedLogs.join("\n")).not.toContain(plaintext);

    const read = await fixture.execute<{
      person: { contacts: { nodes: Array<{ displayValue: string }> } } | null;
    }>({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: { id: personId, first: 10 },
    });
    expect(read.body?.data?.person?.contacts.nodes).toHaveLength(1);
    expect(read.body?.data?.person?.contacts.nodes[0]?.displayValue).toBe(
      plaintext,
    );
  });

  it("durably replays a contact mutation once and rejects key reuse with changed material", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Idempotent Contact",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Idempotent person was not created",
    );
    const input = {
      personId,
      value: "+12025550222",
      usageKind: "mobile",
      sensitivity: "INTERNAL",
      idempotencyKey: "durable-contact-create",
    };
    const [first, replay] = await Promise.all([
      fixture.execute<PhonePayload>({
        jar: actor.jar,
        query: CREATE_PHONE,
        variables: { input },
      }),
      fixture.execute<PhonePayload>({
        jar: actor.jar,
        query: CREATE_PHONE,
        variables: { input },
      }),
    ]);
    const firstContact = required(
      first.body?.data?.createPhoneContact.contact,
      "First idempotent contact was not returned",
    );
    const replayContact = required(
      replay.body?.data?.createPhoneContact.contact,
      "Replayed idempotent contact was not returned",
    );
    expect(replayContact).toEqual(firstContact);
    const domainRows = await fixture.database
      .select({ id: contactPoints.id })
      .from(contactPoints)
      .where(eq(contactPoints.id, firstContact.contactPointId));
    expect(domainRows).toHaveLength(1);
    const associationRows = await fixture.database
      .select({ id: personContactPoints.id })
      .from(personContactPoints)
      .where(
        eq(personContactPoints.contactPointId, firstContact.contactPointId),
      );
    expect(associationRows).toHaveLength(1);
    const events = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, firstContact.contactPointId));
    expect(events).toHaveLength(1);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency);
    expect(claims).toHaveLength(1);
    expect(JSON.stringify(claims)).not.toContain(input.value);
    expect(claims[0]?.responseReference).toEqual({
      associationId: firstContact.associationId,
      resourceId: firstContact.contactPointId,
      code: null,
      currentVersion: null,
    });

    const changed = await fixture.execute({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: { input: { ...input, value: "+12025550223" } },
    });
    expectGraphQLError(changed, "CONFLICT");
    expect(fixture.capturedLogs.join("\n")).not.toContain(input.value);
  });

  it("fails closed on malformed replay references and serializes expired takeover", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Idempotency hardening",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Idempotency hardening person was not created",
    );
    const malformedInput = {
      personId,
      value: "+12025550226",
      usageKind: "mobile",
      idempotencyKey: "malformed-replay-reference",
    };
    const first = await fixture.execute<PhonePayload>({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: { input: malformedInput },
    });
    expect(first.body?.errors).toBeUndefined();
    const [claim] = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "location.contact.create"),
      );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { resourceId: "not-a-uuid" } })
      .where(
        eq(
          locationMutationIdempotency.id,
          required(claim?.id, "Claim missing"),
        ),
      );
    const malformedReplay = await fixture.execute({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: { input: malformedInput },
    });
    expectGraphQLError(malformedReplay, "PRECONDITION_FAILED");

    const takeoverInput = {
      personId,
      value: "+12025550227",
      usageKind: "home",
      idempotencyKey: "expired-takeover",
    };
    const beforeExpiry = await fixture.execute<PhonePayload>({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: { input: takeoverInput },
    });
    expect(beforeExpiry.body?.errors).toBeUndefined();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(
        eq(locationMutationIdempotency.operation, "location.contact.create"),
      );
    const [takeoverA, takeoverB] = await Promise.all([
      fixture.execute<PhonePayload>({
        jar: actor.jar,
        query: CREATE_PHONE,
        variables: { input: takeoverInput },
      }),
      fixture.execute<PhonePayload>({
        jar: actor.jar,
        query: CREATE_PHONE,
        variables: { input: takeoverInput },
      }),
    ]);
    expect(takeoverA.body?.errors).toBeUndefined();
    expect(takeoverB.body?.errors).toBeUndefined();
    expect(takeoverA.body?.data?.createPhoneContact.contact).toEqual(
      takeoverB.body?.data?.createPhoneContact.contact,
    );
    expect(
      takeoverA.body?.data?.createPhoneContact.contact?.contactPointId,
    ).not.toBe(
      beforeExpiry.body?.data?.createPhoneContact.contact?.contactPointId,
    );
    const homeAssociations = await fixture.database
      .select({ id: personContactPoints.id })
      .from(personContactPoints)
      .where(
        and(
          eq(personContactPoints.personId, personId),
          eq(personContactPoints.usageKind, "home"),
          isNull(personContactPoints.deletedAt),
        ),
      );
    expect(homeAssociations).toHaveLength(2);
  });

  it("revalidates API-key mutation scope and returns neutral sensitivity outcomes", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "API key contact",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "API key person was not created",
    );
    const key = await fixture.provisionKey(owner, {
      person: ["read"],
      contactPoint: ["create", "read"],
    });
    const visible = await fixture.execute<PhonePayload>({
      apiKey: key.key,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550224",
          usageKind: "mobile",
          idempotencyKey: "api-key-visible-contact",
        },
      },
    });
    expect(visible.body?.errors).toBeUndefined();
    expect(visible.body?.data?.createPhoneContact.contact?.displayValue).toBe(
      "+12025550224",
    );
    expect(visible.body?.data?.createPhoneContact.contact?.sensitivity).toBe(
      "INTERNAL",
    );

    const hidden = await fixture.execute<PhonePayload>({
      apiKey: key.key,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550225",
          usageKind: "private",
          sensitivity: "CONFIDENTIAL",
          idempotencyKey: "api-key-hidden-contact",
        },
      },
    });
    expect(hidden.body?.errors).toBeUndefined();
    expect(hidden.body?.data?.createPhoneContact).toMatchObject({
      code: "NOT_VISIBLE",
      contact: null,
    });
    await fixture.database
      .update(apiKeys)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
    const revokedReplay = await fixture.execute({
      apiKey: key.key,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550224",
          usageKind: "mobile",
          idempotencyKey: "api-key-visible-contact",
        },
      },
    });
    expectGraphQLError(revokedReplay, "UNAUTHENTICATED");
  });

  it("stores email and other contact kinds only as encrypted protected values", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Multi-channel contact",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Multi-channel person was not created",
    );
    const cases = [
      {
        kind: "email",
        value: "Person@Example.COM",
        expectedVersion: 1,
      },
      {
        kind: "other",
        value: "Signal: private-handle",
        expectedVersion: null,
      },
    ] as const;
    for (const item of cases) {
      const result = await fixture.execute<{
        createPersonContact: {
          code: string | null;
          contact: {
            associationId: string;
            contactPointId: string;
            kind: string;
            displayValue: string;
          } | null;
        };
      }>({
        jar: actor.jar,
        query: CREATE_CONTACT,
        variables: {
          input: {
            personId,
            kind: item.kind,
            value: item.value,
            usageKind: "personal",
            idempotencyKey: `protected-${item.kind}`,
          },
        },
      });
      const contact = required(
        result.body?.data?.createPersonContact.contact,
        `${item.kind} contact was not created`,
      );
      expect(contact).toMatchObject({
        kind: item.kind,
        displayValue: item.value,
      });
      const [raw] = await fixture.database
        .select()
        .from(contactPoints)
        .where(eq(contactPoints.id, contact.contactPointId));
      expect(raw?.encryptedDisplayValue).toMatch(/^hs1\./u);
      expect(JSON.stringify(raw)).not.toContain(item.value);
      expect(raw?.blindIndexVersion).toBe(item.expectedVersion);
      expect(raw?.blindIndex).toMatch(/^[0-9a-f]{64}$/u);
      const claims = await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(
          eq(locationMutationIdempotency.operation, "location.contact.create"),
        );
      expect(JSON.stringify(claims)).not.toContain(item.value);
    }
  });

  it("validates evidence atomically and projects it only with live evidence scope", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Evidence-backed contact",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Evidence-backed person was not created",
    );
    const sourceId = newId();
    const evidenceId = newId();
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: owner.workspaceId,
      kind: "document",
      title: "Verified directory",
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceId,
      workspaceId: owner.workspaceId,
      sourceId,
      checksum: `sha256:${"a".repeat(64)}`,
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });

    const linkedContact = await fixture.execute<{
      createPersonContact: {
        contact: { evidence: { id: string } | null } | null;
      };
    }>({
      jar: owner.jar,
      query: CREATE_CONTACT,
      variables: {
        input: {
          personId,
          evidenceId,
          kind: "email",
          value: "evidence@example.test",
          usageKind: "personal",
          idempotencyKey: "contact-evidence-owner",
        },
      },
    });
    expect(linkedContact.body?.errors).toBeUndefined();
    expect(
      linkedContact.body?.data?.createPersonContact.contact?.evidence,
    ).toEqual({ id: evidenceId });

    const noEvidenceScope = await fixture.provisionKey(owner, {
      person: ["read"],
      contactPoint: ["create", "read"],
    });
    const denied = await fixture.execute({
      apiKey: noEvidenceScope.key,
      query: CREATE_CONTACT,
      variables: {
        input: {
          personId,
          evidenceId,
          kind: "phone",
          value: "+12025550240",
          usageKind: "mobile",
          idempotencyKey: "contact-evidence-no-scope",
        },
      },
    });
    expectGraphQLError(denied, "FORBIDDEN");

    const fullScope = await fixture.provisionKey(owner, {
      person: ["read"],
      contactPoint: ["create", "read"],
      evidence: ["read"],
    });
    const allowed = await fixture.execute<{
      createPersonContact: {
        contact: { evidence: { id: string } | null } | null;
      };
    }>({
      apiKey: fullScope.key,
      query: CREATE_CONTACT,
      variables: {
        input: {
          personId,
          evidenceId,
          kind: "phone",
          value: "+12025550241",
          usageKind: "mobile",
          idempotencyKey: "contact-evidence-full-scope",
        },
      },
    });
    expect(allowed.body?.errors).toBeUndefined();
    expect(allowed.body?.data?.createPersonContact.contact?.evidence).toEqual({
      id: evidenceId,
    });

    const foreignSourceId = newId();
    const foreignEvidenceId = newId();
    await fixture.database.insert(sources).values({
      id: foreignSourceId,
      workspaceId: foreign.workspaceId,
      kind: "document",
      title: "Foreign source",
      createdBy: foreign.principalId,
      updatedBy: foreign.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: foreignEvidenceId,
      workspaceId: foreign.workspaceId,
      sourceId: foreignSourceId,
      checksum: `sha256:${"b".repeat(64)}`,
      createdBy: foreign.principalId,
      updatedBy: foreign.principalId,
    });
    const claimsBefore = await fixture.database
      .select({ id: locationMutationIdempotency.id })
      .from(locationMutationIdempotency);
    const crossWorkspace = await fixture.execute({
      jar: owner.jar,
      query: CREATE_ADDRESS,
      variables: {
        input: {
          personId,
          evidenceId: foreignEvidenceId,
          addressKind: "residence",
          line1: "1 Evidence Lane",
          locality: "Richmond",
          idempotencyKey: "address-foreign-evidence",
        },
      },
    });
    expectGraphQLError(crossWorkspace, "NOT_FOUND");
    const claimsAfter = await fixture.database
      .select({ id: locationMutationIdempotency.id })
      .from(locationMutationIdempotency);
    expect(claimsAfter).toHaveLength(claimsBefore.length);
  });

  it("keeps current contact primaries when historical writes are rejected and maps partial temporal errors", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Temporal contact",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Temporal contact person was not created",
    );
    const current = await fixture.execute<PhonePayload>({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550230",
          usageKind: "mobile",
          isPrimary: true,
          idempotencyKey: "temporal-current-contact",
        },
      },
    });
    const currentContact = required(
      current.body?.data?.createPhoneContact.contact,
      "Current contact was not created",
    );
    const rejectedHistorical = await fixture.execute<PhonePayload>({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550231",
          usageKind: "mobile",
          validFrom: "2020-01-01T00:00:00.000Z",
          validUntil: "2021-01-01T00:00:00.000Z",
          isPrimary: true,
          idempotencyKey: "temporal-historical-primary",
        },
      },
    });
    expect(rejectedHistorical.body?.data?.createPhoneContact).toMatchObject({
      code: "VALIDATION_FAILED",
      contact: null,
    });
    const primaryRows = await fixture.database
      .select({ id: personContactPoints.id })
      .from(personContactPoints)
      .where(
        and(
          eq(personContactPoints.personId, personId),
          eq(personContactPoints.isPrimary, true),
          isNull(personContactPoints.deletedAt),
        ),
      );
    expect(primaryRows).toEqual([{ id: currentContact.associationId }]);

    const invalidPatch = await fixture.execute({
      jar: actor.jar,
      query: UPDATE_CONTACT,
      variables: {
        input: {
          associationId: currentContact.associationId,
          expectedVersion: currentContact.version,
          expectedContactVersion: currentContact.contactVersion,
          validFrom: "2026-01-02T00:00:00.000Z",
          validUntil: "2026-01-01T00:00:00.000Z",
          idempotencyKey: "temporal-invalid-contact-patch",
        },
      },
    });
    expectGraphQLError(invalidPatch, "VALIDATION_FAILED");
  });

  it("atomically replaces a current primary phone and rejects tampered or cross-parent cursors", async () => {
    const actor = await fixture.createActor();
    const firstPerson = await fixture.createPerson(actor, {
      displayName: "Primary One",
    });
    const secondPerson = await fixture.createPerson(actor, {
      displayName: "Primary Two",
    });
    const firstId = required(
      firstPerson.body?.data?.createPerson?.person?.id,
      "First person was not created",
    );
    const secondId = required(
      secondPerson.body?.data?.createPerson?.person?.id,
      "Second person was not created",
    );
    for (const [index, value] of ["+12025550101", "+12025550102"].entries()) {
      const result = await fixture.execute<PhonePayload>({
        jar: actor.jar,
        query: CREATE_PHONE,
        variables: {
          input: {
            personId: firstId,
            value,
            usageKind: "mobile",
            sensitivity: "INTERNAL",
            isPrimary: true,
            idempotencyKey: `primary-${index}`,
          },
        },
      });
      expect(result.body?.data?.createPhoneContact.contact).toBeTruthy();
    }
    const primary = await fixture.database
      .select()
      .from(personContactPoints)
      .where(
        and(
          eq(personContactPoints.personId, firstId),
          eq(personContactPoints.isPrimary, true),
          isNull(personContactPoints.deletedAt),
        ),
      );
    expect(primary).toHaveLength(1);

    const page = await fixture.execute<{
      person: {
        contacts: { pageInfo: { endCursor: string; hasNextPage: boolean } };
      } | null;
    }>({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: { id: firstId, first: 1 },
    });
    const cursor = page.body?.data?.person?.contacts.pageInfo.endCursor;
    expect(cursor).toMatch(/\./u);
    const tamperedCursor = `${cursor!.slice(0, -1)}${cursor!.endsWith("0") ? "1" : "0"}`;
    const tampered = await fixture.execute({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: { id: firstId, first: 1, contactAfter: tamperedCursor },
    });
    expectGraphQLError(tampered, "VALIDATION_FAILED");
    const otherParent = await fixture.execute({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: { id: secondId, first: 1, contactAfter: cursor },
    });
    expectGraphQLError(otherParent, "VALIDATION_FAILED");
  });

  it("paginates full contact and address pages with encoded timestamp cursors", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Contact cursor page",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Contact cursor person was not created",
    );
    const associationIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const created = await fixture.execute<PhonePayload>({
        jar: actor.jar,
        query: CREATE_PHONE,
        variables: {
          input: {
            personId,
            value: `+18045553${String(index).padStart(3, "0")}`,
            usageKind: "mobile",
            idempotencyKey: `contact-cursor-create-${index}`,
          },
        },
      });
      const contact = required(
        created.body?.data?.createPhoneContact.contact,
        "Contact cursor record missing",
      );
      associationIds.push(contact.associationId);
      await fixture.database
        .update(personContactPoints)
        .set({ createdAt: new Date(`2026-08-03T12:00:0${index}.000Z`) })
        .where(eq(personContactPoints.id, contact.associationId));
    }

    const first = await fixture.execute<{
      person: {
        contacts: {
          nodes: Array<{ associationId: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: { id: personId, first: 5 },
    });
    expect(first.body?.errors).toBeUndefined();
    const firstPage = required(
      first.body?.data?.person?.contacts,
      "First contact cursor page missing",
    );
    expect(firstPage.nodes).toHaveLength(5);
    expect(firstPage.pageInfo.hasNextPage).toBe(true);

    const second = await fixture.execute<{
      person: {
        contacts: {
          nodes: Array<{ associationId: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: {
        id: personId,
        first: 5,
        contactAfter: required(
          firstPage.pageInfo.endCursor,
          "Contact cursor missing",
        ),
      },
    });
    expect(second.body?.errors).toBeUndefined();
    const secondPage = required(
      second.body?.data?.person?.contacts,
      "Second contact cursor page missing",
    );
    expect(secondPage.nodes).toHaveLength(1);
    expect(secondPage.pageInfo.hasNextPage).toBe(false);
    expect(
      new Set([
        ...firstPage.nodes.map((node) => node.associationId),
        ...secondPage.nodes.map((node) => node.associationId),
      ]),
    ).toEqual(new Set(associationIds));

    const addressAssociationIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const created = await fixture.execute<AddressPayload>({
        jar: actor.jar,
        query: CREATE_ADDRESS,
        variables: {
          input: {
            personId,
            addressKind: "residence",
            line1: `${300 + index} Cursor Avenue`,
            idempotencyKey: `address-cursor-create-${index}`,
          },
        },
      });
      const address = required(
        created.body?.data?.createPersonAddress.address,
        "Address cursor record missing",
      );
      addressAssociationIds.push(address.associationId);
      await fixture.database
        .update(personAddresses)
        .set({ createdAt: new Date(`2026-08-03T13:00:0${index}.000Z`) })
        .where(eq(personAddresses.id, address.associationId));
    }
    const addressFirst = await fixture.execute<{
      person: {
        addresses: {
          nodes: Array<{ associationId: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: { id: personId, first: 5 },
    });
    expect(addressFirst.body?.errors).toBeUndefined();
    const addressFirstPage = required(
      addressFirst.body?.data?.person?.addresses,
      "First address cursor page missing",
    );
    expect(addressFirstPage.nodes).toHaveLength(5);
    expect(addressFirstPage.pageInfo.hasNextPage).toBe(true);
    const addressSecond = await fixture.execute<{
      person: {
        addresses: {
          nodes: Array<{ associationId: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>({
      jar: actor.jar,
      query: PERSON_LOCATIONS,
      variables: {
        id: personId,
        first: 5,
        addressAfter: required(
          addressFirstPage.pageInfo.endCursor,
          "Address cursor missing",
        ),
      },
    });
    expect(addressSecond.body?.errors).toBeUndefined();
    const addressSecondPage = required(
      addressSecond.body?.data?.person?.addresses,
      "Second address cursor page missing",
    );
    expect(addressSecondPage.nodes).toHaveLength(1);
    expect(addressSecondPage.pageInfo.hasNextPage).toBe(false);
    expect(
      new Set([
        ...addressFirstPage.nodes.map((node) => node.associationId),
        ...addressSecondPage.nodes.map((node) => node.associationId),
      ]),
    ).toEqual(new Set(addressAssociationIds));
  });

  it("serializes concurrent primary promotion for contacts and addresses without deadlocks", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Concurrent primaries",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Concurrent primary person was not created",
    );
    const contacts = await Promise.all(
      ["+12025550250", "+12025550251"].map((value, index) =>
        fixture.execute<PhonePayload>({
          jar: actor.jar,
          query: CREATE_PHONE,
          variables: {
            input: {
              personId,
              value,
              usageKind: "mobile",
              idempotencyKey: `concurrent-primary-contact-create-${index}`,
            },
          },
        }),
      ),
    );
    const contactRows = contacts.map((result) =>
      required(
        result.body?.data?.createPhoneContact.contact,
        "Concurrent contact missing",
      ),
    );
    const promotedContacts = await Promise.all(
      contactRows.map((contact, index) =>
        fixture.execute({
          jar: actor.jar,
          query: UPDATE_CONTACT,
          variables: {
            input: {
              associationId: contact.associationId,
              expectedVersion: contact.version,
              expectedContactVersion: contact.contactVersion,
              isPrimary: true,
              idempotencyKey: `concurrent-primary-contact-update-${index}`,
            },
          },
        }),
      ),
    );
    expect(promotedContacts.every((result) => !result.body?.errors)).toBe(true);
    const contactPrimaries = await fixture.database
      .select({ id: personContactPoints.id })
      .from(personContactPoints)
      .where(
        and(
          eq(personContactPoints.personId, personId),
          eq(personContactPoints.usageKind, "mobile"),
          eq(personContactPoints.isPrimary, true),
          isNull(personContactPoints.deletedAt),
        ),
      );
    expect(contactPrimaries).toHaveLength(1);

    const addressesCreated = await Promise.all(
      ["10 First Road", "20 Second Road"].map((line1, index) =>
        fixture.execute<AddressPayload>({
          jar: actor.jar,
          query: CREATE_ADDRESS,
          variables: {
            input: {
              personId,
              addressKind: "residence",
              line1,
              locality: "Richmond",
              idempotencyKey: `concurrent-primary-address-create-${index}`,
            },
          },
        }),
      ),
    );
    const addressRows = addressesCreated.map((result) =>
      required(
        result.body?.data?.createPersonAddress.address,
        "Concurrent address missing",
      ),
    );
    const promotedAddresses = await Promise.all(
      addressRows.map((address, index) =>
        fixture.execute({
          jar: actor.jar,
          query: UPDATE_ADDRESS,
          variables: {
            input: {
              associationId: address.associationId,
              expectedVersion: address.version,
              expectedAddressVersion: address.addressVersion,
              isPrimary: true,
              idempotencyKey: `concurrent-primary-address-update-${index}`,
            },
          },
        }),
      ),
    );
    expect(promotedAddresses.every((result) => !result.body?.errors)).toBe(
      true,
    );
    const addressPrimaries = await fixture.database
      .select({ id: personAddresses.id })
      .from(personAddresses)
      .where(
        and(
          eq(personAddresses.personId, personId),
          eq(personAddresses.addressKind, "residence"),
          eq(personAddresses.isPrimary, true),
          isNull(personAddresses.deletedAt),
        ),
      );
    expect(addressPrimaries).toHaveLength(1);
  });

  it("serializes concurrent place writes before live user and API-key authority locks", async () => {
    const owner = await fixture.createActor();
    const key = await fixture.provisionKey(owner, {
      place: ["create", "read", "update", "delete"],
    });
    const credentials = [
      { label: "user", request: { jar: owner.jar } },
      { label: "api-key", request: { apiKey: key.key } },
    ] as const;

    function expectNoInternalFailure(result: OperationResult<unknown>) {
      expect(
        result.body?.errors?.some(
          (error) =>
            error.extensions?.code === "INTERNAL_SERVER_ERROR" ||
            error.extensions?.code === "INTERNAL" ||
            /deadlock|internal/iu.test(error.message),
        ) ?? false,
        JSON.stringify([result.body, fixture.capturedLogs]),
      ).toBe(false);
    }

    for (const credential of credentials) {
      const created = await Promise.all(
        ["Alpha", "Beta"].map((name, index) =>
          fixture.execute<{
            createPlace: {
              code: string | null;
              place: { id: string; name: string; version: number } | null;
            };
          }>({
            ...credential.request,
            query: CREATE_PLACE,
            variables: {
              input: {
                name: `${credential.label} concurrent ${name}`,
                kind: "region",
                idempotencyKey: `${credential.label}-concurrent-create-${index}`,
              },
            },
          }),
        ),
      );
      created.forEach(expectNoInternalFailure);
      const [alpha, beta] = created.map((result) =>
        required(
          result.body?.data?.createPlace.place,
          `${credential.label} concurrent place missing`,
        ),
      );

      const updates = await Promise.all(
        ["First", "Second"].map((suffix, index) =>
          fixture.execute<{
            updatePlace: {
              code: string | null;
              currentVersion: number | null;
              place: { id: string; name: string; version: number } | null;
            };
          }>({
            ...credential.request,
            query: UPDATE_PLACE,
            variables: {
              input: {
                id: alpha.id,
                expectedVersion: alpha.version,
                name: `${credential.label} ${suffix}`,
                idempotencyKey: `${credential.label}-concurrent-update-${index}`,
              },
            },
          }),
        ),
      );
      updates.forEach(expectNoInternalFailure);
      expect(
        updates.filter(
          (result) => result.body?.data?.updatePlace.place != null,
        ),
      ).toHaveLength(1);
      expect(
        updates.filter(
          (result) => result.body?.data?.updatePlace.code === "CONFLICT",
        ),
      ).toHaveLength(1);

      const reparents = await Promise.all([
        fixture.execute({
          ...credential.request,
          query: UPDATE_PLACE,
          variables: {
            input: {
              id: alpha.id,
              expectedVersion: alpha.version + 1,
              parentPlaceId: beta.id,
              idempotencyKey: `${credential.label}-opposite-reparent-a`,
            },
          },
        }),
        fixture.execute({
          ...credential.request,
          query: UPDATE_PLACE,
          variables: {
            input: {
              id: beta.id,
              expectedVersion: beta.version,
              parentPlaceId: alpha.id,
              idempotencyKey: `${credential.label}-opposite-reparent-b`,
            },
          },
        }),
      ]);
      reparents.forEach(expectNoInternalFailure);
      expect(reparents.filter((result) => !result.body?.errors).length).toBe(1);
      expect(
        reparents.filter(
          (result) =>
            result.body?.errors?.[0]?.extensions?.code === "VALIDATION_FAILED",
        ).length,
      ).toBe(1);

      const archiveTarget = required(
        (
          await fixture.execute<{
            createPlace: {
              place: { id: string; version: number } | null;
            };
          }>({
            ...credential.request,
            query: CREATE_PLACE,
            variables: {
              input: {
                name: `${credential.label} archive target`,
                kind: "locality",
                idempotencyKey: `${credential.label}-archive-create`,
              },
            },
          })
        ).body?.data?.createPlace.place,
        `${credential.label} archive target missing`,
      );
      const archives = await Promise.all(
        [0, 1].map((index) =>
          fixture.execute<{
            archivePlace: { code: string | null; place: null };
          }>({
            ...credential.request,
            query: ARCHIVE_PLACE,
            variables: {
              input: {
                id: archiveTarget.id,
                expectedVersion: archiveTarget.version,
                idempotencyKey: `${credential.label}-concurrent-archive-${index}`,
              },
            },
          }),
        ),
      );
      archives.forEach(expectNoInternalFailure);
      expect(
        archives
          .map(
            (result) =>
              result.body?.data?.archivePlace?.code ??
              result.body?.errors?.[0]?.extensions?.code,
          )
          .sort(),
      ).toEqual(["ARCHIVED", "NOT_FOUND"]);
    }

    const ownerPlace = required(
      (
        await fixture.execute<{
          createPlace: { place: { id: string } | null };
        }>({
          jar: owner.jar,
          query: CREATE_PLACE,
          variables: {
            input: {
              name: "Owner-only place",
              kind: "region",
              idempotencyKey: "owner-only-place-create",
            },
          },
        })
      ).body?.data?.createPlace.place,
      "Owner-only place missing",
    );
    const foreign = await fixture.createActor();
    const crossWorkspace = await fixture.execute({
      jar: foreign.jar,
      query: UPDATE_PLACE,
      variables: {
        input: {
          id: ownerPlace.id,
          expectedVersion: 1,
          name: "Unavailable",
          idempotencyKey: "foreign-place-update",
        },
      },
    });
    expectGraphQLError(crossWorkspace, "NOT_FOUND");

    await fixture.database
      .update(apiKeys)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
    const disabledKey = await fixture.execute({
      apiKey: key.key,
      query: CREATE_PLACE,
      variables: {
        input: {
          name: "Disabled key",
          kind: "region",
          idempotencyKey: "disabled-key-place-create",
        },
      },
    });
    expectGraphQLError(disabledKey, "UNAUTHENTICATED");

    const expiredKey = await fixture.provisionKey(owner, {
      place: ["create", "read"],
    });
    await fixture.database
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000), updatedAt: new Date() })
      .where(eq(apiKeys.id, expiredKey.id));
    const expired = await fixture.execute({
      apiKey: expiredKey.key,
      query: CREATE_PLACE,
      variables: {
        input: {
          name: "Expired key",
          kind: "region",
          idempotencyKey: "expired-key-place-create",
        },
      },
    });
    expectGraphQLError(expired, "UNAUTHENTICATED");

    await fixture.database
      .delete(sessions)
      .where(eq(sessions.userId, owner.userId));
    const revokedSession = await fixture.execute({
      jar: owner.jar,
      query: CREATE_PLACE,
      variables: {
        input: {
          name: "Revoked session",
          kind: "region",
          idempotencyKey: "revoked-session-place-create",
        },
      },
    });
    expectGraphQLError(revokedSession, "UNAUTHENTICATED");
  });

  it("creates a reusable place and address, indexes only locality, and archives with stale-write protection", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Address Person",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Address person was not created",
    );
    const placeResult = await fixture.execute<{
      createPlace: { place: { id: string; name: string } | null };
    }>({
      jar: actor.jar,
      query: CREATE_PLACE,
      variables: {
        input: {
          name: "Richmond",
          kind: "locality",
          locality: "Richmond",
          region: "Virginia",
          countryCode: "US",
          sensitivity: "INTERNAL",
          idempotencyKey: "place-create-1",
        },
      },
    });
    const placeId = placeResult.body?.data?.createPlace.place?.id;
    expect(placeId).toBeTruthy();
    const addressResult = await fixture.execute<AddressPayload>({
      jar: actor.jar,
      query: CREATE_ADDRESS,
      variables: {
        input: {
          personId,
          addressKind: "residence",
          line1: "123 Secret Street",
          locality: "Richmond",
          region: "VA",
          postalCode: "23219",
          countryCode: "US",
          placeId,
          sensitivity: "INTERNAL",
          isPrimary: true,
          idempotencyKey: "address-create-1",
        },
      },
    });
    const address = addressResult.body?.data?.createPersonAddress.address;
    expect(address?.place).toEqual({ id: placeId, name: "Richmond" });
    const [raw] = await fixture.database
      .select()
      .from(addresses)
      .where(eq(addresses.id, address!.addressId));
    expect(raw?.normalizedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(raw?.normalizedHashVersion).toBe(1);
    const addressEvents = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, address!.addressId));
    expect(JSON.stringify(addressEvents)).not.toContain("123 Secret Street");

    const stale = await fixture.execute<{
      archivePersonAddress: {
        code: string | null;
        currentVersion: number | null;
      };
    }>({
      jar: actor.jar,
      query: ARCHIVE_ADDRESS,
      variables: {
        input: {
          associationId: address!.associationId,
          expectedVersion: 999,
          expectedAddressVersion: address!.addressVersion,
          idempotencyKey: "address-stale-1",
        },
      },
    });
    expect(stale.body?.data?.archivePersonAddress.code).toBe("CONFLICT");
    const archived = await fixture.execute({
      jar: actor.jar,
      query: ARCHIVE_ADDRESS,
      variables: {
        input: {
          associationId: address!.associationId,
          expectedVersion: address!.version,
          expectedAddressVersion: address!.addressVersion,
          idempotencyKey: "address-archive-1",
        },
      },
    });
    expect(archived.body?.errors).toBeUndefined();
    const [rawAssociation] = await fixture.database
      .select()
      .from(personAddresses)
      .where(eq(personAddresses.id, address!.associationId));
    expect(rawAssociation?.deletedAt).toBeInstanceOf(Date);
  });

  it("updates and relinks addresses, rejects effective temporal errors, and preserves current address primary", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Address updater",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Address updater was not created",
    );
    const placeA = await fixture.execute<{
      createPlace: { place: { id: string; version: number } | null };
    }>({
      jar: actor.jar,
      query: CREATE_PLACE,
      variables: {
        input: {
          name: "Place A",
          kind: "locality",
          idempotencyKey: "address-update-place-a",
        },
      },
    });
    const placeB = await fixture.execute<{
      createPlace: { place: { id: string; version: number } | null };
    }>({
      jar: actor.jar,
      query: CREATE_PLACE,
      variables: {
        input: {
          name: "Place B",
          kind: "locality",
          idempotencyKey: "address-update-place-b",
        },
      },
    });
    const placeAId = required(
      placeA.body?.data?.createPlace.place?.id,
      "Place A missing",
    );
    const placeBId = required(
      placeB.body?.data?.createPlace.place?.id,
      "Place B missing",
    );
    const created = await fixture.execute<AddressPayload>({
      jar: actor.jar,
      query: CREATE_ADDRESS,
      variables: {
        input: {
          personId,
          addressKind: "residence",
          line1: "1 Original Road",
          locality: "Original",
          placeId: placeAId,
          isPrimary: true,
          idempotencyKey: "address-update-create",
        },
      },
    });
    const address = required(
      created.body?.data?.createPersonAddress.address,
      "Address update record missing",
    );
    const updated = await fixture.execute<{
      updatePersonAddress: {
        code: string | null;
        address: {
          associationId: string;
          addressId: string;
          line1: string;
          place: { id: string } | null;
          version: number;
          addressVersion: number;
        } | null;
      };
    }>({
      jar: actor.jar,
      query: UPDATE_ADDRESS,
      variables: {
        input: {
          associationId: address.associationId,
          expectedVersion: address.version,
          expectedAddressVersion: address.addressVersion,
          line1: "2 Updated Road",
          placeId: placeBId,
          idempotencyKey: "address-update-apply",
        },
      },
    });
    expect(updated.body?.data?.updatePersonAddress.address).toMatchObject({
      line1: "2 Updated Road",
      place: { id: placeBId },
    });
    const updatedAddress = required(
      updated.body?.data?.updatePersonAddress.address,
      "Updated address missing",
    );
    const invalidTemporal = await fixture.execute({
      jar: actor.jar,
      query: UPDATE_ADDRESS,
      variables: {
        input: {
          associationId: updatedAddress.associationId,
          expectedVersion: updatedAddress.version,
          expectedAddressVersion: updatedAddress.addressVersion,
          validFrom: "2026-04-02T00:00:00.000Z",
          validUntil: "2026-04-01T00:00:00.000Z",
          idempotencyKey: "address-update-invalid-temporal",
        },
      },
    });
    expectGraphQLError(invalidTemporal, "VALIDATION_FAILED");

    const rejectedHistorical = await fixture.execute<AddressPayload>({
      jar: actor.jar,
      query: CREATE_ADDRESS,
      variables: {
        input: {
          personId,
          addressKind: "residence",
          line1: "Historical Road",
          validFrom: "2019-01-01T00:00:00.000Z",
          validUntil: "2020-01-01T00:00:00.000Z",
          isPrimary: true,
          idempotencyKey: "address-historical-primary",
        },
      },
    });
    expect(rejectedHistorical.body?.data?.createPersonAddress).toMatchObject({
      code: "VALIDATION_FAILED",
      address: null,
    });
    const primary = await fixture.database
      .select({ id: personAddresses.id })
      .from(personAddresses)
      .where(
        and(
          eq(personAddresses.personId, personId),
          eq(personAddresses.isPrimary, true),
          isNull(personAddresses.deletedAt),
        ),
      );
    expect(primary).toEqual([{ id: address.associationId }]);
  });

  it("updates place parents, rejects cycles, and archives only unreferenced places", async () => {
    const actor = await fixture.createActor();
    const create = async (
      name: string,
      key: string,
      parentPlaceId?: string,
    ) => {
      const result = await fixture.execute<{
        createPlace: { place: { id: string; version: number } | null };
      }>({
        jar: actor.jar,
        query: CREATE_PLACE,
        variables: {
          input: {
            name,
            kind: "region",
            parentPlaceId,
            idempotencyKey: key,
          },
        },
      });
      return required(result.body?.data?.createPlace.place, `${name} missing`);
    };
    const root = await create("Root", "place-cycle-root");
    const child = await create("Child", "place-cycle-child", root.id);
    const grandchild = await create(
      "Grandchild",
      "place-cycle-grandchild",
      child.id,
    );
    const cycle = await fixture.execute({
      jar: actor.jar,
      query: UPDATE_PLACE,
      variables: {
        input: {
          id: root.id,
          expectedVersion: root.version,
          parentPlaceId: grandchild.id,
          idempotencyKey: "place-cycle-rejected",
        },
      },
    });
    expectGraphQLError(cycle, "VALIDATION_FAILED");

    const referencedArchive = await fixture.execute({
      jar: actor.jar,
      query: ARCHIVE_PLACE,
      variables: {
        input: {
          id: root.id,
          expectedVersion: root.version,
          idempotencyKey: "place-archive-referenced",
        },
      },
    });
    expectGraphQLError(referencedArchive, "PRECONDITION_FAILED");

    const leafArchive = await fixture.execute<{
      archivePlace: { code: string | null; place: null };
    }>({
      jar: actor.jar,
      query: ARCHIVE_PLACE,
      variables: {
        input: {
          id: grandchild.id,
          expectedVersion: grandchild.version,
          idempotencyKey: "place-archive-leaf",
        },
      },
    });
    expect(leafArchive.body?.data?.archivePlace).toMatchObject({
      code: "ARCHIVED",
      place: null,
    });
  });

  it("paginates Unicode place names using the exact database canonical sort key", async () => {
    const actor = await fixture.createActor();
    const names = [
      "İzmir",
      "izmir",
      "Istanbul",
      "ıhlara",
      "Évry",
      "E\u0301vry",
      "ßeta",
      "SSeta",
    ];
    const createdIds: string[] = [];
    for (const [index, name] of names.entries()) {
      const result = await fixture.execute<{
        createPlace: { place: { id: string } | null };
      }>({
        jar: actor.jar,
        query: CREATE_PLACE,
        variables: {
          input: {
            name,
            kind: "locality",
            idempotencyKey: `unicode-place-${index}`,
          },
        },
      });
      createdIds.push(
        required(result.body?.data?.createPlace.place?.id, `${name} missing`),
      );
    }
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < names.length + 1; page += 1) {
      const currentAfter: string | null = after;
      const result: OperationResult<{
        places: {
          nodes: Array<{ id: string; name: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      }> = await fixture.execute({
        jar: actor.jar,
        query: PLACES,
        variables: { first: 1, after: currentAfter },
      });
      const connection: {
        nodes: Array<{ id: string; name: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      } = required(result.body?.data?.places, "Places missing");
      seen.push(...connection.nodes.map((node) => node.id));
      if (!connection.pageInfo.hasNextPage) break;
      after = required(connection.pageInfo.endCursor, "Place cursor missing");
    }
    expect(seen).toHaveLength(createdIds.length);
    expect(new Set(seen).size).toBe(createdIds.length);
    expect(new Set(seen)).toEqual(new Set(createdIds));
  });

  it("enforces role and API-key scopes and does not disclose another workspace", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const person = await fixture.createPerson(owner, {
      displayName: "Scoped Person",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Scoped person was not created",
    );
    const deniedWrite = await fixture.execute({
      jar: viewer.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550177",
          usageKind: "mobile",
          sensitivity: "INTERNAL",
          idempotencyKey: "viewer-denied-1",
        },
      },
    });
    expectGraphQLError(deniedWrite, "FORBIDDEN");

    const created = await fixture.execute<PhonePayload>({
      jar: owner.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550178",
          usageKind: "mobile",
          sensitivity: "INTERNAL",
          idempotencyKey: "scope-create-1",
        },
      },
    });
    expect(created.body?.data?.createPhoneContact.contact).toBeTruthy();
    const key = await fixture.provisionKey(owner, {
      person: ["read"],
      contactPoint: ["read"],
      address: ["read"],
    });
    const apiRead = await fixture.execute<{
      person: { contacts: { nodes: Array<{ displayValue: string }> } } | null;
    }>({
      apiKey: key.key,
      query: PERSON_LOCATIONS,
      variables: { id: personId, first: 10 },
    });
    expect(apiRead.body?.data?.person?.contacts.nodes[0]?.displayValue).toBe(
      "+12025550178",
    );
    const narrowKey = await fixture.provisionKey(owner, { person: ["read"] });
    const deniedScope = await fixture.execute({
      apiKey: narrowKey.key,
      query: PERSON_LOCATIONS,
      variables: { id: personId, first: 10 },
    });
    expectGraphQLError(deniedScope, "FORBIDDEN");
    const foreignRead = await fixture.execute<{
      person: { contacts: { nodes: unknown[] } } | null;
    }>({
      jar: foreign.jar,
      query: PERSON_LOCATIONS,
      variables: { id: personId, first: 10 },
    });
    expect(foreignRead.body?.data?.person).toBeNull();
  });

  it("authorizes exact edit projections for sessions and scoped keys without cross-workspace disclosure", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const person = await fixture.createPerson(owner, {
      displayName: "Edit Projection Person",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Projection person was not created",
    );
    const createdContact = await fixture.execute<PhonePayload>({
      jar: owner.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550178",
          usageKind: "private",
          sensitivity: "INTERNAL",
          idempotencyKey: "projection-contact-create",
        },
      },
    });
    expect(createdContact.body?.errors).toBeUndefined();
    expect(createdContact.body?.data?.createPhoneContact.code).toBeNull();
    const contact = required(
      createdContact.body?.data?.createPhoneContact.contact,
      "Projection contact was not created",
    );
    const createdAddress = await fixture.execute<AddressPayload>({
      jar: owner.jar,
      query: CREATE_ADDRESS,
      variables: {
        input: {
          personId,
          addressKind: "residence",
          line1: "991 Projection Private Lane",
          locality: "Richmond",
          region: "VA",
          postalCode: "23219",
          countryCode: "US",
          sensitivity: "INTERNAL",
          isPrimary: true,
          idempotencyKey: "projection-address-create",
        },
      },
    });
    expect(createdAddress.body?.errors).toBeUndefined();
    expect(createdAddress.body?.data?.createPersonAddress.code).toBeNull();
    const address = required(
      createdAddress.body?.data?.createPersonAddress.address,
      "Projection address was not created",
    );

    const sessionContact = await fixture.execute<{
      contactEditProjection: {
        associationId: string;
        displayValue: string;
      };
    }>({
      jar: owner.jar,
      query: CONTACT_EDIT_PROJECTION,
      variables: { associationId: contact.associationId },
    });
    expect(sessionContact.body?.data?.contactEditProjection).toMatchObject({
      associationId: contact.associationId,
      displayValue: "+12025550178",
    });

    const scopedKey = await fixture.provisionKey(owner, {
      person: ["read"],
      contactPoint: ["read", "update"],
      address: ["read", "update"],
    });
    const keyAddress = await fixture.execute<{
      addressEditProjection: {
        associationId: string;
        line1: string;
        locality: string;
      };
    }>({
      apiKey: scopedKey.key,
      query: ADDRESS_EDIT_PROJECTION,
      variables: { associationId: address.associationId },
    });
    expect(keyAddress.body?.data?.addressEditProjection).toMatchObject({
      associationId: address.associationId,
      line1: "991 Projection Private Lane",
      locality: "Richmond",
    });

    for (const request of [
      { jar: viewer.jar },
      {
        apiKey: (
          await fixture.provisionKey(owner, {
            person: ["read"],
            contactPoint: ["read"],
          })
        ).key,
      },
    ]) {
      const denied = await fixture.execute({
        ...request,
        query: CONTACT_EDIT_PROJECTION,
        variables: { associationId: contact.associationId },
      });
      expectGraphQLError(denied, "FORBIDDEN");
    }

    const viewerDisplay = await fixture.execute<{
      contactDisplayProjection: { displayValue: string };
    }>({
      jar: viewer.jar,
      query: CONTACT_DISPLAY_PROJECTION,
      variables: { associationId: contact.associationId },
    });
    expect(
      viewerDisplay.body?.data?.contactDisplayProjection.displayValue,
    ).toBe("+12025550178");
    const readOnlyKey = await fixture.provisionKey(owner, {
      person: ["read"],
      contactPoint: ["read"],
    });
    const keyDisplay = await fixture.execute<{
      contactDisplayProjection: { displayValue: string };
    }>({
      apiKey: readOnlyKey.key,
      query: CONTACT_DISPLAY_PROJECTION,
      variables: { associationId: contact.associationId },
    });
    expect(keyDisplay.body?.data?.contactDisplayProjection.displayValue).toBe(
      "+12025550178",
    );

    const foreignContact = await fixture.execute({
      jar: foreign.jar,
      query: CONTACT_EDIT_PROJECTION,
      variables: { associationId: contact.associationId },
    });
    expectGraphQLError(foreignContact, "NOT_FOUND");
    const foreignAddress = await fixture.execute({
      jar: foreign.jar,
      query: ADDRESS_EDIT_PROJECTION,
      variables: { associationId: address.associationId },
    });
    expectGraphQLError(foreignAddress, "NOT_FOUND");
  });

  it("archives a phone association and its orphaned ciphertext with optimistic versions", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Archive Phone",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "Archive person was not created",
    );
    const created = await fixture.execute<PhonePayload>({
      jar: actor.jar,
      query: CREATE_PHONE,
      variables: {
        input: {
          personId,
          value: "+12025550199",
          usageKind: "mobile",
          sensitivity: "INTERNAL",
          idempotencyKey: "phone-archive-create",
        },
      },
    });
    const contact = required(
      created.body?.data?.createPhoneContact.contact,
      "Phone was not created",
    );
    const archived = await fixture.execute({
      jar: actor.jar,
      query: ARCHIVE_PHONE,
      variables: {
        input: {
          associationId: contact.associationId,
          expectedVersion: contact.version,
          expectedContactVersion: contact.contactVersion,
          idempotencyKey: "phone-archive-1",
        },
      },
    });
    expect(archived.body?.errors).toBeUndefined();
    const [rawContact] = await fixture.database
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.id, contact.contactPointId));
    expect(rawContact?.deletedAt).toBeInstanceOf(Date);
  });
});
