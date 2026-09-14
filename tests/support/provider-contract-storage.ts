import type { ObjectStoreProvider } from "@/lib/storage/s3";

export async function ensureProviderContractBucket(input: {
  provider: ObjectStoreProvider;
  headBucket(): Promise<void>;
  createBucket(): Promise<void>;
}): Promise<void> {
  try {
    await input.headBucket();
  } catch (error) {
    const candidate = error as {
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
      $response?: { statusCode?: unknown };
    };
    const statusCode =
      candidate.$metadata?.httpStatusCode ?? candidate.$response?.statusCode;
    const missingBucket =
      statusCode === 404 ||
      candidate.name === "NotFound" ||
      candidate.name === "NoSuchBucket";

    if (!missingBucket)
      throw new Error("provider contract bucket reachability failed");
    if (input.provider !== "minio")
      throw new Error(
        "external storage provider contract requires a pre-provisioned approved bucket",
      );
    await input.createBucket();
  }
}

export async function withProviderContractObjectCleanup<T>(input: {
  run(): Promise<T>;
  cleanup(): Promise<void>;
}): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  try {
    try {
      result = await input.run();
    } catch (error) {
      operationError = error;
    }
  } finally {
    try {
      await input.cleanup();
    } catch {
      throw new Error(
        operationError
          ? "provider contract operation failed and object cleanup failed"
          : "provider contract object cleanup failed",
      );
    }
  }

  if (operationError) throw operationError;
  return result as T;
}
