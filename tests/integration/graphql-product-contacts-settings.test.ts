// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import {
  CancelWorkspaceInvitationDocument,
  AddressEditProjectionDocument,
  ContactEditProjectionDocument,
  CreateOrganizationApiKeyDocument,
  CreatePersonAddressDocument,
  CreatePersonContactDocument,
  CreatePlaceDocument,
  IssueWorkspaceInvitationDocument,
  RemoveWorkspaceMemberDocument,
  ResendWorkspaceInvitationDocument,
  PersonLocationsDocument,
  SettingsAuditEventsDocument,
  SettingsOrganizationApiKeysDocument,
  SettingsPolicyPostureDocument,
  SettingsWorkspaceDirectoryDocument,
  UpdatePersonContactDocument,
  UpdateWorkspaceMemberRoleDocument,
} from "@/graphql/generated/graphql";
import { authEmailOutbox } from "@/db/schema/auth-email-outbox";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing generated ${label}`);
  return value;
}

liveDescribe(
  "generated contacts, locations, and settings product inventory",
  () => {
    let fixture: ResearchFixture;

    beforeAll(() => {
      fixture = new ResearchFixture();
    });
    beforeEach(async () => fixture.reset());
    afterAll(async () => fixture.close());

    it("creates and reads back protected contacts, places, and addresses with bounded failures", async () => {
      const owner = await fixture.createActor();
      const foreign = await fixture.createActor();
      const person = await fixture.createPerson(owner, {
        displayName: "Generated location subject",
      });
      const personId = required(
        person.body?.data?.createPerson?.person?.id,
        "person ID",
      );
      const phone = "+1 804 555 0171";
      const line1 = "171 Generated Matrix Lane";

      const createdContact = await fixture.execute<{
        createPersonContact: {
          code: string | null;
          contact: {
            associationId: string;
            contactVersion: number;
            displayValue: string;
            version: number;
          } | null;
          issues: unknown[];
        };
      }>({
        jar: owner.jar,
        operationName: "CreatePersonContact",
        query: CreatePersonContactDocument,
        variables: {
          input: {
            idempotencyKey: crypto.randomUUID(),
            kind: "PHONE",
            personId,
            sensitivity: "INTERNAL",
            usageKind: "personal",
            value: phone,
          },
        },
      });
      expect(createdContact.body?.errors).toBeUndefined();
      expect(createdContact.body?.data?.createPersonContact).toMatchObject({
        code: null,
        issues: [],
      });
      const contact = required(
        createdContact.body?.data?.createPersonContact.contact,
        "contact",
      );

      const createdPlace = await fixture.execute<{
        createPlace: {
          code: string | null;
          issues: unknown[];
          place: { id: string } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "CreatePlace",
        query: CreatePlaceDocument,
        variables: {
          input: {
            countryCode: "US",
            idempotencyKey: crypto.randomUUID(),
            kind: "locality",
            locality: "Richmond",
            name: "Richmond generated place",
            region: "VA",
            sensitivity: "INTERNAL",
          },
        },
      });
      expect(createdPlace.body?.errors).toBeUndefined();
      const placeId = required(
        createdPlace.body?.data?.createPlace.place?.id,
        "place ID",
      );

      const createdAddress = await fixture.execute<{
        createPersonAddress: {
          address: {
            addressVersion: number;
            associationId: string;
            line1: string | null;
            version: number;
          } | null;
          code: string | null;
          issues: unknown[];
        };
      }>({
        jar: owner.jar,
        operationName: "CreatePersonAddress",
        query: CreatePersonAddressDocument,
        variables: {
          input: {
            addressKind: "residence",
            countryCode: "US",
            idempotencyKey: crypto.randomUUID(),
            line1,
            locality: "Richmond",
            personId,
            placeId,
            postalCode: "23219",
            region: "VA",
            sensitivity: "INTERNAL",
          },
        },
      });
      expect(createdAddress.body?.errors).toBeUndefined();
      const address = required(
        createdAddress.body?.data?.createPersonAddress.address,
        "address",
      );

      const locations = await fixture.execute<{
        person: {
          addresses: { nodes: Array<{ associationId: string; line1: string }> };
          contacts: {
            nodes: Array<{ associationId: string; displayValue: string }>;
          };
        } | null;
      }>({
        jar: owner.jar,
        operationName: "PersonLocations",
        query: PersonLocationsDocument,
        variables: { first: 10, id: personId },
      });
      expect(locations.body?.errors).toBeUndefined();
      expect(locations.body?.data?.person?.contacts.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            associationId: contact.associationId,
            displayValue: phone,
          }),
        ]),
      );
      expect(locations.body?.data?.person?.addresses.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            associationId: address.associationId,
            line1,
          }),
        ]),
      );

      const contactProjection = await fixture.execute<{
        contactEditProjection: {
          associationId: string;
          displayValue: string;
        } | null;
      }>({
        jar: owner.jar,
        operationName: "ContactEditProjection",
        query: ContactEditProjectionDocument,
        variables: { associationId: contact.associationId },
      });
      const addressProjection = await fixture.execute<{
        addressEditProjection: {
          associationId: string;
          line1: string | null;
        } | null;
      }>({
        jar: owner.jar,
        operationName: "AddressEditProjection",
        query: AddressEditProjectionDocument,
        variables: { associationId: address.associationId },
      });
      expect(contactProjection.body?.data?.contactEditProjection).toMatchObject(
        {
          associationId: contact.associationId,
          displayValue: phone,
        },
      );
      expect(addressProjection.body?.data?.addressEditProjection).toMatchObject(
        {
          associationId: address.associationId,
          line1,
        },
      );

      const updatedPhone = "+1 804 555 0172";
      const updated = await fixture.execute<{
        updatePersonContact: {
          code: string | null;
          contact: {
            associationId: string;
            contactVersion: number;
            displayValue: string;
            version: number;
          } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "UpdatePersonContact",
        query: UpdatePersonContactDocument,
        variables: {
          input: {
            associationId: contact.associationId,
            expectedContactVersion: contact.contactVersion,
            expectedVersion: contact.version,
            idempotencyKey: crypto.randomUUID(),
            value: updatedPhone,
          },
        },
      });
      expect(updated.body?.errors).toBeUndefined();
      expect(updated.body?.data?.updatePersonContact).toMatchObject({
        code: null,
        contact: {
          associationId: contact.associationId,
          displayValue: updatedPhone,
        },
      });
      const updatedContact = required(
        updated.body?.data?.updatePersonContact.contact,
        "updated contact",
      );
      const updatedProjection = await fixture.execute<{
        contactEditProjection: { displayValue: string } | null;
      }>({
        jar: owner.jar,
        operationName: "ContactEditProjection",
        query: ContactEditProjectionDocument,
        variables: { associationId: contact.associationId },
      });
      expect(
        updatedProjection.body?.data?.contactEditProjection?.displayValue,
      ).toBe(updatedPhone);

      const stale = await fixture.execute<{
        updatePersonContact: {
          code: string | null;
          contact: unknown;
          currentVersion: number | null;
        };
      }>({
        jar: owner.jar,
        operationName: "UpdatePersonContact",
        query: UpdatePersonContactDocument,
        variables: {
          input: {
            associationId: contact.associationId,
            expectedContactVersion: updatedContact.contactVersion,
            expectedVersion: updatedContact.version + 100,
            idempotencyKey: crypto.randomUUID(),
            label: "stale update",
          },
        },
      });
      expect(stale.body?.errors).toBeUndefined();
      expect(stale.body?.data?.updatePersonContact).toMatchObject({
        code: "CONFLICT",
        contact: null,
        currentVersion: updatedContact.version,
      });

      const readOnlyKey = await fixture.provisionKey(owner, {
        address: ["read"],
        contactPoint: ["read"],
        person: ["read"],
        place: ["read"],
      });
      const keyRead = await fixture.execute({
        apiKey: readOnlyKey.key,
        operationName: "PersonLocations",
        origin: null,
        query: PersonLocationsDocument,
        variables: { first: 10, id: personId },
      });
      expect(keyRead.body?.errors).toBeUndefined();
      expectGraphQLError(
        await fixture.execute({
          apiKey: readOnlyKey.key,
          operationName: "CreatePersonContact",
          origin: null,
          query: CreatePersonContactDocument,
          variables: {
            input: {
              idempotencyKey: crypto.randomUUID(),
              kind: "PHONE",
              personId,
              usageKind: "personal",
              value: "+1 804 555 0199",
            },
          },
        }),
        "FORBIDDEN",
      );

      const foreignLocations = await fixture.execute({
        jar: foreign.jar,
        operationName: "PersonLocations",
        query: PersonLocationsDocument,
        variables: { first: 10, id: personId },
      });
      expect(foreignLocations.body?.errors).toBeUndefined();
      expect(foreignLocations.body?.data).toEqual({ person: null });
      expectGraphQLError(
        await fixture.execute({
          jar: foreign.jar,
          operationName: "ContactEditProjection",
          query: ContactEditProjectionDocument,
          variables: { associationId: contact.associationId },
        }),
        "NOT_FOUND",
      );
      expectGraphQLError(
        await fixture.execute({
          jar: foreign.jar,
          operationName: "AddressEditProjection",
          query: AddressEditProjectionDocument,
          variables: { associationId: address.associationId },
        }),
        "NOT_FOUND",
      );
      expect(JSON.stringify(foreignLocations.body)).not.toContain(phone);
      expect(JSON.stringify(foreignLocations.body)).not.toContain(updatedPhone);
      expect(JSON.stringify(foreignLocations.body)).not.toContain(line1);
    });

    it("administers members, invitations, API keys, policy, and safe audit through generated documents", async () => {
      const owner = await fixture.createActor();
      const viewer = await fixture.createWorkspaceMember(owner, "viewer");
      const foreign = await fixture.createActor();
      const invitationEmail = "generated.invitee@example.test";

      const policy = await fixture.execute({
        jar: owner.jar,
        operationName: "SettingsPolicyPosture",
        query: SettingsPolicyPostureDocument,
      });
      expect(policy.body?.errors).toBeUndefined();
      expect(policy.body?.data).toHaveProperty("settingsPolicyPosture");

      const updatedRole = await fixture.execute<{
        updateWorkspaceMemberRole: {
          actionId: string | null;
          code: string;
        };
      }>({
        jar: owner.jar,
        operationName: "UpdateWorkspaceMemberRole",
        query: UpdateWorkspaceMemberRoleDocument,
        variables: {
          input: {
            actionId: viewer.memberId,
            idempotencyKey: crypto.randomUUID(),
            role: "CONTRIBUTOR",
          },
        },
      });
      expect(updatedRole.body?.data?.updateWorkspaceMemberRole).toMatchObject({
        actionId: viewer.memberId,
        code: "APPLIED",
      });

      const invitation = await fixture.execute<{
        issueWorkspaceInvitation: {
          actionId: string | null;
          code: string;
        };
      }>({
        jar: owner.jar,
        operationName: "IssueWorkspaceInvitation",
        query: IssueWorkspaceInvitationDocument,
        variables: {
          input: {
            email: `  ${invitationEmail.toUpperCase()}  `,
            idempotencyKey: crypto.randomUUID(),
            role: "VIEWER",
          },
        },
      });
      expect(invitation.body?.data?.issueWorkspaceInvitation).toMatchObject({
        actionId: expect.any(String),
        code: "APPLIED",
      });

      const directory = await fixture.execute<{
        settingsWorkspaceDirectory: {
          invitations: Array<{ email: string; status: string }>;
          members: { nodes: Array<{ actionId: string; role: string }> };
        };
      }>({
        jar: owner.jar,
        operationName: "SettingsWorkspaceDirectory",
        query: SettingsWorkspaceDirectoryDocument,
        variables: { offset: 0 },
      });
      expect(directory.body?.errors).toBeUndefined();
      expect(
        directory.body?.data?.settingsWorkspaceDirectory.members.nodes,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: viewer.memberId,
            role: "CONTRIBUTOR",
          }),
        ]),
      );
      expect(
        directory.body?.data?.settingsWorkspaceDirectory.invitations,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            email: invitationEmail,
            status: "PENDING",
          }),
        ]),
      );
      const invitationId = required(
        invitation.body?.data?.issueWorkspaceInvitation.actionId,
        "invitation action ID",
      );
      const initialDeliveryIntents = await fixture.database
        .select({
          encryptedPayload: authEmailOutbox.encryptedPayload,
          id: authEmailOutbox.id,
          state: authEmailOutbox.state,
        })
        .from(authEmailOutbox)
        .where(eq(authEmailOutbox.invitationId, invitationId));
      expect(initialDeliveryIntents).toHaveLength(1);
      expect(initialDeliveryIntents[0]?.encryptedPayload).toEqual(
        expect.any(String),
      );
      expect(JSON.stringify(initialDeliveryIntents)).not.toContain(
        invitationEmail,
      );

      const createdKey = await fixture.execute<{
        createOrganizationApiKey: {
          actionId: string | null;
          code: string;
          requestId: string;
          secret: string | null;
        };
      }>({
        jar: owner.jar,
        operationName: "CreateOrganizationApiKey",
        query: CreateOrganizationApiKeyDocument,
        variables: {
          input: {
            expiresInSeconds: 86_400,
            name: "Generated inventory key",
            scopes: ["person:read", "fact:read"],
          },
        },
      });
      expect(createdKey.body?.data?.createOrganizationApiKey).toMatchObject({
        actionId: expect.any(String),
        code: "APPLIED",
        requestId: expect.any(String),
        secret: expect.stringMatching(/^hum_/u),
      });
      const key = required(
        createdKey.body?.data?.createOrganizationApiKey,
        "API-key result",
      );

      const keys = await fixture.execute<{
        settingsOrganizationApiKeys: {
          nodes: Array<{
            actionId: string;
            name: string;
            scopes: string[];
            state: string;
          }>;
        };
      }>({
        jar: owner.jar,
        operationName: "SettingsOrganizationApiKeys",
        query: SettingsOrganizationApiKeysDocument,
        variables: { offset: 0 },
      });
      expect(keys.body?.data?.settingsOrganizationApiKeys.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: key.actionId,
            name: "Generated inventory key",
            scopes: ["fact:read", "person:read"],
            state: "active",
          }),
        ]),
      );

      const audit = await fixture.execute<{
        auditEvents: {
          nodes: Array<{
            action: string;
            requestId: string | null;
          }>;
        };
      }>({
        jar: owner.jar,
        operationName: "SettingsAuditEvents",
        query: SettingsAuditEventsDocument,
        variables: {
          filter: { action: "settings.api_key.create" },
          first: 10,
        },
      });
      expect(audit.body?.errors).toBeUndefined();
      expect(audit.body?.data?.auditEvents.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "settings.api_key.create",
            requestId: key.requestId,
          }),
        ]),
      );

      expectGraphQLError(
        await fixture.execute({
          jar: viewer.jar,
          operationName: "SettingsWorkspaceDirectory",
          query: SettingsWorkspaceDirectoryDocument,
          variables: { offset: 0 },
        }),
        "FORBIDDEN",
      );
      expectGraphQLError(
        await fixture.execute({
          jar: viewer.jar,
          operationName: "CreateOrganizationApiKey",
          query: CreateOrganizationApiKeyDocument,
          variables: {
            input: { name: "Denied", scopes: ["person:read"] },
          },
        }),
        "FORBIDDEN",
      );

      const foreignResend = await fixture.execute<{
        resendWorkspaceInvitation: { actionId: string | null; code: string };
      }>({
        jar: foreign.jar,
        operationName: "ResendWorkspaceInvitation",
        query: ResendWorkspaceInvitationDocument,
        variables: {
          input: {
            actionId: invitationId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      });
      expect(foreignResend.body?.data?.resendWorkspaceInvitation).toEqual(
        expect.objectContaining({ actionId: null, code: "UNCHANGED" }),
      );
      const foreignCancel = await fixture.execute<{
        cancelWorkspaceInvitation: { actionId: string | null; code: string };
      }>({
        jar: foreign.jar,
        operationName: "CancelWorkspaceInvitation",
        query: CancelWorkspaceInvitationDocument,
        variables: {
          input: {
            actionId: invitationId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      });
      expect(foreignCancel.body?.data?.cancelWorkspaceInvitation).toEqual(
        expect.objectContaining({ actionId: null, code: "UNCHANGED" }),
      );
      const foreignRemoval = await fixture.execute<{
        removeWorkspaceMember: { actionId: string | null; code: string };
      }>({
        jar: foreign.jar,
        operationName: "RemoveWorkspaceMember",
        query: RemoveWorkspaceMemberDocument,
        variables: {
          input: {
            actionId: viewer.memberId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      });
      expect(foreignRemoval.body?.data?.removeWorkspaceMember).toEqual(
        expect.objectContaining({ actionId: null, code: "FORBIDDEN" }),
      );

      const resent = await fixture.execute<{
        resendWorkspaceInvitation: { actionId: string | null; code: string };
      }>({
        jar: owner.jar,
        operationName: "ResendWorkspaceInvitation",
        query: ResendWorkspaceInvitationDocument,
        variables: {
          input: {
            actionId: invitationId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      });
      expect(resent.body?.data?.resendWorkspaceInvitation).toMatchObject({
        actionId: invitationId,
        code: "APPLIED",
      });
      const resentDeliveryIntents = await fixture.database
        .select({
          encryptedPayload: authEmailOutbox.encryptedPayload,
          id: authEmailOutbox.id,
          state: authEmailOutbox.state,
        })
        .from(authEmailOutbox)
        .where(eq(authEmailOutbox.invitationId, invitationId));
      expect(resentDeliveryIntents).toHaveLength(2);
      expect(
        resentDeliveryIntents.every(
          (intent) => intent.encryptedPayload.length > 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(resentDeliveryIntents)).not.toContain(
        invitationEmail,
      );
      expect(resentDeliveryIntents.map((intent) => intent.id)).toEqual(
        expect.arrayContaining([initialDeliveryIntents[0].id]),
      );
      expect(resentDeliveryIntents.map((intent) => intent.id)).not.toEqual([
        initialDeliveryIntents[0].id,
      ]);

      const canceled = await fixture.execute<{
        cancelWorkspaceInvitation: { actionId: string | null; code: string };
      }>({
        jar: owner.jar,
        operationName: "CancelWorkspaceInvitation",
        query: CancelWorkspaceInvitationDocument,
        variables: {
          input: {
            actionId: invitationId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      });
      expect(canceled.body?.data?.cancelWorkspaceInvitation).toMatchObject({
        actionId: invitationId,
        code: "APPLIED",
      });

      const afterCancelDirectory = await fixture.execute<{
        settingsWorkspaceDirectory: {
          invitations: Array<{ actionId: string }>;
          members: { nodes: Array<{ actionId: string }> };
        };
      }>({
        jar: owner.jar,
        operationName: "SettingsWorkspaceDirectory",
        query: SettingsWorkspaceDirectoryDocument,
        variables: { offset: 0 },
      });
      expect(afterCancelDirectory.body?.errors).toBeUndefined();
      expect(
        afterCancelDirectory.body?.data?.settingsWorkspaceDirectory,
      ).toEqual(
        expect.objectContaining({
          invitations: expect.any(Array),
          members: expect.objectContaining({ nodes: expect.any(Array) }),
        }),
      );
      expect(
        afterCancelDirectory.body?.data?.settingsWorkspaceDirectory.invitations,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionId: invitationId }),
        ]),
      );

      const removed = await fixture.execute<{
        removeWorkspaceMember: { actionId: string | null; code: string };
      }>({
        jar: owner.jar,
        operationName: "RemoveWorkspaceMember",
        query: RemoveWorkspaceMemberDocument,
        variables: {
          input: {
            actionId: viewer.memberId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      });
      expect(removed.body?.data?.removeWorkspaceMember).toMatchObject({
        actionId: viewer.memberId,
        code: "APPLIED",
      });
      const afterRemovalDirectory = await fixture.execute<{
        settingsWorkspaceDirectory: {
          members: { nodes: Array<{ actionId: string }> };
        };
      }>({
        jar: owner.jar,
        operationName: "SettingsWorkspaceDirectory",
        query: SettingsWorkspaceDirectoryDocument,
        variables: { offset: 0 },
      });
      expect(afterRemovalDirectory.body?.errors).toBeUndefined();
      expect(
        afterRemovalDirectory.body?.data?.settingsWorkspaceDirectory,
      ).toEqual(
        expect.objectContaining({
          members: expect.objectContaining({ nodes: expect.any(Array) }),
        }),
      );
      expect(
        afterRemovalDirectory.body?.data?.settingsWorkspaceDirectory.members
          .nodes,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionId: viewer.memberId }),
        ]),
      );

      const foreignDirectory = await fixture.execute<{
        settingsWorkspaceDirectory: {
          invitations: Array<{ actionId: string }>;
          members: { nodes: Array<{ actionId: string }> };
        };
      }>({
        jar: foreign.jar,
        operationName: "SettingsWorkspaceDirectory",
        query: SettingsWorkspaceDirectoryDocument,
        variables: { offset: 0 },
      });
      expect(foreignDirectory.body?.errors).toBeUndefined();
      expect(foreignDirectory.body?.data?.settingsWorkspaceDirectory).toEqual(
        expect.objectContaining({
          invitations: expect.any(Array),
          members: expect.objectContaining({ nodes: expect.any(Array) }),
        }),
      );
      const serialized = JSON.stringify({
        audit: audit.body,
        directory: directory.body,
        foreignDirectory: foreignDirectory.body,
        keys: keys.body,
        logs: fixture.capturedLogs,
      });
      expect(serialized).not.toContain(key.secret ?? "unavailable-secret");
      const serializedForeignDirectory = JSON.stringify(foreignDirectory.body);
      expect(serializedForeignDirectory).not.toContain(invitationEmail);
      expect(serializedForeignDirectory).not.toContain(invitationId);
      expect(serializedForeignDirectory).not.toContain(viewer.memberId);
      expect(serializedForeignDirectory).not.toContain(
        key.actionId ?? "unavailable-action",
      );
      expect(serialized).not.toContain(owner.workspaceId);
      expect(serialized).not.toContain(owner.organizationId);
    });
  },
);
