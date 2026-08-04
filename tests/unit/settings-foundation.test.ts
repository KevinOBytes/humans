import { describe, expect, it } from "vitest";

import {
  buildIntegrationDiagnostics,
  canViewWorkspaceAdministration,
  mapAccountSettings,
  mapSafeApiKey,
  mapSafeInvitation,
  mapSafeMember,
  normalizeInvitationStatus,
} from "@/modules/settings/read-model";

describe("safe settings read models", () => {
  it("projects only current-user account fields", () => {
    const source = {
      id: "user-secret-id",
      name: "Ada Owner",
      username: "ada",
      email: "ada@example.test",
      emailVerified: true,
      twoFactorEnabled: true,
      role: "admin",
      token: "raw-session-token",
    };
    const value = mapAccountSettings(source);

    expect(value).toEqual({
      displayName: "Ada Owner",
      username: "ada",
      email: "ada@example.test",
      emailVerified: true,
      twoFactorEnabled: true,
      globalAdministrator: true,
    });
    expect(JSON.stringify(value)).not.toMatch(/secret|token|user-secret-id/u);
  });

  it("normalizes expired invitations and omits action-capable identifiers", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    expect(
      normalizeInvitationStatus(
        "pending",
        new Date("2026-08-03T11:59:59.000Z"),
        now,
      ),
    ).toBe("expired");

    const source = {
      id: "action-capable-invitation-id",
      organizationId: "private-organization-id",
      inviterId: "private-user-id",
      email: "invitee@example.test",
      role: "viewer",
      status: "pending",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-03T11:59:59.000Z"),
    };
    const invitation = mapSafeInvitation(source, now);

    expect(invitation).toEqual({
      email: "invitee@example.test",
      role: "viewer",
      status: "expired",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-03T11:59:59.000Z",
    });
    expect(JSON.stringify(invitation)).not.toMatch(
      /action-capable|private-organization|private-user/u,
    );
  });

  it("redacts member and organization-key records", () => {
    const memberSource = {
      id: "member-id",
      organizationId: "organization-id",
      userId: "user-id",
      role: "admin",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      user: {
        id: "user-id",
        name: "Grace Admin",
        email: "grace@example.test",
      },
    };
    const member = mapSafeMember(memberSource);
    const apiKeySource = {
      id: "key-id",
      configId: "organization",
      referenceId: "organization-id",
      name: "Reporting",
      prefix: "hum_",
      start: "abc123",
      key: "raw-key-must-not-cross",
      enabled: true,
      permissions: { fact: ["read"], person: ["read"] },
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      expiresAt: null,
      lastRequest: null,
    };
    const apiKey = mapSafeApiKey(
      apiKeySource,
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(member).toEqual({
      displayName: "Grace Admin",
      email: "grace@example.test",
      role: "admin",
      joinedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(apiKey).toEqual({
      name: "Reporting",
      fingerprint: "hum_abc123",
      state: "active",
      scopes: ["fact:read", "person:read"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(JSON.stringify([member, apiKey])).not.toMatch(
      /member-id|organization-id|user-id|key-id|raw-key-must-not-cross/u,
    );
  });

  it("limits workspace administration reads to owner and admin", () => {
    expect(canViewWorkspaceAdministration("owner")).toBe(true);
    expect(canViewWorkspaceAdministration("admin")).toBe(true);
    expect(canViewWorkspaceAdministration("analyst")).toBe(false);
    expect(canViewWorkspaceAdministration("contributor")).toBe(false);
    expect(canViewWorkspaceAdministration("viewer")).toBe(false);
  });

  it("builds configuration-only diagnostics without contacting dependencies", () => {
    const diagnostics = buildIntegrationDiagnostics({
      deploymentMode: "docker",
      emailConfigured: true,
      storageProvider: "minio",
      redisConfigured: true,
      databaseConfigured: true,
      providerBackendAvailable: false,
    });

    expect(diagnostics).toEqual([
      { name: "Email", status: "configured", detail: "Delivery configured" },
      {
        name: "Database",
        status: "configured",
        detail: "PostgreSQL configured",
      },
      { name: "Redis", status: "configured", detail: "Redis configured" },
      {
        name: "Object storage",
        status: "configured",
        detail: "MinIO configured",
      },
      {
        name: "AI provider",
        status: "unavailable",
        detail: "Unavailable until Task 13",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /postgres(?:ql)?:\/\/|redis(?:s)?:\/\/|api[_-]?key|secret|endpoint/iu,
    );
  });
});
