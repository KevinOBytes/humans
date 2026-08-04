import { describe, expect, it } from "vitest";

import {
  accessControl,
  authorize,
  isWorkspaceRole,
  parseApiKeyPermissionKeys,
  permissionStatements,
  workspaceRoleNames,
  workspaceRoles,
} from "@/modules/auth/permissions";

describe("workspace permissions", () => {
  it("allows contributors to create and update people and facts", () => {
    expect(authorize("contributor", "person", "create")).toBe(true);
    expect(authorize("contributor", "person", "update")).toBe(true);
    expect(authorize("contributor", "fact", "create")).toBe(true);
    expect(authorize("contributor", "fact", "update")).toBe(true);
  });

  it("gives contributors CRUD authority over each research input", () => {
    const resources = [
      "person",
      "fact",
      "relationship",
      "evidence",
      "source",
      "file",
      "import",
      "note",
      "tag",
      "contactPoint",
      "place",
      "address",
    ] as const;

    for (const resource of resources) {
      for (const action of ["create", "read", "update", "delete"] as const) {
        expect(authorize("contributor", resource, action)).toBe(true);
      }
    }
  });

  it("gives readers the new location vocabulary without granting writes", () => {
    for (const resource of ["contactPoint", "place", "address"] as const) {
      expect(authorize("viewer", resource, "read")).toBe(true);
      expect(authorize("analyst", resource, "read")).toBe(true);
      expect(authorize("viewer", resource, "create")).toBe(false);
      expect(authorize("analyst", resource, "delete")).toBe(false);
    }
  });

  it("prevents contributors from managing membership and API keys", () => {
    expect(authorize("contributor", "member", "create")).toBe(false);
    expect(authorize("contributor", "member", "delete")).toBe(false);
    expect(authorize("contributor", "invitation", "create")).toBe(false);
    expect(authorize("contributor", "apiKey", "create")).toBe(false);
  });

  it("allows analysts to read and run analysis without mutating research records", () => {
    expect(authorize("analyst", "person", "read")).toBe(true);
    expect(authorize("analyst", "fact", "read")).toBe(true);
    expect(authorize("analyst", "analysis", "run")).toBe(true);
    expect(authorize("analyst", "search", "run")).toBe(true);
    expect(authorize("analyst", "graph", "run")).toBe(true);
    expect(authorize("analyst", "savedQuery", "run")).toBe(true);
    expect(authorize("analyst", "person", "create")).toBe(false);
    expect(authorize("analyst", "fact", "update")).toBe(false);
  });

  it("keeps viewers read-only", () => {
    expect(authorize("viewer", "person", "read")).toBe(true);
    expect(authorize("viewer", "fact", "read")).toBe(true);
    expect(authorize("viewer", "graph", "read")).toBe(true);
    expect(authorize("viewer", "person", "update")).toBe(false);
    expect(authorize("viewer", "analysis", "run")).toBe(false);
  });

  it("allows operational administration without raw workspace purge", () => {
    expect(authorize("admin", "organization", "update")).toBe(true);
    expect(authorize("admin", "member", "delete")).toBe(true);
    expect(authorize("admin", "invitation", "create")).toBe(true);
    expect(authorize("admin", "apiKey", "delete")).toBe(true);
    expect(authorize("admin", "workspace", "update")).toBe(true);
    expect(authorize("admin", "organization", "delete")).toBe(false);
    expect(authorize("admin", "accessPolicy", "update")).toBe(false);
    expect(authorize("admin", "workspace", "purge")).toBe(false);
    expect(authorize("owner", "workspace", "purge")).toBe(true);
  });

  it("reserves production GraphQL introspection for owners and administrators", () => {
    expect(authorize("owner", "graphql", "introspect")).toBe(true);
    expect(authorize("admin", "graphql", "introspect")).toBe(true);
    expect(authorize("analyst", "graphql", "introspect")).toBe(false);
    expect(authorize("viewer", "graphql", "introspect")).toBe(false);
  });

  it("reserves policy administration and every raw action for owners", () => {
    for (const [resource, actions] of Object.entries(permissionStatements)) {
      for (const action of actions) {
        expect(authorize("owner", resource as never, action as never)).toBe(
          true,
        );
      }
    }

    expect(authorize("owner", "accessPolicy", "update")).toBe(true);
    expect(authorize("owner", "resourceGrant", "delete")).toBe(true);
  });

  it("fails closed for unknown roles, resources, and actions", () => {
    expect(authorize("member" as never, "person", "read")).toBe(false);
    expect(authorize("owner", "unknown" as never, "read")).toBe(false);
    expect(authorize("owner", "person", "unknown" as never)).toBe(false);
    expect(isWorkspaceRole("owner")).toBe(true);
    expect(isWorkspaceRole("owner,admin")).toBe(false);
    expect(isWorkspaceRole("member")).toBe(false);
    expect(isWorkspaceRole("OWNER")).toBe(false);
    expect(isWorkspaceRole(null)).toBe(false);
  });

  it("parses persisted API-key scopes only from the closed vocabulary", () => {
    expect([
      ...parseApiKeyPermissionKeys(JSON.stringify({ person: ["read"] })),
    ]).toEqual(["person:read"]);
    expect(
      parseApiKeyPermissionKeys({ person: ["read"], unknown: ["read"] }).size,
    ).toBe(0);
    expect(parseApiKeyPermissionKeys({ person: ["read", "own"] }).size).toBe(0);
    expect(parseApiKeyPermissionKeys("not-json").size).toBe(0);
  });

  it("uses one statement contract for Better Auth, custom roles, and application checks", () => {
    expect(permissionStatements).toMatchObject({
      organization: ["create", "read", "update", "delete"],
      member: ["create", "read", "update", "delete"],
      invitation: ["create", "read", "cancel"],
      apiKey: ["create", "read", "update", "delete"],
    });
    expect(accessControl.statements).toBe(permissionStatements);
    expect(
      workspaceRoles.contributor.authorize({ fact: ["create", "update"] }),
    ).toEqual({ success: true });
    expect(
      workspaceRoles.contributor.authorize({ apiKey: ["create"] }).success,
    ).toBe(false);
    expect(workspaceRoleNames).toEqual([
      "owner",
      "admin",
      "analyst",
      "contributor",
      "viewer",
    ]);
    expect(Object.keys(workspaceRoles).sort()).toEqual([
      "admin",
      "analyst",
      "contributor",
      "owner",
      "viewer",
    ]);
  });
});
