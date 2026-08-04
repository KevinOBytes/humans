// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { users } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import {
  SettingsAccessError,
  listSafeWorkspaceDirectory,
} from "@/modules/settings/administration";

import { authRequest, testAdminEnv } from "../support/auth";
import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function headersFor(jar: { apply(headers: Headers): void }): Headers {
  const headers = new Headers({
    origin: new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin,
  });
  jar.apply(headers);
  return headers;
}

const POLICY_SETTINGS = /* GraphQL */ `
  query SettingsPolicyPosture {
    settingsPolicyPosture {
      workspace {
        name
        locale
        timezone
        defaultRetentionDays
        aiEnabled
        storageEnabled
      }
      accessPolicies {
        name
        state
        sensitivityCeiling
        resourceKinds
      }
      retentionPolicies {
        resourceKind
        retentionDays
        deletionBehavior
      }
    }
  }
`;

const SAFE_AUDIT = /* GraphQL */ `
  query SafeAudit(
    $first: Int!
    $after: String
    $filter: AuditEventFilterInput
  ) {
    auditEvents(first: $first, after: $after, filter: $filter) {
      nodes {
        action
        resourceKind
        requestId
        outcome
        occurredAt
        actor {
          kind
          label
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

const API_KEYS = /* GraphQL */ `
  query SettingsOrganizationApiKeys($offset: Int) {
    settingsOrganizationApiKeys(offset: $offset) {
      nodes {
        name
        fingerprint
        state
        scopes
        createdAt
        updatedAt
        expiresAt
        lastUsedAt
      }
      offset
      limit
      total
      hasPrevious
      hasMore
    }
  }
