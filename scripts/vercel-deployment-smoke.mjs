#!/usr/bin/env node

const explicitDeploymentUrl = process.env.VERCEL_SMOKE_URL;
const systemDeploymentUrl = process.env.VERCEL_URL;
const deploymentUrl = explicitDeploymentUrl ?? systemDeploymentUrl;

if (!deploymentUrl) {
  process.stdout.write(
    "Vercel smoke skipped: set VERCEL_SMOKE_URL (or VERCEL_URL) to a deployed URL.\n",
  );
  process.exit(0);
}

let base;
try {
  const normalizedDeploymentUrl = explicitDeploymentUrl
    ? explicitDeploymentUrl
    : /^[a-z][a-z\d+.-]*:\/\//iu.test(deploymentUrl)
      ? deploymentUrl
      : `https://${deploymentUrl}`;
  base = new URL(normalizedDeploymentUrl);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new Error("protocol must be http or https");
  }
  if (base.username || base.password) {
    throw new Error("credentials are not allowed in deployment URL");
  }
} catch {
  console.error("Vercel smoke requires a valid HTTP(S) deployment URL.");
  process.exit(1);
}

const cronSecret = process.env.VERCEL_SMOKE_CRON_SECRET ?? "";
const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
  base.hostname,
);
if (cronSecret && base.protocol !== "https:" && !isLoopback) {
  console.error(
    "VERCEL_SMOKE_CRON_SECRET requires an HTTPS deployment URL outside loopback.",
  );
  process.exit(1);
}
const timeoutMs = Number.parseInt(
  process.env.VERCEL_SMOKE_TIMEOUT_MS ?? "15000",
  10,
);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
  console.error("VERCEL_SMOKE_TIMEOUT_MS must be a positive integer.");
  process.exit(1);
}

async function call(endpoint, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const requestTimeout = new AbortController();
  const timeout = setTimeout(() => requestTimeout.abort(), timeoutMs);
  try {
    return await fetch(new URL(endpoint, base), {
      ...init,
      headers,
      signal: requestTimeout.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function assertReady() {
  const live = await call("/api/health/live");
  if (!live.ok) {
    throw new Error(`health/live returned ${live.status}`);
  }
  const liveBody = await live.json();
  if (liveBody?.status !== "ok") {
    throw new Error(
      `health/live body is unexpected: ${JSON.stringify(liveBody)}`,
    );
  }

  const ready = await call("/api/health/ready");
  if (!ready.ok) {
    throw new Error(`health/ready returned ${ready.status}`);
  }
  const readyBody = await ready.json();
  if (readyBody?.status !== "ready") {
    throw new Error(
      `health/ready body is unexpected: ${JSON.stringify(readyBody)}`,
    );
  }
}

async function assertGraphqlProbe() {
  const response = await call("/api/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      operationName: "SmokeQuery",
      query: "query SmokeQuery { __typename }",
    }),
  });
  if (
    response.status !== 400 &&
    response.status !== 401 &&
    response.status !== 403
  ) {
    throw new Error(
      `GraphQL unauthenticated probe returned unexpected status ${response.status}`,
    );
  }
  const body = await response.json();
  if (!body?.errors?.length) {
    throw new Error(
      "GraphQL unauthenticated probe did not return an error envelope",
    );
  }
}

async function assertJobsRoute() {
  const unauthorized = await call("/api/jobs/run", {
    headers: { authorization: "Bearer invalid" },
  });
  if (unauthorized.status !== 401) {
    throw new Error(
      `/api/jobs/run rejected invalid auth with ${unauthorized.status}, expected 401`,
    );
  }

  if (!cronSecret) return;
  const authorized = await call("/api/jobs/run", {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  if (authorized.status === 405) {
    throw new Error("/api/jobs/run returned POST-only error on GET");
  }
  if (authorized.status !== 200) {
    throw new Error(
      `/api/jobs/run with provided secret returned ${authorized.status}`,
    );
  }
  const body = await authorized.json();
  if (body?.success !== true) {
    throw new Error("/api/jobs/run did not return a successful result");
  }
}

async function main() {
  await assertReady();
  await assertGraphqlProbe();
  await assertJobsRoute();
  process.stdout.write(`Vercel smoke passed for ${base.toString()}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
