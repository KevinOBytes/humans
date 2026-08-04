import { describe, expect, it } from "vitest";

import {
  apiKeyActionId,
  isApiKeyActionId,
  matchesApiKeyActionId,
} from "@/modules/settings/api-key-action-id";

describe("opaque API-key action identifiers", () => {
  const secret = "a".repeat(32);
  const workspaceId = "019893aa-99a0-7000-8000-000000000001";
  const apiKeyId = "api-key-storage-id";

  it("is stable, opaque, and bound to one workspace and storage record", () => {
    const actionId = apiKeyActionId({ apiKeyId, secret, workspaceId });

    expect(actionId).toMatch(/^ak_[A-Za-z0-9_-]{43}$/u);
    expect(actionId).not.toContain(apiKeyId);
    expect(actionId).not.toContain(workspaceId);
    expect(apiKeyActionId({ apiKeyId, secret, workspaceId })).toBe(actionId);
    expect(
      apiKeyActionId({
        apiKeyId,
        secret,
        workspaceId: "019893aa-99a0-7000-8000-000000000002",
      }),
    ).not.toBe(actionId);
  });

  it("rejects malformed and cross-record action identifiers", () => {
    const actionId = apiKeyActionId({ apiKeyId, secret, workspaceId });

    expect(isApiKeyActionId(actionId)).toBe(true);
    expect(isApiKeyActionId("api-key-storage-id")).toBe(false);
    expect(
      matchesApiKeyActionId({ actionId, apiKeyId, secret, workspaceId }),
    ).toBe(true);
    expect(
      matchesApiKeyActionId({
        actionId,
        apiKeyId: "other-api-key-storage-id",
        secret,
        workspaceId,
      }),
    ).toBe(false);
  });
});
