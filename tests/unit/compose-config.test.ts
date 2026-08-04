// @vitest-environment node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

function syntheticSecret(label: string): string {
  return createHash("sha256").update(`humans-compose-${label}`).digest("hex");
}

const syntheticEnvironment = {
  ...process.env,
  POSTGRES_PASSWORD: "Pg!8sK2vQ9mL4tR7xN5c",
  REDIS_PASSWORD: "Redis!3hF8kT2wM7pQ9sD",
  MINIO_ROOT_USER: "compose-contract-access",
  MINIO_ROOT_PASSWORD: "Minio!7qL2vN9sK4xP8dF",
  AUTH_SECRET: syntheticSecret("auth"),
  AUTH_ENCRYPTION_KEY: syntheticSecret("auth-encryption"),
  DATA_ENCRYPTION_KEY: syntheticSecret("data-encryption"),
  PROTECTED_LOOKUP_HMAC_KEY: syntheticSecret("protected-lookup"),
  OPERATION_LIMIT_HMAC_KEY: syntheticSecret("operation-limit"),
  ADMIN_EMAIL: "admin@example.test",
  ADMIN_USERNAME: "humans-admin",
  ADMIN_DISPLAY_NAME: "Humans Administrator",
  ADMIN_PASSWORD: "Admin!8vK3pN7sQ2xL5dR",
  RESEND_API_KEY: `re_test_${syntheticSecret("resend").slice(0, 24)}`,
};

type ComposeService = {
  cap_drop?: string[];
  command?: string[];
  cpus?: number;
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string>;
  healthcheck?: { start_interval?: string; test?: string[] };
  image?: string;
  init?: boolean;
  logging?: { options?: Record<string, string> };
  mem_limit?: string;
  networks?: Record<string, null>;
  pids_limit?: number;
  ports?: Array<{ host_ip?: string; published?: string; target: number }>;
  read_only?: boolean;
  restart?: string;
  security_opt?: string[];
  stop_grace_period?: string;
  tmpfs?: string[];
  volumes?: Array<{ source?: string; target: string; type: string }>;
  user?: string;
};

type ComposeConfig = {
  networks: Record<string, { internal?: boolean }>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

function render(
  files: string[],
  profile?: string,
  environment: NodeJS.ProcessEnv = syntheticEnvironment,
): ComposeConfig {
  const arguments_ = ["compose", "--project-name", "humans-contract"];
  for (const file of files) arguments_.push("--file", file);
  if (profile) arguments_.push("--profile", profile);
  arguments_.push("config", "--format", "json");
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`Compose configuration failed with exit ${result.status}`);
  }
  return JSON.parse(result.stdout) as ComposeConfig;
}

function publishedPorts(config: ComposeConfig) {
  return Object.entries(config.services).flatMap(([service, definition]) =>
    (definition.ports ?? []).map((port) => ({ service, ...port })),
  );
}

