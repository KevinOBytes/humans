import { describe, expect, it, vi } from "vitest";

import {
  ensureProviderContractBucket,
  withProviderContractObjectCleanup,
} from "../support/provider-contract-storage";

async function externalBucketValidator() {
  return import("../../scripts/provider-contract-storage-config.mjs");
}

describe("external storage provider contract harness", () => {
  it("rejects non-contract and application buckets before any provider client is used", async () => {
    const { validateExternalStorageContractBucket } =
      await externalBucketValidator();
    const endpoint = "https://private.example.test";
    const secret = "external-storage-secret-that-must-not-escape";

    for (const input of [
      { bucket: "humans-private", storageBucket: "humans-app" },
      { bucket: "humans-contract-private", storageBucket: "humans-app" },
      {
        bucket: "humans-contract-application",
        storageBucket: "humans-app",
      },
      {
        bucket: "humans-contract-shared",
        storageBucket: "humans-contract-shared",
      },
    ]) {
      let error: unknown;
      try {
        validateExternalStorageContractBucket({
          bucket: input.bucket,
          provider: "r2",
          storageBucket: input.storageBucket,
        });
      } catch (candidate) {
        error = candidate;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "external storage provider contract requires an isolated contract-test bucket",
      );
      expect((error as Error).message).not.toContain(input.bucket);
      expect((error as Error).message).not.toContain(endpoint);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("preserves local MinIO bucket compatibility while approving an isolated external bucket", async () => {
    const { validateExternalStorageContractBucket } =
      await externalBucketValidator();

    expect(
      validateExternalStorageContractBucket({
        bucket: "humans-provider-contract",
        provider: "minio",
        storageBucket: "humans-private",
      }),
    ).toBe("humans-provider-contract");
    expect(
      validateExternalStorageContractBucket({
        bucket: "humans-contract-r2-acceptance",
        provider: "r2",
        storageBucket: "humans-private",
      }),
    ).toBe("humans-contract-r2-acceptance");
  });

  it("requires a pre-provisioned R2 or S3 bucket without creating one", async () => {
    const createBucket = vi.fn(async () => undefined);

    await expect(
      ensureProviderContractBucket({
        provider: "r2",
        headBucket: async () => {
          throw Object.assign(new Error("missing"), {
            name: "NoSuchBucket",
            $metadata: { httpStatusCode: 404 },
          });
        },
        createBucket,
      }),
    ).rejects.toThrow(/pre-provisioned approved bucket/);
    expect(createBucket).not.toHaveBeenCalled();
  });

  it("may create a missing bucket only for isolated MinIO", async () => {
    const createBucket = vi.fn(async () => undefined);

    await ensureProviderContractBucket({
      provider: "minio",
      headBucket: async () => {
        throw Object.assign(new Error("missing"), {
          name: "NoSuchBucket",
          $metadata: { httpStatusCode: 404 },
        });
      },
      createBucket,
    });

    expect(createBucket).toHaveBeenCalledOnce();
  });

  it("cleans the generated object after success and after an assertion failure", async () => {
    const successCleanup = vi.fn(async () => undefined);
    await expect(
      withProviderContractObjectCleanup({
        run: async () => "complete",
        cleanup: successCleanup,
      }),
    ).resolves.toBe("complete");
    expect(successCleanup).toHaveBeenCalledOnce();

    const failureCleanup = vi.fn(async () => undefined);
    await expect(
      withProviderContractObjectCleanup({
        run: async () => {
          throw new Error("contract assertion failed");
        },
        cleanup: failureCleanup,
      }),
    ).rejects.toThrow("contract assertion failed");
    expect(failureCleanup).toHaveBeenCalledOnce();
  });

  it("surfaces cleanup failure with a redacted stable error", async () => {
    const secret = "storage-secret-that-must-not-escape";
    let error: unknown;
    try {
      await withProviderContractObjectCleanup({
        run: async () => {
          throw new Error("contract assertion failed");
        },
        cleanup: async () => {
          throw new Error(secret);
        },
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "provider contract operation failed and object cleanup failed",
    );
    expect((error as Error).message).not.toContain(secret);
  });
});
