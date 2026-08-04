import { readFileSync } from "node:fs";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env/server-schema";
import { redisConnectionConfig } from "@/lib/redis";
import {
  S3ObjectStore,
  objectStoreConfig,
  s3ClientConfig,
} from "@/lib/storage/s3";

function composeService(source: string, name: string): string {
  return (
    source.match(
      new RegExp(
        `^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z-]*:|(?![\\s\\S]))`,
        "m",
      ),
    )?.[0] ?? ""
  );
}

function exampleEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    readFileSync(".env.example", "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  ) as NodeJS.ProcessEnv;
}

describe("objectStoreConfig", () => {
  it("uses path-style access for MinIO", () => {
    expect(
      objectStoreConfig({ endpoint: "http://minio:9000", provider: "minio" })
        .forcePathStyle,
    ).toBe(true);
    expect(
      objectStoreConfig({
        endpoint: "http://minio:9000",
        provider: "minio",
        forcePathStyle: false,
      }).forcePathStyle,
    ).toBe(true);
  });

  it("uses virtual-hosted access for R2 and generic S3 by default", () => {
    expect(
      objectStoreConfig({
        endpoint: "https://account.r2.cloudflarestorage.com",
        provider: "r2",
      }).forcePathStyle,
    ).toBe(false);
    expect(
      objectStoreConfig({
        endpoint: "https://s3.us-east-1.amazonaws.com",
        provider: "s3",
      }).forcePathStyle,
    ).toBe(false);
  });

  it("maps an ambiguous object 404 without a bucket probe", async () => {
    const calls: string[] = [];
    let checkedKey: unknown;
    const client = {
      send: async (command: { input?: { Key?: unknown } }) => {
        calls.push(command.constructor.name);
        if (command.constructor.name === "HeadObjectCommand") {
          checkedKey = command.input?.Key;
          throw Object.assign(new Error("not found"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return {};
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore(client, "humans-private");

    await expect(
      store.exists({ workspaceId: "workspace-a", key: "health/probe" }),
    ).resolves.toBe(false);
    expect(calls).toEqual(["HeadObjectCommand"]);
    expect(checkedKey).toBe("workspaces/workspace-a/health/probe");
  });

  it.each([
    ["missing bucket", "NoSuchBucket", 404],
    ["invalid endpoint", "ENOTFOUND", undefined],
    ["authorization", "AccessDenied", 403],
    ["timeout", "TimeoutError", undefined],
    ["server failure", "InternalError", 503],
  ])(
    "rejects %s failures from the object operation",
    async (_, name, status) => {
      const error = Object.assign(new Error(name), {
        name,
        ...(status === undefined
          ? {}
          : { $metadata: { httpStatusCode: status } }),
      });
      const calls: string[] = [];
      const client = {
        send: async (command: object) => {
          calls.push(command.constructor.name);
          throw error;
        },
      } as unknown as S3Client;
      const store = new S3ObjectStore(client, "humans-private");

      await expect(
        store.exists({ workspaceId: "workspace-a", key: "health/probe" }),
      ).rejects.toBe(error);
      expect(calls).toEqual(["HeadObjectCommand"]);
    },
  );

  it("bounds S3 attempts and transport deadlines", () => {
    const config = s3ClientConfig({
      endpoint: "http://minio:9000",
      provider: "minio",
    });

    expect(config.maxAttempts).toBe(2);
    expect(config.requestHandler).toBeDefined();
  });

  it("rejects invalid direct-presign constraints before contacting S3", async () => {
    const client = {
      send: async () => {
        throw new Error("S3 should not be contacted");
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore(client, "humans-private");

    await expect(
      store.createUpload({
        workspaceId: "workspace-a",
        key: "file.txt",
        contentType: "text/plain",
        bytes: 4,
        checksumSha256: "invalid",
      }),
    ).rejects.toThrow("Invalid upload constraints");
    await expect(
      store.createDownload({
        workspaceId: "workspace-a",
        key: "file.txt",
        fileName: "unsafe\r\nname.txt",
      }),
    ).rejects.toThrow("Invalid file name");
  });
});

describe("redisConnectionConfig", () => {
  it("uses a direct Redis connection when no Upstash token is present", () => {
    expect(
      redisConnectionConfig({
        url: "redis://:local-password@redis:6379",
      }),
    ).toEqual({
      provider: "local",
      url: "redis://:local-password@redis:6379",
    });
  });

  it("derives a credential-free HTTPS endpoint for Upstash REST", () => {
    const result = redisConnectionConfig({
      url: "rediss://default:redis-password@careful-owl-12345.upstash.io:6379",
      token: "upstash-rest-token",
    });

    expect(result).toEqual({
      provider: "upstash",
      url: "https://careful-owl-12345.upstash.io",
      token: "upstash-rest-token",
    });
    expect(result.url).not.toContain("redis-password");
  });
});

describe("container configuration", () => {
  it("uses digest-pinned Node 24 builder and Distroless runtime images", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const compose = readFileSync("docker-compose.yml", "utf8");

    expect(dockerfile).toContain(
      "node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573",
    );
    expect(dockerfile).toContain(
      "gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212",
    );
    expect(dockerfile).toContain("COPY --from=build --chown=65532:65532");
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node"]');
    expect(dockerfile).toContain('CMD ["server.js"]');
    expect(dockerfile).not.toContain(
      "COPY --from=build --chown=node:node /app /app",
    );
    expect(dockerfile.split(/FROM .* AS runtime\n/u)[1]).not.toMatch(
      /\b(?:corepack|npm|pnpm|yarn)\b/iu,
    );
    for (const service of [
      "app",
      "migrate",
      "seed",
      "worker",
      "postgres",
      "redis",
      "minio",
      "minio-init",
    ]) {
      expect(compose).toMatch(new RegExp(`^  ${service}:`, "m"));
    }
    expect(composeService(compose, "postgres")).not.toContain("\n    ports:");
    expect(composeService(compose, "redis")).not.toContain("\n    ports:");
    expect(composeService(compose, "minio")).not.toContain("\n    ports:");
    expect(compose).toContain("AI_PROVIDER: ${AI_PROVIDER:-ollama}");
    expect(composeService(compose, "seed")).toContain(
      'ALLOW_DATABASE_SEED: "true"',
    );
    expect(composeService(compose, "seed")).toContain('profiles: ["seed"]');
    expect(readFileSync("next.config.ts", "utf8")).toContain(
      'output: "standalone"',
    );
  });

  it("requires secrets instead of committing shared Compose defaults", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");

    for (const secret of [
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "AUTH_SECRET",
      "AUTH_ENCRYPTION_KEY",
      "DATA_ENCRYPTION_KEY",
      "PROTECTED_LOOKUP_HMAC_KEY",
      "OPERATION_LIMIT_HMAC_KEY",
      "RESEND_API_KEY",
    ]) {
      expect(compose).toContain(`\${${secret}:?`);
      expect(compose).not.toMatch(new RegExp(`\\$\\{${secret}:-`));
    }
    expect(compose).toContain(
      "TRUSTED_PROXY_MODE: ${TRUSTED_PROXY_MODE:-none}",
    );
    expect(compose).toContain(
      "TRUSTED_PROXY_HMAC_KEY: ${TRUSTED_PROXY_HMAC_KEY:-}",
    );
    expect(composeService(compose, "bootstrap-admin")).toContain(
      "ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}",
    );
  });

  it("rejects the public Compose fixture under production validation", () => {
    expect(() =>
      parseServerEnv({
        ...exampleEnvironment(),
        NODE_ENV: "production",
        AUTH_SECURE_COOKIES: "true",
      }),
    ).toThrow(/documentation|example|default|pattern/i);
  });

  it("keeps base data persistent and replaces it with tmpfs in tests", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const testCompose = readFileSync("docker-compose.test.yml", "utf8");

    expect(compose).toContain("postgres-data:");
    expect(compose).toContain("redis-data:");
    expect(compose).toContain("minio-data:");
    expect(composeService(compose, "postgres")).toMatch(
      /postgres-data:\/var\/lib\/postgresql\s*$/m,
    );
    expect(testCompose).toMatch(/target: \/var\/lib\/postgresql\s*$/m);
    expect(testCompose.match(/type: tmpfs/g)).toHaveLength(3);
  });

  it("configures and verifies community MinIO's cluster-wide CORS setting", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const init = readFileSync("docker/minio-init.sh", "utf8");

    expect(composeService(compose, "minio")).toContain(
      "MINIO_API_CORS_ALLOW_ORIGIN",
    );
    expect(init).toContain("mc admin config get");
    expect(init).toContain("MINIO_CORS_ALLOW_ORIGIN");
  });

  it("keeps Ollama opt-in", () => {
    const compose = readFileSync("docker-compose.ollama.yml", "utf8");

    expect(compose).toContain('profiles: ["ollama"]');
    expect(compose).toMatch(/^  ollama:/m);
    expect(compose).toMatch(/^  ollama-init:/m);
  });

  it("bounds and hardens every long-running service", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");

    for (const service of ["postgres", "redis", "minio"]) {
      const source = composeService(compose, service);
      expect(source).toContain("init: true");
      expect(source).toContain("stop_grace_period:");
      expect(source).toContain("pids_limit:");
      expect(source).toContain("mem_limit:");
      expect(source).toContain("cpus:");
      expect(source).toContain("no-new-privileges:true");
      expect(source).toContain("max-size:");
      expect(source).toContain("max-file:");
    }

    expect(compose).toMatch(/^x-app-service:[\s\S]*?read_only: true/m);
    expect(compose).toMatch(/^x-app-service:[\s\S]*?cap_drop:\n    - ALL/m);
    expect(composeService(compose, "worker")).toContain("healthcheck:");
    expect(composeService(compose, "worker")).toContain(
      "worker-healthcheck.mjs",
    );
    expect(readFileSync("docker-compose.test.yml", "utf8")).toMatch(
      /^  smoke:/m,
    );
  });
});
