import type { WorkspaceRole } from "@/modules/auth/permissions";

export type SafeAccountSettings = {
  displayName: string;
  username: string | null;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  globalAdministrator: boolean;
};

export type SafeMemberSettings = {
  displayName: string;
  email: string;
  role: string;
  joinedAt: string;
};

export type SafeInvitationStatus =
  "pending" | "expired" | "accepted" | "rejected" | "canceled";

export type SafeInvitationSettings = {
  email: string;
  role: string;
  status: SafeInvitationStatus;
  createdAt: string;
  expiresAt: string;
};

export type SafeApiKeySettings = {
  name: string;
  fingerprint: string;
  state: "active" | "disabled" | "expired";
  scopes: readonly string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

type AccountSource = {
  name?: string | null;
  username?: string | null;
  email: string;
  emailVerified?: boolean | null;
  twoFactorEnabled?: boolean | null;
  role?: string | null;
};

export function mapAccountSettings(source: AccountSource): SafeAccountSettings {
  return {
    displayName: source.name?.trim() || source.email,
    username: source.username?.trim() || null,
    email: source.email,
    emailVerified: source.emailVerified === true,
    twoFactorEnabled: source.twoFactorEnabled === true,
    globalAdministrator: source.role === "admin",
  };
}

type MemberSource = {
  role: string;
  createdAt: Date | string;
  user: { name: string; email: string };
};

export function mapSafeMember(source: MemberSource): SafeMemberSettings {
  return {
    displayName: source.user.name.trim() || source.user.email,
    email: source.user.email,
    role: source.role,
    joinedAt: new Date(source.createdAt).toISOString(),
  };
}

const terminalInvitationStatuses = new Set<SafeInvitationStatus>([
  "accepted",
  "rejected",
  "canceled",
]);

export function normalizeInvitationStatus(
  status: string,
  expiresAt: Date | string,
  now = new Date(),
): SafeInvitationStatus {
  if (terminalInvitationStatuses.has(status as SafeInvitationStatus)) {
    return status as SafeInvitationStatus;
  }
  if (new Date(expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

type InvitationSource = {
  email: string;
  role: string;
  status: string;
  createdAt: Date | string;
  expiresAt: Date | string;
};

export function mapSafeInvitation(
  source: InvitationSource,
  now = new Date(),
): SafeInvitationSettings {
  return {
    email: source.email,
    role: source.role,
    status: normalizeInvitationStatus(source.status, source.expiresAt, now),
    createdAt: new Date(source.createdAt).toISOString(),
    expiresAt: new Date(source.expiresAt).toISOString(),
  };
}

type ApiKeySource = {
  name?: string | null;
  prefix?: string | null;
  start?: string | null;
  enabled?: boolean | null;
  permissions?: Record<string, readonly string[]> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt?: Date | string | null;
  lastRequest?: Date | string | null;
};

export function mapSafeApiKey(
  source: ApiKeySource,
  now = new Date(),
): SafeApiKeySettings {
  const expiresAt = source.expiresAt
    ? new Date(source.expiresAt).toISOString()
    : null;
  const expired = Boolean(
    source.expiresAt && new Date(source.expiresAt).getTime() <= now.getTime(),
  );
  const scopes = Object.entries(source.permissions ?? {})
    .flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}`),
    )
    .sort();
  const fingerprint = `${source.prefix ?? ""}${source.start ?? ""}`;
  return {
    name: source.name?.trim() || "Unnamed key",
    fingerprint: fingerprint || "Redacted",
    state: expired
      ? "expired"
      : source.enabled === false
        ? "disabled"
        : "active",
    scopes,
    createdAt: new Date(source.createdAt).toISOString(),
    updatedAt: new Date(source.updatedAt).toISOString(),
    expiresAt,
    lastUsedAt: source.lastRequest
      ? new Date(source.lastRequest).toISOString()
      : null,
  };
}

export function canViewWorkspaceAdministration(
  role: WorkspaceRole | string | null | undefined,
): boolean {
  return role === "owner" || role === "admin";
}

export type IntegrationDiagnostic = {
  name: string;
  status: "configured" | "unavailable";
  detail: string;
};

export function buildIntegrationDiagnostics(input: {
  deploymentMode: "docker" | "vercel";
  emailConfigured: boolean;
  databaseConfigured: boolean;
  redisConfigured: boolean;
  storageProvider: "minio" | "r2" | "s3";
  providerBackendAvailable: boolean;
}): readonly IntegrationDiagnostic[] {
  const storageLabel =
    input.storageProvider === "minio"
      ? "MinIO"
      : input.storageProvider === "r2"
        ? "R2"
        : "S3";
  return [
    {
      name: "Email",
      status: input.emailConfigured ? "configured" : "unavailable",
      detail: input.emailConfigured
        ? "Delivery configured"
        : "Delivery not configured",
    },
    {
      name: "Database",
      status: input.databaseConfigured ? "configured" : "unavailable",
      detail: input.databaseConfigured
        ? "PostgreSQL configured"
        : "PostgreSQL not configured",
    },
    {
      name: "Redis",
      status: input.redisConfigured ? "configured" : "unavailable",
      detail: input.redisConfigured
        ? "Redis configured"
        : "Redis not configured",
    },
    {
      name: "Object storage",
      status: "configured",
      detail: `${storageLabel} configured`,
    },
    {
      name: "AI provider",
      status: input.providerBackendAvailable ? "configured" : "unavailable",
      detail: input.providerBackendAvailable
        ? "Provider backend available"
        : "Unavailable until Task 13",
    },
  ];
}
