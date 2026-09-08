const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function normalizeDeploymentUrl(explicitDeploymentUrl, systemDeploymentUrl) {
  const deploymentUrl = explicitDeploymentUrl ?? systemDeploymentUrl;
  if (!deploymentUrl) return null;

  const normalizedDeploymentUrl = explicitDeploymentUrl
    ? explicitDeploymentUrl
    : /^[a-z][a-z\d+.-]*:\/\//iu.test(deploymentUrl)
      ? deploymentUrl
      : `https://${deploymentUrl}`;
  let base;
  try {
    base = new URL(normalizedDeploymentUrl);
    if (!["http:", "https:"].includes(base.protocol)) {
      throw new Error("protocol must be http or https");
    }
    if (base.username || base.password) {
      throw new Error("credentials are not allowed in deployment URL");
    }
  } catch {
    throw new Error("Vercel smoke requires a valid HTTP(S) deployment URL.");
  }
  return base;
}

export function parseSmokeConfig(env = process.env) {
  const explicitDeploymentUrl = env.VERCEL_SMOKE_URL;
  const base = normalizeDeploymentUrl(explicitDeploymentUrl, env.VERCEL_URL);
  if (!base) return null;

  const cronSecret = env.VERCEL_SMOKE_CRON_SECRET ?? "";
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    base.hostname,
  );
  if (cronSecret && base.protocol !== "https:" && !isLoopback) {
    throw new Error(
      "VERCEL_SMOKE_CRON_SECRET requires an HTTPS deployment URL outside loopback.",
    );
  }

  const timeoutMs = Number.parseInt(env.VERCEL_SMOKE_TIMEOUT_MS ?? "15000", 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("VERCEL_SMOKE_TIMEOUT_MS must be a positive integer.");
  }
  return { base, cronSecret, timeoutMs };
}

export async function runSmoke({
  base,
  cronSecret = "",
  timeoutMs = 15_000,
  fetchImpl = fetch,
  randomUUID = () => crypto.randomUUID(),
}) {
  async function call(endpoint, init = {}) {
    const headers = new Headers(init.headers ?? {});
    const requestTimeout = new AbortController();
    const timeout = setTimeout(() => requestTimeout.abort(), timeoutMs);
    try {
      return await fetchImpl(new URL(endpoint, base), {
        ...init,
        headers,
        signal: requestTimeout.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  const live = await call("/api/health/live");
  if (!live.ok) throw new Error(`health/live returned ${live.status}`);
  const liveBody = await live.json();
  if (liveBody?.status !== "ok") {
    throw new Error(
      `health/live body is unexpected: ${JSON.stringify(liveBody)}`,
    );
  }

  const ready = await call("/api/health/ready");
  if (!ready.ok) throw new Error(`health/ready returned ${ready.status}`);
  const readyBody = await ready.json();
  if (readyBody?.status !== "ready") {
    throw new Error(
      `health/ready body is unexpected: ${JSON.stringify(readyBody)}`,
    );
  }

  const graphQL = await call("/api/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": randomUUID(),
    },
    body: JSON.stringify({
      operationName: "SmokeQuery",
      query: "query SmokeQuery { __typename }",
    }),
  });
  if (![400, 401, 403].includes(graphQL.status)) {
    throw new Error(
      `GraphQL unauthenticated probe returned unexpected status ${graphQL.status}`,
    );
  }
  const graphQLBody = await graphQL.json();
  if (!graphQLBody?.errors?.length) {
    throw new Error(
      "GraphQL unauthenticated probe did not return an error envelope",
    );
  }

  const unauthorized = await call("/api/jobs/run", {
    headers: { authorization: "Bearer invalid" },
  });
  if (unauthorized.status !== 401) {
    throw new Error(
      `/api/jobs/run rejected invalid auth with ${unauthorized.status}, expected 401`,
    );
  }
  const unauthorizedBody = await unauthorized.json();
  const unauthorizedRequestId = unauthorized.headers.get("x-request-id");
  if (
    unauthorizedBody?.success !== false ||
    unauthorizedBody?.code !== "UNAUTHENTICATED" ||
    !requestIdPattern.test(unauthorizedBody?.requestId ?? "") ||
    unauthorizedRequestId !== unauthorizedBody.requestId
  ) {
    throw new Error(
      "/api/jobs/run unauthorized response did not return a stable error envelope",
    );
  }

  if (cronSecret) {
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
    if (
      body?.success !== true ||
      !requestIdPattern.test(body?.requestId ?? "") ||
      authorized.headers.get("x-request-id") !== body.requestId
    ) {
      throw new Error("/api/jobs/run did not return a successful result");
    }
  }
}
