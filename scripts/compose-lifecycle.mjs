#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDirectNodeChildOfComposeInit,
  assertComposeResourcesRemoved,
  createTeardownCoordinator,
  createTrackedCommandExecutor,
} from "./compose-lifecycle-control.mjs";

const mode = process.argv[2];
if (!new Set(["smoke", "lifecycle"]).has(mode)) {
  process.stderr.write("Usage: compose-lifecycle.mjs smoke|lifecycle\n");
  process.exit(2);
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const project = `humans-task15b-${suffix}`;
const image = `humans-task15b:${suffix}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), `${project}-`));

function secret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Unable to allocate an isolated app port");
  return port;
}

const appPort = await availablePort();
const postgresTestPort = await availablePort();
const minioTestPort = await availablePort();

const environment = {
  ...process.env,
  APP_PORT: String(appPort),
  HUMANS_IMAGE: image,
  POSTGRES_DB: "humans",
  POSTGRES_USER: "humans",
  POSTGRES_PASSWORD: secret(24),
  REDIS_PASSWORD: secret(24),
  MINIO_ROOT_USER: `task15b-${suffix}`,
  MINIO_ROOT_PASSWORD: secret(24),
  STORAGE_BUCKET: `humans-private-${suffix}`,
  AUTH_SECRET: secret(),
  AUTH_ENCRYPTION_KEY: secret(),
  AUTH_REGISTRATION_MODE: "public",
  DATA_ENCRYPTION_KEY: secret(),
  PROTECTED_LOOKUP_HMAC_KEY: secret(),
  OPERATION_LIMIT_HMAC_KEY: secret(),
  ADMIN_EMAIL: "admin@localhost.invalid",
  ADMIN_USERNAME: "humans-admin",
  ADMIN_DISPLAY_NAME: "Humans Administrator",
  ADMIN_PASSWORD: `A!${secret(16)}`,
  RESEND_API_KEY: `re_test_${secret(16)}`,
  WORKER_DRAIN_IDEMPOTENCY_KEY: `task15b-active-drain-${suffix}`,
  POSTGRES_TEST_PORT: String(postgresTestPort),
  MINIO_TEST_PORT: String(minioTestPort),
};
Object.assign(environment, {
  ALLOW_TEST_DATABASE_RESET: "true",
  RUN_FILE_LIFECYCLE_MINIO: "true",
  TEST_DATABASE_URL: `postgresql://${environment.POSTGRES_USER}:${environment.POSTGRES_PASSWORD}@127.0.0.1:${postgresTestPort}/humans_lifecycle_test`,
  TEST_STORAGE_ENDPOINT: `http://127.0.0.1:${minioTestPort}`,
  TEST_STORAGE_REGION: "us-east-1",
  TEST_STORAGE_BUCKET: environment.STORAGE_BUCKET,
  TEST_STORAGE_ACCESS_KEY_ID: environment.MINIO_ROOT_USER,
  TEST_STORAGE_SECRET_ACCESS_KEY: environment.MINIO_ROOT_PASSWORD,
});

const composeOverridePath = join(temporaryDirectory, "test-ports.yml");
await writeFile(
  composeOverridePath,
  `services:\n  postgres:\n    networks:\n      - backend\n      - edge\n    ports:\n      - "127.0.0.1:${postgresTestPort}:5432"\n  minio:\n    networks:\n      - backend\n      - edge\n    ports:\n      - "127.0.0.1:${minioTestPort}:9000"\n`,
  { mode: 0o600 },
);

const composePrefix = [
  "compose",
  "--project-name",
  project,
  "--file",
  "docker-compose.yml",
  "--file",
  composeOverridePath,
  "--profile",
  "smoke",
];

const commandRunner = createTrackedCommandExecutor({
  cwd: process.cwd(),
  environment,
});
const { execute } = commandRunner;

function compose(arguments_, options) {
  return execute("docker", [...composePrefix, ...arguments_], options);
}

