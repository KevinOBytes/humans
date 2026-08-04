import { describe, expect, it } from "vitest";

import { ApplicationProxyObjectStore } from "@/lib/storage/proxy";
import type { ObjectStore } from "@/lib/storage/types";

const delegate = {
  checkReachability: async () => undefined,
  createDownload: async () => {
    throw new Error("not used");
  },
  createUpload: async () => {
    throw new Error("not used");
  },
  delete: async () => undefined,
  exists: async () => false,
  getMetadata: async () => null,
  openRead: async () => null,
} satisfies ObjectStore;

describe("local opaque storage grants", () => {
  it("keeps workspace, object key, and token out of the URL", async () => {
    const store = new ApplicationProxyObjectStore(
      delegate,
      "https://humans.example",
      "ab".repeat(32),
      () => 1_000,
    );
    const grant = await store.createUpload({
      bytes: 4,
      checksumSha256: "a".repeat(64),
      contentType: "text/plain",
      key: "uploads/01900000-0000-7000-8000-000000000001/opaque",
      workspaceId: "01900000-0000-7000-8000-000000000002",
    });
    expect(grant.url).toBe("https://humans.example/api/storage/objects");
    expect(grant.url).not.toContain("uploads");
    expect(grant.headers.authorization).toMatch(
      /^StorageGrant [A-Za-z0-9_.-]+$/u,
    );
    expect(grant.expiresAt.getTime()).toBe(301_000);
  });
});
