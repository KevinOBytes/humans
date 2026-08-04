import { createAccessControl } from "better-auth/plugins/access";

/**
 * The complete base permission vocabulary shared by Better Auth and Humans.
 * Record-level policies may only narrow these grants; they must never add a
 * permission that is absent from the caller's workspace role.
 */
export const permissionStatements = {
  organization: ["create", "read", "update", "delete"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "read", "cancel"],
  apiKey: ["create", "read", "update", "delete"],
  workspace: ["create", "read", "update", "purge"],
  accessPolicy: ["create", "read", "update", "delete"],
  resourceGrant: ["create", "read", "update", "delete"],
  person: ["create", "read", "update", "delete", "merge"],
  contactPoint: ["create", "read", "update", "delete"],
  place: ["create", "read", "update", "delete"],
  address: ["create", "read", "update", "delete"],
  fact: ["create", "read", "update", "delete", "supersede", "select"],
  relationship: ["create", "read", "update", "delete"],
  evidence: ["create", "read", "update", "delete"],
  source: ["create", "read", "update", "delete"],
  file: ["create", "read", "update", "delete"],
  import: ["create", "read", "update", "delete", "run"],
  note: ["create", "read", "update", "delete"],
  tag: ["create", "read", "update", "delete"],
  search: ["read", "run"],
  graph: ["read", "run"],
  savedQuery: ["create", "read", "update", "delete", "run"],
  graphView: ["create", "read", "update", "delete", "run"],
  analysis: ["create", "read", "run", "cancel", "delete"],
  audit: ["read"],
  webhook: ["create", "read", "update", "delete"],
  graphql: ["introspect"],
} as const;

export type PermissionResource = keyof typeof permissionStatements;

export type PermissionAction = {
  [
    Resource in PermissionResource
  ]: (typeof permissionStatements)[Resource][number];
}[PermissionResource];

export type PermissionKey = `${PermissionResource}:${PermissionAction}`;

/** Parses Better Auth's object (or persisted JSON string) into the closed
 * permission vocabulary. Unknown resources and actions fail closed. */
export function parseApiKeyPermissionKeys(
  value: unknown,
): ReadonlySet<PermissionKey> {
  let material = value;
  if (typeof material === "string") {
    try {
      material = JSON.parse(material) as unknown;
    } catch {
      return new Set<PermissionKey>();
    }
  }
  const result = new Set<PermissionKey>();
  if (!material || typeof material !== "object" || Array.isArray(material)) {
    return result;
  }
  const statements = material as Record<string, unknown>;
  for (const [resource, requested] of Object.entries(statements)) {
    if (
      !Object.hasOwn(permissionStatements, resource) ||
      !Array.isArray(requested)
    ) {
      return new Set<PermissionKey>();
    }
    const allowed = permissionStatements[
      resource as PermissionResource
    ] as readonly string[];
    if (
      requested.some(
        (action) => typeof action !== "string" || !allowed.includes(action),
      )
    ) {
      return new Set<PermissionKey>();
    }
    for (const action of requested) {
      result.add(`${resource}:${String(action)}` as PermissionKey);
    }
  }
  return result;
}

export const workspaceRoleNames = [
  "owner",
  "admin",
  "analyst",
  "contributor",
  "viewer",
] as const;

export type WorkspaceRole = (typeof workspaceRoleNames)[number];

export const accessControl = createAccessControl(permissionStatements);

const researchReads = {
  workspace: ["read"],
  person: ["read"],
  contactPoint: ["read"],
  place: ["read"],
  address: ["read"],
  fact: ["read"],
  relationship: ["read"],
  evidence: ["read"],
  source: ["read"],
  file: ["read"],
  import: ["read"],
  note: ["read"],
  tag: ["read"],
  search: ["read"],
  graph: ["read"],
  savedQuery: ["read"],
  graphView: ["read"],
  analysis: ["read"],
} as const;