describe("rendered Compose configuration contract", () => {
  it("keeps durable backends private and publishes only the app by default", () => {
    const config = render(["docker-compose.yml"]);

    expect(config.services.postgres?.image).toMatch(/^postgres:18\./u);
    expect(config.services.redis?.image).toBe("redis:8.6.1");
    expect(config.services.redis?.command?.join(" ")).toContain(
      "--appendonly yes --requirepass",
    );
    expect(config.services.minio?.volumes?.[0]?.target).toBe("/data");
    expect(config.services["minio-init"]?.restart).toBe("no");
    expect(config.services.migrate?.restart).toBe("no");
    expect(config.networks.backend?.internal).toBe(true);
    expect(publishedPorts(config)).toEqual([
      expect.objectContaining({
        host_ip: "127.0.0.1",
        service: "app",
        target: 3000,
      }),
    ]);
    expect(config.services.ollama).toBeUndefined();
    expect(config.services.app?.environment?.AI_PROVIDER).toBe("ollama");
    expect(config.services.app?.depends_on).toMatchObject({
      migrate: { condition: "service_completed_successfully" },
      redis: { condition: "service_healthy" },
      minio: { condition: "service_healthy" },
      "minio-init": { condition: "service_completed_successfully" },
    });
    expect(config.services.worker?.depends_on).toMatchObject({
      migrate: { condition: "service_completed_successfully" },
      redis: { condition: "service_healthy" },
      "minio-init": { condition: "service_completed_successfully" },
    });
  }, 15_000);

  it("applies bounded controls without making durable service roots read-only", () => {
    const config = render(["docker-compose.yml"]);

    for (const name of ["postgres", "redis", "minio", "app", "worker"]) {
      const service = config.services[name];
      expect(service?.init).toBe(true);
      expect(service?.restart).toBe("unless-stopped");
      expect(service?.stop_grace_period).toMatch(/^\d+s$/u);
      expect(service?.pids_limit).toBeGreaterThan(0);
      expect(Number(service?.mem_limit)).toBeGreaterThan(0);
      expect(service?.cpus).toBeGreaterThan(0);
      expect(service?.security_opt).toContain("no-new-privileges:true");
      expect(service?.logging?.options).toMatchObject({
        "max-file": expect.any(String),
        "max-size": expect.any(String),
      });
      expect(service?.healthcheck?.start_interval).toMatch(/^\d+s$/u);
    }
    for (const name of ["postgres", "redis", "minio"]) {
      expect(config.services[name]?.read_only).not.toBe(true);
    }
    for (const name of ["app", "worker"]) {
      expect(config.services[name]?.read_only).toBe(true);
      expect(config.services[name]?.cap_drop).toContain("ALL");
      expect(config.services[name]?.tmpfs?.join(" ")).toContain("/tmp");
    }
    expect(config.services.worker?.healthcheck?.test).toContain(
      "/app/docker/worker-healthcheck.mjs",
    );
    expect(config.services.app?.healthcheck?.test?.[0]).toBe("CMD");
    expect(config.services.app?.healthcheck?.test?.[1]).toBe(
      "/nodejs/bin/node",
    );
    expect(config.services.worker?.healthcheck?.test?.[1]).toBe(
      "/nodejs/bin/node",
    );
    expect(config.services.app?.tmpfs?.join(" ")).toContain("uid=65532");
    expect(config.services.app?.tmpfs?.join(" ")).toContain("gid=65532");
  });

  it("uses isolated tmpfs plus the reviewed authenticated smoke in tests", () => {
    const config = render(
      ["docker-compose.yml", "docker-compose.test.yml"],
      "smoke",
    );

    for (const name of ["postgres", "redis", "minio"]) {
      expect(config.services[name]?.volumes?.[0]?.type).toBe("tmpfs");
    }
    expect(config.services.smoke?.image).toBe(config.services.app?.image);
    expect(config.services.smoke?.command).toEqual([
      "--conditions=react-server",
      "runtime/task12-smoke.mjs",
    ]);
    expect(config.services.smoke?.depends_on).toMatchObject({
      app: { condition: "service_healthy" },
      worker: { condition: "service_healthy" },
    });
  });

  it("runs every application role from the same compiled artifact image", () => {
    const config = render(["docker-compose.yml"], "smoke");
    const seedConfig = render(["docker-compose.yml"], "seed");
    const bootstrapConfig = render(["docker-compose.yml"], "bootstrap");
    const image = config.services.app?.image;

    expect(config.services.app?.command).toEqual(["server.js"]);
    expect(config.services.migrate?.command).toEqual([
      "--conditions=react-server",
      "runtime/migrate.mjs",
    ]);
    expect(config.services.worker?.command).toEqual([
      "--conditions=react-server",
      "runtime/worker.mjs",
    ]);
    expect(seedConfig.services.seed?.command).toEqual(["runtime/seed.mjs"]);
    expect(bootstrapConfig.services["bootstrap-admin"]?.command).toEqual([
      "--conditions=react-server",
      "runtime/bootstrap-admin.mjs",
    ]);
    expect(config.services["worker-drain-smoke"]?.command).toEqual([
      "--conditions=react-server",
      "runtime/worker-active-drain-smoke.mjs",
    ]);
    for (const name of [
      "app",
      "migrate",
      "worker",
      "worker-drain-smoke",
      "smoke",
    ]) {
      expect(config.services[name]?.image).toBe(image);
    }
    expect(seedConfig.services.seed?.image).toBe(image);
    expect(bootstrapConfig.services["bootstrap-admin"]?.image).toBe(image);
  });

  it("isolates bootstrap administrator values to the opt-in one-shot service", () => {
    const config = render(["docker-compose.yml"], "bootstrap");
    const seedConfig = render(["docker-compose.yml"], "seed");
    const adminVariables = [
      "ADMIN_EMAIL",
      "ADMIN_USERNAME",
      "ADMIN_DISPLAY_NAME",
      "ADMIN_PASSWORD",
    ];

    for (const name of ["app", "worker", "migrate"]) {
      for (const variable of adminVariables) {
        expect(config.services[name]?.environment ?? {}).not.toHaveProperty(
          variable,
        );
      }
    }
    for (const variable of adminVariables) {
      expect(seedConfig.services.seed?.environment ?? {}).not.toHaveProperty(
        variable,
      );
    }
    expect(config.services["bootstrap-admin"]?.environment).toMatchObject({
      ADMIN_EMAIL: expect.any(String),
      ADMIN_USERNAME: expect.any(String),
      ADMIN_DISPLAY_NAME: expect.any(String),
      ADMIN_PASSWORD: syntheticEnvironment.ADMIN_PASSWORD,
    });
    expect(config.services["bootstrap-admin"]?.restart).toBe("no");
    expect(config.services["bootstrap-admin"]?.depends_on).toMatchObject({
      migrate: { condition: "service_completed_successfully" },
    });

    const environmentWithoutAdmin: NodeJS.ProcessEnv = {
      ...syntheticEnvironment,
    };
    delete environmentWithoutAdmin.ADMIN_EMAIL;
    delete environmentWithoutAdmin.ADMIN_USERNAME;
    delete environmentWithoutAdmin.ADMIN_DISPLAY_NAME;
    delete environmentWithoutAdmin.ADMIN_PASSWORD;
    expect(() =>
      render(["docker-compose.yml"], undefined, environmentWithoutAdmin),
    ).not.toThrow();
  });

  it("keeps Ollama explicit and exposes the console only through loopback override", () => {
    const ollama = render(
      ["docker-compose.yml", "docker-compose.ollama.yml"],
      "ollama",
    );
    expect(ollama.services.ollama).toBeDefined();
    expect(ollama.services["ollama-init"]?.restart).toBe("no");
    expect(publishedPorts(ollama)).toHaveLength(1);

    const consoleConfig = render([
      "docker-compose.yml",
      "docker-compose.console.yml",
    ]);
    expect(publishedPorts(consoleConfig)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host_ip: "127.0.0.1",
          service: "minio",
          target: 9001,
        }),
      ]),
    );
    expect(consoleConfig.networks.console?.internal).not.toBe(true);
  });
});
