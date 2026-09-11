import { createHmac, timingSafeEqual } from "node:crypto";

const ACTION_ID_PREFIX = "ak_";
const ACTION_ID_PATTERN = /^ak_[A-Za-z0-9_-]{43}$/u;

export type ApiKeySecurityState = Readonly<{
  enabled: boolean;
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
  workspaceId: string;
  requestWorkspaceId: string;
  scopes: readonly string[];
  requiredScopes?: readonly string[];
  rateLimit?: { remaining: number; resetAt: Date | string } | null;
  now?: Date;
}>;

export type ApiKeySecurityDecision = Readonly<{
  allowed: boolean;
  code:
    | "ok"
    | "disabled"
    | "expired"
    | "revoked"
    | "tenant_mismatch"
    | "scope_denied"
    | "rate_limited";
  retryAt?: string;
}>;

function parsedDate(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Fail-closed authorization for API-key backed operations. */
export function evaluateApiKeySecurity(
  state: ApiKeySecurityState,
): ApiKeySecurityDecision {
  const now = (state.now ?? new Date()).getTime();
  if (!state.enabled) return { allowed: false, code: "disabled" };
  const expiresAt = parsedDate(state.expiresAt);
  if (expiresAt != null && expiresAt <= now)
    return { allowed: false, code: "expired" };
  if (parsedDate(state.revokedAt) != null)
    return { allowed: false, code: "revoked" };
  if (!state.workspaceId || state.workspaceId !== state.requestWorkspaceId)
    return { allowed: false, code: "tenant_mismatch" };
  const scopes = new Set(state.scopes);
  if ((state.requiredScopes ?? []).some((scope) => !scopes.has(scope)))
    return { allowed: false, code: "scope_denied" };
  if (state.rateLimit && state.rateLimit.remaining <= 0)
    return {
      allowed: false,
      code: "rate_limited",
      retryAt: new Date(state.rateLimit.resetAt).toISOString(),
    };
  return { allowed: true, code: "ok" };
}

export function parseApiKeyScopes(value: unknown): readonly string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/u)
      : [];
  const scopes = [
    ...new Set(
      entries
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.normalize("NFKC").trim())
        .filter((item) => /^[a-z][a-z0-9:_-]{1,96}$/u.test(item)),
    ),
  ];
  return scopes.sort();
}

/**
 * A stable, tenant-bound handle for the settings UI. This deliberately never
 * contains an API-key, organization, or database identifier.
 */
export function apiKeyActionId(input: {
  apiKeyId: string;
  secret: string;
  workspaceId: string;
}): string {
  return `${ACTION_ID_PREFIX}${createHmac("sha256", input.secret)
    .update(
      `humans:settings:api-key-action:v1:${input.workspaceId}:${input.apiKeyId}`,
      "utf8",
    )
    .digest("base64url")}`;
}

export function isApiKeyActionId(value: unknown): value is string {
  return typeof value === "string" && ACTION_ID_PATTERN.test(value);
}

export function matchesApiKeyActionId(input: {
  actionId: string;
  apiKeyId: string;
  secret: string;
  workspaceId: string;
}): boolean {
  if (!isApiKeyActionId(input.actionId)) return false;
  const expected = apiKeyActionId(input);
  return timingSafeEqual(
    Buffer.from(input.actionId, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}