async function databaseCounts(database = "humans") {
  const result = await compose(
    [
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "--username",
      "humans",
      "--dbname",
      database,
      "--tuples-only",
      "--no-align",
      "--command",
      "select json_build_object('users',(select count(*) from users),'workspaces',(select count(*) from workspaces),'people',(select count(*) from people),'audit_events',(select count(*) from audit_events))::text",
    ],
    { capture: true },
  );
  const counts = JSON.parse(result.stdout.toString("utf8").trim());
  if (
    Object.values(counts).some(
      (count) => !Number.isSafeInteger(count) || count < 1,
    )
  ) {
    throw new Error("Compose smoke did not persist its integrity fixture");
  }
  return counts;
}

async function databaseValue(command, database = "humans") {
  const result = await compose(
    [
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "--username",
      "humans",
      "--dbname",
      database,
      "--tuples-only",
      "--no-align",
      "--command",
      command,
    ],
    { capture: true },
  );
  return result.stdout.toString("utf8").trim();
}

async function waitForDatabaseValue(command, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await databaseValue(command)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Database state did not reach ${expected}`);
}

async function minio(command, input) {
  return compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "minio-init",
      "-c",
      `mc alias set humans "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ${command}`,
    ],
    { capture: true, input },
  );
}

async function assertRuntimeState() {
  const result = await compose(["ps", "--all", "--format", "json"], {
    capture: true,
  });
  const lines = result.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byService = new Map(lines.map((line) => [line.Service, line]));
  for (const name of ["app", "worker", "postgres", "redis", "minio"]) {
    const service = byService.get(name);
    if (service?.State !== "running" || service.Health !== "healthy") {
      throw new Error(`${name} is not running and healthy`);
    }
  }
  for (const name of ["migrate", "minio-init"]) {
    if (byService.get(name)?.ExitCode !== 0) {
      throw new Error(`${name} did not complete successfully`);
    }
  }
}

async function assertProcessTree(service, expectedArgument) {
  const container = await compose(["ps", "--quiet", service], {
    capture: true,
  });
  const containerId = container.stdout.toString("utf8").trim();
  if (!containerId) throw new Error(`${service} container is not running`);
  const [inspectionResult, processTable] = await Promise.all([
    execute("docker", ["inspect", containerId], { capture: true }),
    execute("docker", ["top", containerId, "-eo", "pid,ppid,comm,args"], {
      capture: true,
    }),
  ]);
  const [inspection] = JSON.parse(inspectionResult.stdout.toString("utf8"));
  assertDirectNodeChildOfComposeInit({
    expectedArgument,
    initPid: inspection.State.Pid,
    processTable: processTable.stdout.toString("utf8"),
    runtimeArguments: inspection.Args,
    runtimePath: inspection.Path,
  });
}

async function assertNoLeakage() {
  const [logs, metadata, history] = await Promise.all([
    compose(["logs", "--no-color"], { capture: true }),
    execute("docker", ["image", "inspect", image], { capture: true }),
    execute("docker", ["history", "--no-trunc", image], { capture: true }),
  ]);
  const diagnostics = Buffer.concat([
    logs.stdout,
    logs.stderr,
    metadata.stdout,
    history.stdout,
  ]).toString("utf8");
  for (const value of [
    environment.POSTGRES_PASSWORD,
    environment.REDIS_PASSWORD,
    environment.MINIO_ROOT_PASSWORD,
    environment.AUTH_SECRET,
    environment.AUTH_ENCRYPTION_KEY,
    environment.DATA_ENCRYPTION_KEY,
    environment.PROTECTED_LOOKUP_HMAC_KEY,
    environment.OPERATION_LIMIT_HMAC_KEY,
    environment.ADMIN_PASSWORD,
    environment.RESEND_API_KEY,
  ]) {
    if (diagnostics.includes(value)) {
      throw new Error(
        "A synthetic runtime secret leaked into logs or image metadata",
      );
    }
  }
  if (/uncaught exception|unhandled rejection|panic:/iu.test(diagnostics)) {
    throw new Error("A service emitted an unrecoverable runtime error");
  }
  for (const privateValue of [
    "Compose Search Needle",
    "Compose Foreign Workspace Needle",
    "Compose Confidential Needle",
    "+1 212 555 0127",
  ]) {
    if (diagnostics.includes(privateValue)) {
      throw new Error(
        "Synthetic private application data leaked into diagnostics",
      );
    }
  }
}