const researchWrites = {
  person: ["create", "read", "update", "delete", "merge"],
  contactPoint: ["create", "read", "update", "delete"],
  place: ["create", "read", "update", "delete"],
  address: ["create", "read", "update", "delete"],
  fact: ["create", "read", "update", "delete", "supersede", "select"],
  relationship: ["create", "read", "update", "delete"],
  evidence: ["create", "read", "update", "delete"],
  source: ["create", "read", "update", "delete"],
  file: ["create", "read", "update", "delete"],
  import: ["create", "read", "update", "delete", "run"],
  note: ["create", "read", "update", "delete"],
  tag: ["create", "read", "update", "delete"],
} as const;

const analysisOperations = {
  search: ["read", "run"],
  graph: ["read", "run"],
  savedQuery: ["create", "read", "update", "delete", "run"],
  graphView: ["create", "read", "update", "delete", "run"],
  analysis: ["create", "read", "run", "cancel", "delete"],
} as const;

const adminStatements = {
  organization: ["read", "update"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "read", "cancel"],
  apiKey: ["create", "read", "update", "delete"],
  workspace: ["read", "update"],
  accessPolicy: ["read"],
  resourceGrant: ["read"],
  ...researchWrites,
  ...analysisOperations,
  audit: ["read"],
  webhook: ["create", "read", "update", "delete"],
  graphql: ["introspect"],
} as const;

export const workspaceRoles = {
  owner: accessControl.newRole(permissionStatements),
  admin: accessControl.newRole(adminStatements),
  analyst: accessControl.newRole({
    ...researchReads,
    ...analysisOperations,
  }),
  contributor: accessControl.newRole({
    workspace: ["read"],
    ...researchWrites,
    search: ["read"],
    graph: ["read"],
    savedQuery: ["read"],
    graphView: ["read"],
    analysis: ["read"],
  }),
  viewer: accessControl.newRole(researchReads),
} as const;

// Short aliases keep the same values available for Better Auth server and
// client configuration without introducing a second authorization contract.
export const ac = accessControl;
export const roles = workspaceRoles;

const workspaceRoleSet: ReadonlySet<string> = new Set(workspaceRoleNames);

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && workspaceRoleSet.has(value);
}

export function authorize(
  role: WorkspaceRole,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  if (
    !isWorkspaceRole(role) ||
    typeof resource !== "string" ||
    typeof action !== "string" ||
    !Object.hasOwn(permissionStatements, resource)
  ) {
    return false;
  }

  const roleStatements = workspaceRoles[role].statements as Readonly<
    Record<string, readonly string[] | undefined>
  >;

  if (!Object.hasOwn(roleStatements, resource)) {
    return false;
  }

  const allowedActions = roleStatements[resource];
  return Array.isArray(allowedActions) && allowedActions.includes(action);
}

export function parsePermissionKey(value: unknown):
  | {
      action: PermissionAction;
      key: PermissionKey;
      resource: PermissionResource;
    }
  | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator !== value.lastIndexOf(":")) return undefined;
  const resource = value.slice(0, separator);
  const action = value.slice(separator + 1);
  if (!Object.hasOwn(permissionStatements, resource)) return undefined;
  const canonicalResource = resource as PermissionResource;
  const actions = permissionStatements[canonicalResource] as readonly string[];
  if (!actions.includes(action)) return undefined;
  return {
    action: action as PermissionAction,
    key: value as PermissionKey,
    resource: canonicalResource,
  };
}

export function rolePermissionKeys(
  role: WorkspaceRole,
): ReadonlySet<PermissionKey> {
  const result = new Set<PermissionKey>();
  for (const resource of Object.keys(
    permissionStatements,
  ) as PermissionResource[]) {
    for (const action of permissionStatements[resource]) {
      if (authorize(role, resource, action)) {
        result.add(`${resource}:${action}` as PermissionKey);
      }
    }
  }
  return result;
}