`;

liveDescribe("settings GraphQL trust boundary", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture();
    await fixture.reset();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("accepts owner and admin sessions but rejects an API-key principal", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const key = await fixture.provisionKey(owner, {
      workspace: ["read"],
      accessPolicy: ["read"],
    });

    for (const jar of [owner.jar, admin.jar]) {
      const result = await fixture.execute<{
        settingsPolicyPosture?: { workspace?: { name?: string } };
      }>({ jar, query: POLICY_SETTINGS });
      expect(result.status).toBe(200);
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.settingsPolicyPosture?.workspace?.name).toEqual(
        expect.any(String),
      );
      expect(result.headers.get("cache-control")).toMatch(/no-store/iu);
    }

    const denied = await fixture.execute({
      apiKey: key.key,
      query: POLICY_SETTINGS,
    });
    expect(denied.status).toBe(200);
    expectGraphQLError(denied, "FORBIDDEN");
    expect(JSON.stringify(denied.body)).not.toContain(key.key);
  });

  it("keeps session, GraphQL, and public Better Auth reads tenant-bound", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const foreignOwner = await fixture.createActor();
    await fixture.provisionKey(owner, { person: ["read"] });
    const foreignKey = await fixture.provisionKey(foreignOwner, {
      person: ["read"],
    });

    for (const actor of [owner, admin]) {
      await expect(
        listSafeWorkspaceDirectory({
          auth: fixture.runtime,
          headers: headersFor(actor.jar),
        }),
      ).resolves.toMatchObject({ members: { total: 3 } });
      const keys = await fixture.execute<{
        settingsOrganizationApiKeys?: { total?: number };
      }>({ jar: actor.jar, query: API_KEYS, variables: { offset: 0 } });
      expect(keys.body?.errors).toBeUndefined();
      expect(keys.body?.data?.settingsOrganizationApiKeys?.total).toBe(1);
    }
    for (const read of [
      listSafeWorkspaceDirectory({
        auth: fixture.runtime,
        headers: headersFor(viewer.jar),
      }),
    ]) {
      await expect(read).rejects.toBeInstanceOf(SettingsAccessError);
    }
    const viewerKeys = await fixture.execute({
      jar: viewer.jar,
      query: API_KEYS,
      variables: { offset: 0 },
    });
    expectGraphQLError(viewerKeys, "FORBIDDEN");

    const forbiddenSwitch = await authRequest(
      fixture.runtime.handler,
      "/api/auth/organization/set-active",
      {
        body: { organizationId: foreignOwner.organizationId },
        jar: owner.jar,
      },
    );
    expect(forbiddenSwitch.status).toBe(403);
    const session = await fixture.runtime.api.getSession({
      headers: headersFor(owner.jar),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(session?.session.activeOrganizationId).not.toBe(
      foreignOwner.organizationId,
    );
    const restore = await authRequest(
      fixture.runtime.handler,
      "/api/auth/organization/set-active",
      {
        body: { organizationId: owner.organizationId },
        jar: owner.jar,
      },
    );
    expect(restore.status).toBe(200);

    const policy = await fixture.execute<{
      settingsPolicyPosture?: { workspace?: { name?: string } };
    }>({ jar: owner.jar, query: POLICY_SETTINGS });
    const foreignPolicy = await fixture.execute<{
      settingsPolicyPosture?: { workspace?: { name?: string } };
    }>({ jar: foreignOwner.jar, query: POLICY_SETTINGS });
    const directory = await listSafeWorkspaceDirectory({
      auth: fixture.runtime,
      headers: headersFor(owner.jar),
    });
    const keys = await fixture.execute({
      jar: owner.jar,
      query: API_KEYS,
      variables: { offset: 0 },
    });
    const serialized = JSON.stringify({ policy: policy.body, directory, keys });
    const [foreignUser] = await fixture.database
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, foreignOwner.userId));
    expect(serialized).not.toContain(foreignOwner.organizationId);
    expect(serialized).not.toContain(foreignOwner.workspaceId);
    expect(serialized).not.toContain(foreignKey.key);
    expect(serialized).not.toContain(foreignKey.id);
    expect(serialized).not.toContain(foreignUser!.email);
    expect(serialized).not.toContain(foreignUser!.name);
    expect(policy.body?.data?.settingsPolicyPosture?.workspace?.name).not.toBe(
      foreignPolicy.body?.data?.settingsPolicyPosture?.workspace?.name,
    );
  });

  it("pages and filters the safe audit handler response without raw fields", async () => {
    const owner = await fixture.createActor();
    const rawSecret = "raw-diff-secret-must-not-cross";
    const privateResourceId = newId();
    await fixture.database.insert(auditEvents).values([
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        actorUserId: owner.userId,
        action: "settings.earlier",
        resourceKind: "workspace",
        resourceId: privateResourceId,
        requestId: "settings-request-earlier",
        redactedDiff: { raw: rawSecret },
        outcome: "success",
        occurredAt: new Date("2026-08-03T12:30:00.000Z"),
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        actorUserId: owner.userId,
        action: "settings.later",
        resourceKind: "workspace",
        resourceId: privateResourceId,
        requestId: "settings-request-later",
        redactedDiff: { raw: rawSecret },
        outcome: "failure",
        occurredAt: new Date("2026-08-03T13:30:00.000Z"),
      },
    ]);

    const first = await fixture.execute<{
      auditEvents?: {
        nodes?: Array<{ action?: string }>;
        pageInfo?: { endCursor?: string; hasNextPage?: boolean };
      };
    }>({
      jar: owner.jar,
      query: SAFE_AUDIT,
      variables: {
        first: 1,
        filter: {
          occurredFrom: "2026-08-03T12:00:00.000Z",
          occurredUntil: "2026-08-03T14:00:00.000Z",
        },
      },
    });
    expect(first.body?.data?.auditEvents?.nodes).toEqual([
      expect.objectContaining({ action: "settings.later" }),
    ]);
    expect(first.body?.data?.auditEvents?.pageInfo?.hasNextPage).toBe(true);
    const cursor = first.body?.data?.auditEvents?.pageInfo?.endCursor;
    expect(cursor).toEqual(expect.any(String));

    const second = await fixture.execute<{
      auditEvents?: { nodes?: unknown[] };
    }>({
      jar: owner.jar,
      query: SAFE_AUDIT,
      variables: {
        first: 1,
        after: cursor,
        filter: {
          occurredFrom: "2026-08-03T12:00:00.000Z",
          occurredUntil: "2026-08-03T14:00:00.000Z",
        },
      },
    });
    expect(second.body?.data?.auditEvents?.nodes).toEqual([
      expect.objectContaining({ action: "settings.earlier" }),
    ]);
    const serialized = JSON.stringify([first.body, second.body]);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(privateResourceId);
    expect(serialized).not.toMatch(/redactedDiff|resourceId|principalId/iu);

    const invalid = await fixture.execute({
      jar: owner.jar,
      query: SAFE_AUDIT,
      variables: {
        first: 1,
        filter: { occurredFrom: "2026-08-03T12:00" },
      },
    });
    expectGraphQLError(invalid, "VALIDATION_FAILED");
  });
});