async function runSmoke() {
  await compose(["config", "--quiet"]);
  await compose(["build", "--no-cache", "app"]);
  await compose(["up", "--detach", "postgres", "minio"]);
  await compose(["run", "--rm", "bootstrap-admin"]);
  await compose(["up", "--detach", "--wait", "app", "worker"]);
  await compose(["run", "--rm", "smoke"]);
  await assertRuntimeState();
  await assertProcessTree("app", "server.js");
  await assertProcessTree("worker", "runtime/worker.mjs");
  await assertNoLeakage();
}

async function runFileLifecycleAcceptance() {
  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "createdb",
    "--username",
    environment.POSTGRES_USER,
    "humans_lifecycle_test",
  ]);
  try {
    await execute(
      "corepack",
      [
        "pnpm",
        "vitest",
        "run",
        "tests/integration/minio-upload.test.ts",
        "--no-file-parallelism",
      ],
      { capture: false },
    );
  } finally {
    await compose(
      [
        "exec",
        "--no-TTY",
        "postgres",
        "dropdb",
        "--force",
        "--if-exists",
        "--username",
        environment.POSTGRES_USER,
        "humans_lifecycle_test",
      ],
      { capture: true },
    );
  }
}

async function runPersistenceAndRestore() {
  const before = await databaseCounts();
  const objectBody = Buffer.from(`task15b-object-${suffix}\n`, "utf8");
  const objectPath = `humans/${environment.STORAGE_BUCKET}/operations/${suffix}.txt`;
  await minio(`mc pipe "${objectPath}"`, objectBody);
  const anonymousPolicy = await minio(
    `mc anonymous get "humans/${environment.STORAGE_BUCKET}"`,
  );
  if (!/private/iu.test(anonymousPolicy.stdout.toString("utf8"))) {
    throw new Error("MinIO smoke bucket is not private");
  }
  await compose([
    "exec",
    "--no-TTY",
    "redis",
    "/bin/sh",
    "-c",
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SET humans:task15b:restart durable >/dev/null',
  ]);

  await compose(["restart", "postgres", "redis", "minio", "app", "worker"]);
  await compose(["up", "--detach", "--wait", "app", "worker"]);
  if (JSON.stringify(await databaseCounts()) !== JSON.stringify(before)) {
    throw new Error("PostgreSQL row count changed across restart");
  }
  const redisValue = await compose(
    [
      "exec",
      "--no-TTY",
      "redis",
      "/bin/sh",
      "-c",
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw GET humans:task15b:restart',
    ],
    { capture: true },
  );
  if (redisValue.stdout.toString("utf8").trim() !== "durable") {
    throw new Error("Redis AOF state did not survive restart");
  }
  const restoredObject = await minio(`mc cat "${objectPath}"`);
  if (!restoredObject.stdout.equals(objectBody)) {
    throw new Error("MinIO object bytes did not survive restart");
  }

  const dump = await compose(
    [
      "exec",
      "--no-TTY",
      "postgres",
      "pg_dump",
      "--username",
      "humans",
      "--dbname",
      "humans",
      "--format=custom",
      "--no-owner",
    ],
    { capture: true },
  );
  const dumpPath = join(temporaryDirectory, "humans.dump");
  await writeFile(dumpPath, dump.stdout, { mode: 0o600 });
  const checksum = createHash("sha256").update(dump.stdout).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(checksum) || dump.stdout.length < 1_024) {
    throw new Error("PostgreSQL backup artifact is invalid");
  }
  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "createdb",
    "--username",
    "humans",
    "humans_restore",
  ]);
  await compose(
    [
      "exec",
      "--no-TTY",
      "postgres",
      "pg_restore",
      "--username",
      "humans",
      "--dbname",
      "humans_restore",
      "--no-owner",
      "--exit-on-error",
    ],
    { input: dump.stdout },
  );
  if (
    JSON.stringify(await databaseCounts("humans_restore")) !==
    JSON.stringify(before)
  ) {
    throw new Error("Restored PostgreSQL integrity count differs from source");
  }

  await compose([
    "exec",
    "--no-TTY",
    "redis",
    "/bin/sh",
    "-c",
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli flushdb >/dev/null',
  ]);
  await compose(["restart", "redis"]);
  await compose(["up", "--detach", "--wait", "app", "worker"]);

  await compose(["stop", "--timeout", "35", "worker"]);
  await compose(["up", "--detach", "--wait", "worker-drain-smoke"]);
  const drainJobWhere = `idempotency_key = '${environment.WORKER_DRAIN_IDEMPOTENCY_KEY}'`;
  await waitForDatabaseValue(
    `select state from jobs where ${drainJobWhere}`,
    "running",
  );
  await assertProcessTree(
    "worker-drain-smoke",
    "runtime/worker-active-drain-smoke.mjs",
  );
  const started = Date.now();
  await compose(["stop", "--timeout", "35", "worker-drain-smoke"]);
  if (Date.now() - started > 40_000) {
    throw new Error("Worker exceeded its documented graceful-drain deadline");
  }
  const stopped = await compose(
    ["ps", "--all", "--format", "json", "worker-drain-smoke"],
    { capture: true },
  );
  const worker = JSON.parse(stopped.stdout.toString("utf8").trim());
  if (worker.ExitCode !== 0 || worker.State !== "exited") {
    throw new Error(
      `Worker did not exit cleanly after SIGTERM drain (state=${String(worker.State)}, exit=${String(worker.ExitCode)})`,
    );
  }
  const drainState = JSON.parse(
    await databaseValue(
      `select json_build_object('state',state,'attemptCount',attempt_count,'claimGeneration',claim_generation,'errorCode',error_code,'leaseOwner',lease_owner,'leaseExpiresAt',lease_expires_at)::text from jobs where ${drainJobWhere}`,
    ),
  );
  if (
    drainState.state !== "queued" ||
    drainState.attemptCount !== 0 ||
    drainState.claimGeneration !== 1 ||
    drainState.errorCode !== "worker_draining" ||
    drainState.leaseOwner !== null ||
    drainState.leaseExpiresAt !== null
  ) {
    throw new Error(
      `Active worker claim was not durably fenced and deferred: ${JSON.stringify(drainState)}`,
    );
  }
  const workerContainer = await compose(
    ["ps", "--all", "--quiet", "worker-drain-smoke"],
    { capture: true },
  );
  const heartbeatCopy = await execute(
    "docker",
    [
      "cp",
      `${workerContainer.stdout.toString("utf8").trim()}:/tmp/humans-worker/heartbeat`,
      join(temporaryDirectory, "stale-worker-heartbeat"),
    ],
    { allowFailure: true, capture: true },
  );
  if (heartbeatCopy.code === 0) {
    throw new Error("Worker heartbeat remained after active-job drain");
  }
  await databaseValue(`delete from jobs where ${drainJobWhere}`);
  await compose(["rm", "--force", "worker-drain-smoke"]);
  await compose(["up", "--detach", "--wait", "worker"]);
  await assertRuntimeState();
  await assertNoLeakage();
  process.stdout.write(
    `Compose lifecycle passed for isolated project ${project}: PostgreSQL/object/Redis restart, empty-Redis recovery, SHA-256 backup restore integrity, active-job SIGTERM fencing/drain, and leakage checks.\n`,
  );
}

const teardown = createTeardownCoordinator({
  stopActive: commandRunner.stopActive,
  cleanupSteps: [
    () =>
      compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], {
        capture: true,
      }),
    () =>
      execute("docker", ["image", "rm", "--force", image], {
        capture: true,
      }),
    () => rm(temporaryDirectory, { force: true, recursive: true }),
    () => assertComposeResourcesRemoved({ execute, image, project }),
  ],
});

let receivedSignal = null;
let signalShutdown = null;
function beginSignalShutdown(signal) {
  if (receivedSignal) return;
  receivedSignal = signal;
  signalShutdown = teardown.shutdown();
}
process.once("SIGINT", () => beginSignalShutdown("SIGINT"));
process.once("SIGTERM", () => beginSignalShutdown("SIGTERM"));

try {
  await runSmoke();
  if (mode === "lifecycle") {
    await runFileLifecycleAcceptance();
    await runPersistenceAndRestore();
  } else
    process.stdout.write(
      `Compose smoke passed for isolated project ${project}; one image ran migrate/app/worker/smoke with private backends.\n`,
    );
} catch (error) {
  if (!receivedSignal) throw error;
} finally {
  await (signalShutdown ?? teardown.shutdown());
}
if (receivedSignal) process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
