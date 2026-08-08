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
const appBaseUrl = `http://127.0.0.1:${appPort}`;

const environment = {
  ...process.env,
  APP_PORT: String(appPort),
  NEXT_PUBLIC_APP_URL: appBaseUrl,
  AUTH_TRUSTED_ORIGINS: appBaseUrl,
  MINIO_CORS_ALLOW_ORIGIN: appBaseUrl,
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
  CRON_SECRET: secret(32),
  WORKER_DRAIN_IDEMPOTENCY_KEY: `task15b-active-drain-${suffix}`,
};

const composePrefix = [
  "compose",
  "--project-name",
  project,
  "--file",
  "docker-compose.yml",
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseComposeJsonLines(stdout) {
  return stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

class CookieJar {
  cookies = new Map();

  apply(headers) {
    const cookie = [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    if (cookie) headers.set("cookie", cookie);
  }

  capture(response) {
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue) this.cookies.set(name, cookieValue);
      else this.cookies.delete(name);
    }
  }
}

async function appRequest(path, { body, jar, method = "POST" } = {}) {
  const headers = new Headers({
    origin: appBaseUrl,
    "sec-fetch-site": "same-origin",
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  jar?.apply(headers);
  const response = await fetch(new URL(path, appBaseUrl), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  jar?.capture(response);
  return response;
}

async function graphqlRequest(query, variables, jar) {
  const requestId = randomUUID();
  const headers = new Headers({
    "content-type": "application/json",
    origin: appBaseUrl,
    "sec-fetch-site": "same-origin",
    "x-request-id": requestId,
  });
  jar.apply(headers);
  const response = await fetch(new URL("/api/graphql", appBaseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  assert(response.ok, `Built app GraphQL returned HTTP ${response.status}`);
  assert(
    response.headers.get("x-request-id") === requestId,
    "Built app GraphQL request ID did not round trip",
  );
  assert(
    !result.errors?.length,
    `Built app GraphQL returned errors: ${JSON.stringify(result.errors)}`,
  );
  return result.data;
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

async function minio(command, input, options = {}) {
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
    { capture: true, input, ...options },
  );
}

async function minioObjectExists(objectPath) {
  const result = await minio(
    `mc stat ${sqlLiteral(objectPath)} >/dev/null`,
    undefined,
    { allowFailure: true },
  );
  return result.code === 0;
}

async function assertRuntimeState() {
  const result = await compose(["ps", "--all", "--format", "json"], {
    capture: true,
  });
  const lines = parseComposeJsonLines(result.stdout);
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

async function workerHeartbeatUpdatedAt(service = "worker") {
  const container = await compose(["ps", "--quiet", service], {
    capture: true,
  });
  const containerId = container.stdout.toString("utf8").trim();
  if (!containerId) return null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await execute(
      "docker",
      [
        "exec",
        containerId,
        "/nodejs/bin/node",
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('/tmp/humans-worker/heartbeat','utf8'))",
      ],
      { allowFailure: true, capture: true },
    );
    if (result.code === 0) {
      try {
        const payload = JSON.parse(result.stdout.toString("utf8"));
        if (Number.isSafeInteger(payload.updatedAt)) return payload.updatedAt;
      } catch {
        // Retry while the worker atomically replaces the marker.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
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
    environment.CRON_SECRET,
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
  const unauthorized = await appRequest("/api/jobs/run", {
    method: "GET",
  });
  assert(
    unauthorized.status === 401,
    `Built app bounded jobs route accepted a request without authorization (${unauthorized.status})`,
  );
  const authorizedWithSecret = await fetch(
    new URL("/api/jobs/run", appBaseUrl),
    {
      headers: {
        authorization: `Bearer ${environment.CRON_SECRET}`,
        origin: appBaseUrl,
        "sec-fetch-site": "same-origin",
      },
    },
  );
  assert(
    authorizedWithSecret.status === 200,
    `Built app bounded jobs route failed authorized execution (${authorizedWithSecret.status})`,
  );
  const routeBody = await authorizedWithSecret.json();
  assert(
    routeBody?.success === true &&
      Number.isSafeInteger(routeBody.summary?.claimed) &&
      Number.isSafeInteger(routeBody.summary?.completed),
    "Built app bounded jobs route returned an invalid summary",
  );
  await compose(["run", "--rm", "smoke"]);
  await assertRuntimeState();
  await assertProcessTree("app", "server.js");
  await assertProcessTree("worker", "runtime/worker.mjs");
  await assertNoLeakage();
}

async function runFileLifecycleAcceptance() {
  const jar = new CookieJar();
  const signIn = await appRequest("/api/auth/sign-in/email", {
    body: {
      email: environment.ADMIN_EMAIL,
      password: environment.ADMIN_PASSWORD,
    },
    jar,
  });
  assert(
    signIn.ok,
    `Built app administrator sign-in failed (${signIn.status})`,
  );

  const userId = await databaseValue(
    `select id from users where email = ${sqlLiteral(environment.ADMIN_EMAIL)}`,
  );
  assert(
    /^[0-9a-f-]{36}$/iu.test(userId),
    "Bootstrapped administrator ID is invalid",
  );
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const memberId = randomUUID();
  const principalId = randomUUID();
  const settingsId = randomUUID();
  const workspaceName = `Lifecycle Acceptance ${suffix}`;
  const workspaceSlug = `lifecycle-${suffix}`;
  await databaseValue(`
    begin;
    insert into organizations (id, name, slug, created_at)
      values (${sqlLiteral(organizationId)}, ${sqlLiteral(workspaceName)}, ${sqlLiteral(workspaceSlug)}, clock_timestamp());
    insert into workspaces (id, organization_id, name, created_by, updated_by)
      values (${sqlLiteral(workspaceId)}, ${sqlLiteral(organizationId)}, ${sqlLiteral(workspaceName)}, ${sqlLiteral(userId)}, ${sqlLiteral(userId)});
    insert into members (id, organization_id, user_id, role, created_at, workspace_id)
      values (${sqlLiteral(memberId)}, ${sqlLiteral(organizationId)}, ${sqlLiteral(userId)}, 'owner', clock_timestamp(), ${sqlLiteral(workspaceId)});
    insert into workspace_principals (id, workspace_id, principal_type, user_id, member_id_snapshot)
      values (${sqlLiteral(principalId)}, ${sqlLiteral(workspaceId)}, 'user', ${sqlLiteral(userId)}, ${sqlLiteral(memberId)});
    insert into workspace_settings (id, workspace_id, created_by, updated_by)
      values (${sqlLiteral(settingsId)}, ${sqlLiteral(workspaceId)}, ${sqlLiteral(userId)}, ${sqlLiteral(userId)});
    commit;
  `);
  const activeWorkspace = await appRequest(
    "/api/auth/organization/set-active",
    { body: { organizationId }, jar },
  );
  assert(
    activeWorkspace.ok,
    `Built app active-workspace selection failed (${activeWorkspace.status})`,
  );

  const body = Buffer.from(`built GraphQL lifecycle ${suffix}\n`, "utf8");
  const checksum = createHash("sha256").update(body).digest("hex");
  const created = await graphqlRequest(
    `mutation CreateUpload($input: CreateUploadSessionInput!) {
      createUploadSession(input: $input) {
        session { id state }
        grant { method url headers contentLength }
        issues { code message path }
      }
    }`,
    {
      input: {
        originalName: "compose-lifecycle.txt",
        claimedMediaType: "text/plain",
        byteSize: body.byteLength,
        checksumSha256: checksum,
        purpose: "EVIDENCE",
      },
    },
    jar,
  );
  const upload = created?.createUploadSession;
  assert(
    upload?.issues?.length === 0,
    "Upload-session creation returned issues",
  );
  assert(upload?.session?.state === "PENDING", "Upload session is not pending");
  assert(upload?.grant?.method === "PUT", "Upload grant method is invalid");
  assert(
    upload.grant.url === new URL("/api/storage/objects", appBaseUrl).toString(),
    "GraphQL did not return an opaque application upload grant",
  );
  assert(
    upload.grant.contentLength === body.byteLength,
    "Upload grant content length is invalid",
  );
  const serializedGrant = JSON.stringify(upload.grant);
  for (const privateLocation of [
    workspaceId,
    environment.STORAGE_BUCKET,
    "minio:9000",
    "amazonaws.com",
    "r2.cloudflarestorage.com",
  ]) {
    assert(
      !serializedGrant.includes(privateLocation),
      "GraphQL upload grant exposed a private storage location",
    );
  }
  assert(
    /^StorageGrant [A-Za-z0-9_.-]+$/u.test(
      upload.grant.headers?.authorization ?? "",
    ),
    "Upload grant authorization is invalid",
  );
  const uploadHeaders = new Headers(upload.grant.headers);
  uploadHeaders.set("content-length", String(upload.grant.contentLength));
  const uploaded = await fetch(upload.grant.url, {
    method: upload.grant.method,
    headers: uploadHeaders,
    body,
  });
  assert(uploaded.status === 204, `Opaque upload failed (${uploaded.status})`);

  const completed = await graphqlRequest(
    `mutation CompleteUpload($id: UUID!) {
      completeUpload(uploadSessionId: $id) {
        session { id state completedAt }
        file { id version availability scanState }
        issues { code message path }
      }
    }`,
    { id: upload.session.id },
    jar,
  );
  const completion = completed?.completeUpload;
  assert(completion?.issues?.length === 0, "Upload completion returned issues");
  assert(
    completion?.session?.state === "COMPLETED",
    "Upload session did not complete",
  );
  assert(
    completion?.file?.availability === "AVAILABLE",
    "Completed file is not available",
  );
  const fileId = completion.file.id;
  const primaryKey = await databaseValue(
    `select storage_key from files where id = ${sqlLiteral(fileId)} and workspace_id = ${sqlLiteral(workspaceId)}`,
  );
  assert(primaryKey.startsWith("uploads/"), "Primary storage key is invalid");

  const variantId = randomUUID();
  const variantKey = `variants/${fileId}/${randomUUID()}`;
  const variantBody = Buffer.from("delete lifecycle variant", "utf8");
  const variantChecksum = createHash("sha256")
    .update(variantBody)
    .digest("hex");
  const sentinelKey = `variants/${fileId}/${randomUUID()}`;
  const sentinelBody = Buffer.from("retain lifecycle sibling", "utf8");
  const objectPrefix = `humans/${environment.STORAGE_BUCKET}/workspaces/${workspaceId}`;
  await minio(
    `mc pipe ${sqlLiteral(`${objectPrefix}/${variantKey}`)}`,
    variantBody,
  );
  await minio(
    `mc pipe ${sqlLiteral(`${objectPrefix}/${sentinelKey}`)}`,
    sentinelBody,
  );
  await databaseValue(`
    insert into file_variants
      (id, workspace_id, parent_file_id, kind, storage_provider, storage_bucket,
       storage_key, media_type, byte_size, checksum, generator_version, created_by)
    values
      (${sqlLiteral(variantId)}, ${sqlLiteral(workspaceId)}, ${sqlLiteral(fileId)},
       'thumbnail', 'minio', ${sqlLiteral(environment.STORAGE_BUCKET)},
       ${sqlLiteral(variantKey)}, 'text/plain', ${variantBody.byteLength},
       ${sqlLiteral(`sha256:${variantChecksum}`)}, 'compose-lifecycle-v1',
       ${sqlLiteral(userId)})
  `);

  const archived = await graphqlRequest(
    `mutation ArchiveFile($id: UUID!, $expectedVersion: Int!) {
      archiveFile(fileId: $id, expectedVersion: $expectedVersion) {
        file {
          id
          version
          archivedAt
          variants { id kind checksum generatorVersion }
        }
        issues { code message path }
      }
    }`,
    { id: fileId, expectedVersion: completion.file.version },
    jar,
  );
  const archive = archived?.archiveFile;
  assert(archive?.issues?.length === 0, "File archival returned issues");
  assert(archive?.file?.archivedAt, "File was not archived");
  assert(
    archive.file.variants?.some((variant) => variant.id === variantId),
    "Archive mutation did not resolve the archived file variants",
  );

  try {
    await waitForDatabaseValue(
      `select count(*) from jobs where kind = 'file_cleanup' and state = 'completed' and result_references @> ${sqlLiteral(JSON.stringify([fileId]))}::jsonb`,
      "1",
      30_000,
    );
    assert(
      !(await minioObjectExists(`${objectPrefix}/${primaryKey}`)),
      "Running Compose worker retained the archived primary object",
    );
    assert(
      !(await minioObjectExists(`${objectPrefix}/${variantKey}`)),
      "Running Compose worker retained the archived variant object",
    );
    assert(
      await minioObjectExists(`${objectPrefix}/${sentinelKey}`),
      "Running Compose worker deleted a sibling sentinel object",
    );
  } finally {
    await minio(
      `mc rm --force ${sqlLiteral(`${objectPrefix}/${sentinelKey}`)}`,
      undefined,
      { allowFailure: true },
    );
  }
  process.stdout.write(
    `Built app /api/graphql file lifecycle passed through an opaque application upload grant and running Compose worker for ${project}.\n`,
  );
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
  // Stop the backing PostgreSQL service itself (not just a client) and prove
  // readiness names only that failed dependency before recovery.
  await compose(["stop", "postgres"]);
  const readinessDuringPostgresOutage = await appRequest("/api/health/ready", {
    method: "GET",
  });
  const postgresOutageBody = await readinessDuringPostgresOutage.json();
  assert(
    readinessDuringPostgresOutage.status === 503 &&
      postgresOutageBody?.status === "unavailable" &&
      postgresOutageBody?.dependencies?.configuration === "ok" &&
      postgresOutageBody?.dependencies?.postgres === "failed" &&
      postgresOutageBody?.dependencies?.redis === "ok" &&
      postgresOutageBody?.dependencies?.storage === "ok",
    `Readiness did not identify the PostgreSQL outage (${JSON.stringify(postgresOutageBody)})`,
  );
  for (const secretValue of [
    environment.POSTGRES_PASSWORD,
    environment.REDIS_PASSWORD,
    environment.MINIO_ROOT_PASSWORD,
    environment.AUTH_SECRET,
  ]) {
    assert(
      !JSON.stringify(postgresOutageBody).includes(secretValue),
      "Readiness exposed a credential during PostgreSQL outage",
    );
  }
  await compose(["up", "--detach", "--wait", "postgres"]);
  const readinessAfterPostgresRecovery = await appRequest("/api/health/ready", {
    method: "GET",
  });
  assert(
    readinessAfterPostgresRecovery.status === 200,
    `Readiness did not recover after PostgreSQL restart (${readinessAfterPostgresRecovery.status})`,
  );
  // Exercise the dependency-failure contract while the worker is still
  // running: liveness must remain available, readiness must fail closed, and
  // the independent heartbeat must keep the worker healthy. Restoring Redis
  // must allow the same app/worker processes to become ready again.
  const heartbeatBeforeRedisOutage = await workerHeartbeatUpdatedAt();
  await compose(["stop", "redis"]);
  const livenessDuringRedisOutage = await appRequest("/api/health/live", {
    method: "GET",
  });
  assert(
    livenessDuringRedisOutage.status === 200,
    `Liveness failed during Redis outage (${livenessDuringRedisOutage.status})`,
  );
  const readinessDuringRedisOutage = await appRequest("/api/health/ready", {
    method: "GET",
  });
  const readinessBody = await readinessDuringRedisOutage.json();
  const serializedReadiness = JSON.stringify(readinessBody);
  assert(
    readinessDuringRedisOutage.status === 503 &&
      readinessBody?.status === "unavailable" &&
      readinessBody?.dependencies?.configuration === "ok" &&
      readinessBody?.dependencies?.postgres === "ok" &&
      readinessBody?.dependencies?.storage === "ok" &&
      readinessBody?.dependencies?.redis === "failed",
    `Readiness did not fail closed during Redis outage (${JSON.stringify(readinessBody)})`,
  );
  for (const secretValue of [
    environment.POSTGRES_PASSWORD,
    environment.REDIS_PASSWORD,
    environment.MINIO_ROOT_PASSWORD,
    environment.AUTH_SECRET,
  ]) {
    assert(
      !serializedReadiness.includes(secretValue),
      "Readiness exposed a credential during Redis outage",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const heartbeatAfterRedisOutage = await workerHeartbeatUpdatedAt();
  assert(
    heartbeatBeforeRedisOutage !== null &&
      heartbeatAfterRedisOutage !== null &&
      heartbeatAfterRedisOutage > heartbeatBeforeRedisOutage,
    `Worker heartbeat did not advance during Redis outage (${String(heartbeatBeforeRedisOutage)} -> ${String(heartbeatAfterRedisOutage)})`,
  );
  const workerDuringRedisOutage = await compose(
    ["ps", "--all", "--format", "json", "worker"],
    { capture: true },
  );
  const workerOutageState = parseComposeJsonLines(
    workerDuringRedisOutage.stdout,
  ).find((service) => service.Service === "worker");
  assert(
    workerOutageState.State === "running" &&
      workerOutageState.Health === "healthy",
    `Worker heartbeat was not independent of Redis outage (${JSON.stringify(workerOutageState)})`,
  );
  await compose(["up", "--detach", "--wait", "redis"]);
  const readinessAfterRedisRecovery = await appRequest("/api/health/ready", {
    method: "GET",
  });
  const readinessAfterRedisRecoveryBody =
    await readinessAfterRedisRecovery.json();
  assert(
    readinessAfterRedisRecovery.status === 200 &&
      readinessAfterRedisRecoveryBody?.status === "ready" &&
      Object.values(readinessAfterRedisRecoveryBody.dependencies ?? {}).every(
        (status) => status === "ok",
      ),
    `Readiness did not recover after Redis restart (${JSON.stringify(readinessAfterRedisRecoveryBody)})`,
  );
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
  const worker = parseComposeJsonLines(stopped.stdout).find(
    (service) => service.Service === "worker-drain-smoke",
  );
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
