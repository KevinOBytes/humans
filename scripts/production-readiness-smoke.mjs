#!/usr/bin/env node

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseArgs(argv = []) {
  const options = { baseUrl: null, providerContracts: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--base-url") options.baseUrl = argv[++index] ?? "";
    else if (value === "--provider-contracts") options.providerContracts = true;
    else if (value === "--help") options.help = true;
    else throw new Error(`Unknown production smoke option: ${value}`);
  }
  return options;
}

export function parseBaseUrl(value) {
  if (!value) throw new Error("production smoke requires --base-url <url>");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("production smoke requires a valid HTTP(S) base URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "production smoke requires a credential-free HTTP(S) base URL",
    );
  return url;
}

function requestId(headers) {
  return headers.get("x-request-id") ?? "missing";
}

export async function runProductionSmoke({
  base,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  auth = false,
  adminEmail = "",
  adminPassword = "",
  providerContracts = false,
  randomUUID = () => crypto.randomUUID(),
  log = (line) => {
    process.stdout.write(`${line}\n`);
  },
}) {
  const call = async (path, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      headers.set("x-request-id", randomUUID());
      return await fetchImpl(new URL(path, base), {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const checkJson = async (path, expected, init) => {
    const response = await call(path, init);
    const body = await response.json().catch(() => null);
    if (response.status !== expected || !body)
      throw new Error(
        `${path} returned ${response.status} (request ${requestId(response.headers)})`,
      );
    log(`${path} ${response.status} request=${requestId(response.headers)}`);
    return { response, body };
  };

  const homepage = await call("/");
  if (!homepage.ok) throw new Error(`homepage returned ${homepage.status}`);
  log(`/ ${homepage.status} request=${requestId(homepage.headers)}`);
  await checkJson("/api/health/live", 200);
  const ready = await checkJson("/api/health/ready", 200);
  if (ready.body?.status !== "ready")
    throw new Error("readiness did not report ready");
  const graph = await call("/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "SmokeQuery",
      query: "query SmokeQuery { __typename }",
    }),
  });
  if (![400, 401, 403].includes(graph.status))
    throw new Error(`unauthenticated GraphQL returned ${graph.status}`);
  log(`/api/graphql ${graph.status} request=${requestId(graph.headers)}`);
  const jobs = await call("/api/jobs/run", {
    headers: { authorization: "Bearer invalid" },
  });
  if (jobs.status !== 401)
    throw new Error(
      `/api/jobs/run returned ${jobs.status} for invalid credentials`,
    );
  log(
    `/api/jobs/run unauthorized ${jobs.status} request=${requestId(jobs.headers)}`,
  );

  if (auth) {
    if (!adminEmail || !adminPassword)
      throw new Error(
        "PRODUCTION_SMOKE_AUTH=1 requires ADMIN_EMAIL and ADMIN_PASSWORD",
      );
    const signIn = await call("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base.origin,
        referer: new URL("/sign-in", base).toString(),
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    if (!signIn.ok)
      throw new Error(
        `authenticated sign-in returned ${signIn.status} (request ${requestId(signIn.headers)})`,
      );
    const cookie = signIn.headers.get("set-cookie");
    if (!cookie)
      throw new Error("authenticated sign-in did not return a session cookie");
    const sessionHeaders = { cookie: cookie.split(",")[0].split(";")[0] };
    const viewer = await call("/api/graphql", {
      method: "POST",
      headers: { ...sessionHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "SmokeViewer",
        query: "query SmokeViewer { viewer { id workspace { id } } }",
      }),
    });
    const viewerBody = await viewer.json().catch(() => null);
    const workspaceId = viewerBody?.data?.viewer?.workspace?.id;
    if (!viewer.ok || !UUID.test(workspaceId ?? ""))
      throw new Error(
        `authenticated viewer failed (request ${requestId(viewer.headers)})`,
      );
    log(
      `authenticated viewer 200 workspace=${workspaceId} request=${requestId(viewer.headers)}`,
    );
    const idempotencyKey = randomUUID();
    const create = await call("/api/graphql", {
      method: "POST",
      headers: { ...sessionHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "SmokeCreatePerson",
        query:
          "mutation SmokeCreatePerson($input: CreatePersonInput!) { createPerson(input: $input) { person { id displayName } code } }",
        variables: {
          input: {
            displayName: `Production smoke ${idempotencyKey.slice(0, 8)}`,
            biography: "Fictional smoke-test record",
            idempotencyKey,
          },
        },
      }),
    });
    const createBody = await create.json().catch(() => null);
    const personId = createBody?.data?.createPerson?.person?.id;
    if (!create.ok || !UUID.test(personId ?? ""))
      throw new Error(
        `authenticated person creation failed (request ${requestId(create.headers)})`,
      );
    log(
      `authenticated synthetic person 200 request=${requestId(create.headers)}`,
    );
    const read = await call("/api/graphql", {
      method: "POST",
      headers: { ...sessionHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "SmokePerson",
        query:
          "query SmokePerson($id: UUID!) { person(id: $id) { id displayName } }",
        variables: { id: personId },
      }),
    });
    if (!read.ok)
      throw new Error(
        `authenticated person read returned ${read.status} (request ${requestId(read.headers)})`,
      );
    log(
      `authenticated synthetic person read 200 request=${requestId(read.headers)}`,
    );
  }
  if (providerContracts) {
    if (process.env.RUN_EXTERNAL_PROVIDER_CONTRACTS !== "true") {
      log(
        "provider contracts skipped (set RUN_EXTERNAL_PROVIDER_CONTRACTS=true to opt in)",
      );
    } else {
      log(
        "provider contracts requested; use the dedicated Compose/provider suites with injected credentials",
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: pnpm production:smoke -- --base-url https://host [--provider-contracts]\n",
      );
      process.exit(0);
    }
    const base = parseBaseUrl(
      options.baseUrl ?? process.env.PRODUCTION_SMOKE_URL,
    );
    await runProductionSmoke({
      base,
      auth: process.env.PRODUCTION_SMOKE_AUTH === "1",
      adminEmail: process.env.ADMIN_EMAIL,
      adminPassword: process.env.ADMIN_PASSWORD,
      providerContracts: options.providerContracts,
    });
    process.stdout.write("production smoke passed\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "production smoke failed"}\n`,
    );
    process.exitCode = 1;
  }
}
