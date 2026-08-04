import { createHmac, timingSafeEqual } from "node:crypto";

const ACTION_ID_PREFIX = "ak_";
const ACTION_ID_PATTERN = /^ak_[A-Za-z0-9_-]{43}$/u;

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
