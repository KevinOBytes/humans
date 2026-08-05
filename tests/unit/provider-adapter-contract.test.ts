import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { redisConnectionConfig } from "@/lib/redis";
import { objectStoreConfig } from "@/lib/storage/s3";

const PROVIDER_SDK_IMPORT =
  /(?:from\s*|import\s*\()\s*["']((?:@upstash\/redis|ioredis|@aws-sdk\/(?:client-s3|s3-request-presigner)|@smithy\/node-http-handler|openai|ollama|@ai-sdk\/[^"']+))["']/gu;

const allowedProviderSdkImports = new Map<string, readonly string[]>([
  ["@upstash/redis", ["src/lib/redis/index.ts"]],
  ["ioredis", ["src/lib/redis/index.ts"]],
  ["@aws-sdk/client-s3", ["src/lib/storage/proxy.ts", "src/lib/storage/s3.ts"]],
  ["@aws-sdk/s3-request-presigner", ["src/lib/storage/s3.ts"]],
  ["@smithy/node-http-handler", ["src/lib/storage/s3.ts"]],
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function providerSdkImports(root = "src"): Array<{
  path: string;
  specifier: string;
}> {
  return sourceFiles(root).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(PROVIDER_SDK_IMPORT)].map((match) => ({
      path: relative(process.cwd(), path),
      specifier: match[1],
    }));
  });
}

describe("provider adapter architecture", () => {
  it("keeps concrete Redis and S3 SDK imports at declared adapter entry points", () => {
    const imports = providerSdkImports();

    for (const entry of imports) {
      expect(allowedProviderSdkImports.get(entry.specifier)).toContain(
        entry.path,
      );
    }

    expect(imports).toEqual(
      expect.arrayContaining([
        { path: "src/lib/redis/index.ts", specifier: "@upstash/redis" },
        { path: "src/lib/redis/index.ts", specifier: "ioredis" },
        { path: "src/lib/storage/s3.ts", specifier: "@aws-sdk/client-s3" },
        {
          path: "src/lib/storage/proxy.ts",
          specifier: "@aws-sdk/client-s3",
        },
        {
          path: "src/lib/storage/s3.ts",
          specifier: "@aws-sdk/s3-request-presigner",
        },
      ]),
    );
  });

  it("prohibits AI SDK imports because the AI adapter uses the raw HTTP transport", () => {
    const aiSdkImports = providerSdkImports().filter((entry) =>
      /^(?:openai|ollama|@ai-sdk\/)/u.test(entry.specifier),
    );

    expect(aiSdkImports).toEqual([]);
  });

  it("keeps all production domain modules independent from concrete provider SDKs", () => {
    expect(providerSdkImports("src/modules")).toEqual([]);
  });

  it("selects the direct local or Upstash REST Redis adapter without leaking Redis credentials", () => {
    expect(
      redisConnectionConfig({
        url: "redis://:local-password@redis.internal:6379/0",
      }),
    ).toEqual({
      provider: "local",
      url: "redis://:local-password@redis.internal:6379/0",
    });
    expect(
      redisConnectionConfig({
        url: "rediss://default:redis-password@careful-owl.upstash.io:6379",
        token: "upstash-rest-token",
      }),
    ).toEqual({
      provider: "upstash",
      url: "https://careful-owl.upstash.io",
      token: "upstash-rest-token",
    });
  });

  it("selects one S3-compatible mode for MinIO, R2, and generic S3", () => {
    expect(
      objectStoreConfig({
        endpoint: "http://minio.internal:9000",
        provider: "minio",
        forcePathStyle: false,
      }),
    ).toEqual({
      endpoint: "http://minio.internal:9000",
      forcePathStyle: true,
    });
    expect(
      objectStoreConfig({
        endpoint: "https://account.r2.cloudflarestorage.com",
        provider: "r2",
      }),
    ).toEqual({
      endpoint: "https://account.r2.cloudflarestorage.com",
      forcePathStyle: false,
    });
    expect(
      objectStoreConfig({
        endpoint: "https://s3.us-east-1.amazonaws.com",
        provider: "s3",
      }),
    ).toEqual({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      forcePathStyle: false,
    });
  });
});
