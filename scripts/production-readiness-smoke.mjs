#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { validateExternalStorageContractBucket } from "./provider-contract-storage-config.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseArgs(argv = []) {
  const options = {
    authenticated: false,
    baseUrl: null,
    environmentContract: false,
    providerContracts: false,
    twoFactor: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--base-url") options.baseUrl = argv[++index] ?? "";
    else if (value === "--authenticated") options.authenticated = true;
    else if (value === "--environment-contract")
      options.environmentContract = true;
    else if (value === "--provider-contracts") options.providerContracts = true;
    else if (value === "--diagnose-provider-config")
      options.diagnoseProviderConfig = true;
    else if (value === "--two-factor") options.twoFactor = true;
    else if (value === "--help") options.help = true;
    else throw new Error(`Unknown production smoke option: ${value}`);
  }
  return options;
}

const simpleProviderContractGroups = [
  {
    label: "storage",
    variables: [
      "TEST_STORAGE_PROVIDER",
      "TEST_STORAGE_ENDPOINT",
      "TEST_STORAGE_REGION",
      "TEST_STORAGE_BUCKET",
      "TEST_STORAGE_ACCESS_KEY_ID",
      "TEST_STORAGE_SECRET_ACCESS_KEY",
    ],
  },
  {
    label: "resend",
    variables: [
      "TEST_RESEND_API_KEY",
      "TEST_RESEND_FROM",
      "TEST_RESEND_RECIPIENT",
    ],
  },
];

const providerContractEnvironmentVariables = [
  "RUN_EXTERNAL_PROVIDER_CONTRACTS",
  "REDIS_TEST_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "TEST_STORAGE_PROVIDER",
  "TEST_STORAGE_ENDPOINT",
  "TEST_STORAGE_REGION",
  "TEST_STORAGE_BUCKET",
  "TEST_STORAGE_ACCESS_KEY_ID",
  "TEST_STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_BUCKET",
  "TEST_AI_PROVIDER",
  "TEST_AI_BASE_URL",
  "TEST_AI_API_KEY",
  "TEST_AI_MODEL",
  "TEST_RESEND_API_KEY",
  "TEST_RESEND_FROM",
  "TEST_RESEND_RECIPIENT",
  "TEST_RESEND_BASE_URL",
];

const childRuntimeEnvironmentVariables = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "NODE_OPTIONS",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
];

function providerContractChildEnvironment(env) {
  const child = Object.fromEntries(
    [
      ...childRuntimeEnvironmentVariables,
      ...providerContractEnvironmentVariables,
    ]
      .filter((variable) => env[variable] !== undefined)
      .map((variable) => [variable, env[variable]]),
  );
  if (!isPresent(child.UPSTASH_REDIS_REST_URL))
    child.UPSTASH_REDIS_REST_URL = env.KV_REST_API_URL;
  if (!isPresent(child.UPSTASH_REDIS_REST_TOKEN))
    child.UPSTASH_REDIS_REST_TOKEN = env.KV_REST_API_TOKEN;
  delete child.KV_REST_API_URL;
  delete child.KV_REST_API_TOKEN;
  return child;
}

const productionEnvironmentGroups = [
  {
    label: "public-runtime",
    variables: [
      "DEPLOYMENT_MODE",
      "NEXT_PUBLIC_APP_URL",
      "CRON_SECRET",
      "TRUSTED_PROXY_MODE",
    ],
    alternatives: [
      ["DATABASE_URL", "POSTGRES_URL"],
      ["REDIS_URL", "KV_URL"],
    ],
  },
  {
    label: "authentication",
    variables: [
      "AUTH_SECRET",
      "AUTH_ENCRYPTION_KEY",
      "DATA_ENCRYPTION_KEY",
      "PROTECTED_LOOKUP_HMAC_KEY",
      "OPERATION_LIMIT_HMAC_KEY",
      "AUTH_TRUSTED_ORIGINS",
      "AUTH_SECURE_COOKIES",
    ],
  },
  {
    label: "administrator-recovery",
    variables: [
      "ADMIN_EMAIL",
      "ADMIN_USERNAME",
      "ADMIN_DISPLAY_NAME",
      "ADMIN_PASSWORD",
    ],
    alternatives: [["DATABASE_URL", "POSTGRES_URL"]],
  },
  {
    label: "resend",
    variables: ["RESEND_API_KEY", "EMAIL_FROM"],
  },
];

function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function providerConfigurationCheck({
  missing,
  provider,
  scope,
  selected = true,
}) {
  const status = !selected
    ? "not-selected"
    : missing.length > 0
      ? "missing"
      : "configured";
  return {
    code:
      status === "configured"
        ? "ACCEPTANCE_PROVIDER_CONFIGURED"
        : status === "missing"
          ? "ACCEPTANCE_PROVIDER_CONFIGURATION_MISSING"
          : "ACCEPTANCE_PROVIDER_NOT_SELECTED",
    missing,
    provider,
    scope,
    status,
  };
}

/**
 * Build a value-free acceptance plan. This function deliberately checks only
 * whether the documented variables are present; it never initializes an
 * adapter or probes a provider.
 *
 * @param {Record<string, string | undefined>} env
 */
export function providerConfigurationDiagnostics(env = {}) {
  const localRuntimeSelected = env.DEPLOYMENT_MODE !== "vercel";
  const storageProvider = env.STORAGE_PROVIDER;
  const aiProvider = env.AI_PROVIDER;
  const testStorageProvider = env.TEST_STORAGE_PROVIDER;
  const testAiProvider = env.TEST_AI_PROVIDER;
  const canonicalUpstash = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];
  const vercelUpstash = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const upstashSelected = [...canonicalUpstash, ...vercelUpstash].some((name) =>
    isPresent(env[name]),
  );
  const upstashVariables = canonicalUpstash.some((name) => isPresent(env[name]))
    ? canonicalUpstash
    : vercelUpstash;
  const storageSelected = ["r2", "s3"].includes(testStorageProvider);
  const aiSelected = ["openai", "compatible"].includes(testAiProvider);
  const resendVariables = [
    "TEST_RESEND_API_KEY",
    "TEST_RESEND_FROM",
    "TEST_RESEND_RECIPIENT",
  ];
  const resendSelected = resendVariables.some((name) => isPresent(env[name]));

  return {
    kind: "provider-configuration",
    networkProbes: false,
    externalOptIn:
      env.RUN_EXTERNAL_PROVIDER_CONTRACTS === "true"
        ? {
            code: "ACCEPTANCE_EXTERNAL_OPT_IN_CONFIGURED",
            missing: [],
            status: "configured",
          }
        : {
            code: "ACCEPTANCE_EXTERNAL_OPT_IN_REQUIRED",
            missing: ["RUN_EXTERNAL_PROVIDER_CONTRACTS"],
            status: "missing",
          },
    checks: [
      providerConfigurationCheck({
        provider: "postgres",
        scope: "local",
        selected: localRuntimeSelected,
        missing: !localRuntimeSelected
          ? []
          : ["DATABASE_URL", "POSTGRES_URL"].some((name) =>
                isPresent(env[name]),
              )
            ? []
            : ["DATABASE_URL", "POSTGRES_URL"],
      }),
      providerConfigurationCheck({
        provider: "redis",
        scope: "local",
        selected: localRuntimeSelected && !isPresent(env.REDIS_TOKEN),
        missing:
          !localRuntimeSelected || isPresent(env.REDIS_TOKEN)
            ? []
            : isPresent(env.REDIS_URL)
              ? []
              : ["REDIS_URL"],
      }),
      providerConfigurationCheck({
        provider: "minio",
        scope: "local",
        selected: storageProvider === "minio",
        missing:
          storageProvider === "minio"
            ? [
                "STORAGE_ENDPOINT",
                "STORAGE_REGION",
                "STORAGE_BUCKET",
                "STORAGE_ACCESS_KEY_ID",
                "STORAGE_SECRET_ACCESS_KEY",
                "STORAGE_FORCE_PATH_STYLE",
                "STORAGE_BUCKET_PUBLIC",
              ].filter((name) => !isPresent(env[name]))
            : isPresent(storageProvider)
              ? []
              : ["STORAGE_PROVIDER"],
      }),
      providerConfigurationCheck({
        provider: "ollama",
        scope: "local",
        selected: aiProvider === "ollama",
        missing:
          aiProvider === "ollama"
            ? ["AI_BASE_URL", "AI_MODEL"].filter(
                (name) => !isPresent(env[name]),
              )
            : isPresent(aiProvider)
              ? []
              : ["AI_PROVIDER"],
      }),
      providerConfigurationCheck({
        provider: "upstash",
        scope: "external",
        selected: upstashSelected,
        missing: upstashSelected
          ? upstashVariables.filter((name) => !isPresent(env[name]))
          : ["UPSTASH_REDIS_REST_URL"],
      }),
      providerConfigurationCheck({
        provider: storageSelected ? testStorageProvider : "r2-or-s3",
        scope: "external",
        selected: storageSelected,
        missing: storageSelected
          ? [
              "TEST_STORAGE_ENDPOINT",
              "TEST_STORAGE_REGION",
              "TEST_STORAGE_BUCKET",
              "TEST_STORAGE_ACCESS_KEY_ID",
              "TEST_STORAGE_SECRET_ACCESS_KEY",
            ].filter((name) => !isPresent(env[name]))
          : ["TEST_STORAGE_PROVIDER"],
      }),
      providerConfigurationCheck({
        provider: aiSelected ? testAiProvider : "openai-or-compatible",
        scope: "external",
        selected: aiSelected,
        missing: aiSelected
          ? ["TEST_AI_BASE_URL", "TEST_AI_MODEL", "TEST_AI_API_KEY"].filter(
              (name) => !isPresent(env[name]),
            )
          : ["TEST_AI_PROVIDER"],
      }),
      providerConfigurationCheck({
        provider: "resend",
        scope: "external",
        selected: resendSelected,
        missing: resendSelected
          ? resendVariables.filter((name) => !isPresent(env[name]))
          : ["TEST_RESEND_API_KEY"],
      }),
    ],
  };
}

function orderedLabels(labels, order) {
  return [...labels].sort((left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    return (
      (leftIndex < 0 ? order.length : leftIndex) -
      (rightIndex < 0 ? order.length : rightIndex)
    );
  });
}

function missingVariables(env, group) {
  const missing = group.variables.filter(
    (variable) => !isPresent(env[variable]),
  );
  for (const alternatives of group.alternatives ?? []) {
    if (!alternatives.some((variable) => isPresent(env[variable]))) {
      missing.push(...alternatives);
    }
  }
  return missing;
}

export function productionEnvironmentContractPlan(env = {}) {
  const configured = [];
  /** @type {Record<string, string[]>} */
  const missing = {};

  for (const group of productionEnvironmentGroups) {
    const absent = missingVariables(env, group);
    if (absent.length) missing[group.label] = absent;
    else configured.push(group.label);
  }

  const redisConfigured = ["REDIS_URL", "KV_URL"].some((name) =>
    isPresent(env[name]),
  );
  if (redisConfigured) {
    const upstashConfigured = [
      "KV_URL",
      "KV_REST_API_URL",
      "UPSTASH_REDIS_REST_URL",
    ].some((name) => isPresent(env[name]));
    configured.push(upstashConfigured ? "upstash" : "redis");
  }

  const storageProvider = env.STORAGE_PROVIDER;
  const storageVariables = [
    "STORAGE_PROVIDER",
    "STORAGE_ENDPOINT",
    "STORAGE_REGION",
    "STORAGE_BUCKET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
    "STORAGE_FORCE_PATH_STYLE",
    "STORAGE_BUCKET_PUBLIC",
  ];
  const storageMissing = storageVariables.filter(
    (variable) => !isPresent(env[variable]),
  );
  if (storageProvider && !["minio", "r2", "s3"].includes(storageProvider)) {
    throw new Error("STORAGE_PROVIDER must be one of minio, r2, or s3");
  }
  if (storageMissing.length) missing.storage = storageMissing;
  else configured.push(storageProvider);

  const aiProvider = env.AI_PROVIDER;
  if (aiProvider && !["openai", "ollama", "compatible"].includes(aiProvider)) {
    throw new Error("AI_PROVIDER must be one of openai, ollama, or compatible");
  }
  const aiMissing = ["AI_PROVIDER", "AI_BASE_URL", "AI_MODEL"].filter(
    (variable) => !isPresent(env[variable]),
  );
  if (
    aiProvider === "openai" &&
    !isPresent(env.AI_API_KEY) &&
    !isPresent(env.OPENAI_API_KEY)
  ) {
    aiMissing.push("AI_API_KEY", "OPENAI_API_KEY");
  }
  if (aiProvider === "compatible") {
    const openRouter = /^https:\/\/(?:[^/]+\.)?openrouter\.ai(?:\/|$)/iu.test(
      env.AI_BASE_URL ?? "",
    );
    const keyNames = openRouter
      ? ["AI_API_KEY", "OPEN_ROUTER_KEY"]
      : ["AI_API_KEY"];
    if (!keyNames.some((variable) => isPresent(env[variable]))) {
      aiMissing.push(...keyNames);
    }
  }
  if (aiMissing.length) missing[aiProvider ?? "ai"] = aiMissing;
  else configured.push(aiProvider);

  return {
    configured: orderedLabels(configured, [
      "public-runtime",
      "authentication",
      "administrator-recovery",
      "upstash",
      "redis",
      "minio",
      "r2",
      "s3",
      "resend",
      "openai",
      "ollama",
      "compatible",
    ]),
    missing,
  };
}

export function assertProductionEnvironmentContract(env = {}) {
  const plan = productionEnvironmentContractPlan(env);
  const missing = Object.values(plan.missing).flat();
  if (missing.length) {
    throw new Error(
      `production environment contract is incomplete; missing ${[...new Set(missing)].join(", ")}`,
    );
  }
  return plan;
}

export function externalProviderContractPlan(env = {}) {
  const enabled = [];
  const unavailable = [];

  if (env.RUN_EXTERNAL_PROVIDER_CONTRACTS !== "true") {
    return {
      enabled,
      unavailable: ["upstash-rest", "storage", "ai", "resend"],
    };
  }

  const canonicalUpstash = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];
  const vercelUpstash = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const selectedUpstash = canonicalUpstash.some((name) => isPresent(env[name]))
    ? canonicalUpstash
    : vercelUpstash;
  if (selectedUpstash.some((name) => isPresent(env[name]))) {
    const missing = selectedUpstash.filter((name) => !isPresent(env[name]));
    if (missing.length) {
      throw new Error(
        `upstash-rest provider contract credentials are incomplete; missing ${missing.join(", ")}`,
      );
    }
    enabled.push("upstash-rest");
  } else unavailable.push("upstash-rest");

  for (const group of simpleProviderContractGroups) {
    const present = group.variables.filter((variable) =>
      Boolean(env[variable]),
    );
    if (present.length === 0) {
      unavailable.push(group.label);
      continue;
    }
    const missing = group.variables.filter((variable) => !env[variable]);
    if (missing.length > 0) {
      throw new Error(
        `${group.label} provider contract credentials are incomplete; missing ${missing.join(", ")}`,
      );
    }
    if (
      group.label === "storage" &&
      !["minio", "r2", "s3"].includes(env.TEST_STORAGE_PROVIDER)
    )
      throw new Error("TEST_STORAGE_PROVIDER must be one of minio, r2, or s3");
    if (group.label === "storage")
      validateExternalStorageContractBucket({
        bucket: env.TEST_STORAGE_BUCKET,
        provider: env.TEST_STORAGE_PROVIDER,
        storageBucket: env.STORAGE_BUCKET,
      });
    enabled.push(
      group.label === "storage" ? env.TEST_STORAGE_PROVIDER : group.label,
    );
    if (group.label === "resend" && env.TEST_RESEND_BASE_URL) {
      let base;
      try {
        base = new URL(env.TEST_RESEND_BASE_URL);
      } catch {
        throw new Error("TEST_RESEND_BASE_URL must be a loopback HTTP URL");
      }
      if (
        base.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      ) {
        throw new Error("TEST_RESEND_BASE_URL must be a loopback HTTP URL");
      }
    }
  }

  const aiVariables = ["TEST_AI_PROVIDER", "TEST_AI_BASE_URL", "TEST_AI_MODEL"];
  const aiPresent = [...aiVariables, "TEST_AI_API_KEY"].some((variable) =>
    isPresent(env[variable]),
  );
  if (aiPresent) {
    const provider = env.TEST_AI_PROVIDER;
    if (!provider || !["openai", "ollama", "compatible"].includes(provider)) {
      throw new Error(
        "TEST_AI_PROVIDER must be one of openai, ollama, or compatible",
      );
    }
    const missing = aiVariables.filter((variable) => !isPresent(env[variable]));
    if (provider !== "ollama" && !isPresent(env.TEST_AI_API_KEY)) {
      missing.push("TEST_AI_API_KEY");
    }
    if (missing.length) {
      throw new Error(
        `ai provider contract credentials are incomplete; missing ${missing.join(", ")}`,
      );
    }
    enabled.push(provider);
  } else unavailable.push("ai");

  return {
    enabled: orderedLabels(enabled, [
      "upstash-rest",
      "minio",
      "r2",
      "s3",
      "openai",
      "ollama",
      "compatible",
      "resend",
    ]),
    unavailable: orderedLabels(unavailable, [
      "upstash-rest",
      "storage",
      "ai",
      "resend",
    ]),
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{exitCode: number}>}
 */
async function executeProviderContractSuite(env) {
  const vitest = resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "tests/integration/provider-adapter-contract.test.ts",
        "tests/integration/provider-ai-email-contract.test.ts",
        "--no-file-parallelism",
      ],
      {
        cwd: process.cwd(),
        env,
        stdio: "ignore",
      },
    );
    child.once("error", () => {
      reject(new Error("external provider contract runner could not start"));
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1 });
    });
  });
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   execute?: (env: Record<string, string | undefined>) => Promise<{exitCode: number}>,
 *   log?: (line: string) => void,
 * }} [options]
 */
export async function runExternalProviderContracts({
  env = /** @type {Record<string, string | undefined>} */ (process.env),
  execute = executeProviderContractSuite,
  log = (line) => {
    process.stdout.write(`${line}\n`);
  },
} = {}) {
  const plan = externalProviderContractPlan(env);
  if (env.RUN_EXTERNAL_PROVIDER_CONTRACTS !== "true") {
    throw new Error(
      "external provider contracts require explicit RUN_EXTERNAL_PROVIDER_CONTRACTS=true opt-in",
    );
  }
  if (plan.enabled.length === 0) {
    throw new Error(
      `external provider contracts unavailable: no complete credential set injected (${plan.unavailable.join(", ")})`,
    );
  }

  const result = await execute(providerContractChildEnvironment(env));
  if (result.exitCode !== 0) {
    throw new Error(
      `external provider contracts failed for ${plan.enabled.join(", ")}`,
    );
  }
  log(`external provider contracts passed for ${plan.enabled.join(", ")}`);
  return { enabled: plan.enabled, ran: true };
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

export function validateAuthenticatedSmokeConfiguration({
  adminEmail = "",
  adminUsername = "",
  adminPassword = "",
} = {}) {
  const missing = [
    ["ADMIN_EMAIL", adminEmail],
    ["ADMIN_USERNAME", adminUsername],
    ["ADMIN_PASSWORD", adminPassword],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0)
    throw new Error(
      `authenticated production smoke requires ${missing.join(", ")}`,
    );
}

export async function validateSyntheticPersonRead(
  response,
  { expectedId, expectedDisplayName },
) {
  const body = await response.json().catch(() => null);
  const person = body?.data?.person;
  if (
    !response.ok ||
    !body ||
    (Array.isArray(body.errors) && body.errors.length > 0) ||
    person?.id !== expectedId ||
    person?.displayName !== expectedDisplayName
  )
    throw new Error(
      `authenticated person read failed (request ${requestId(response.headers)})`,
    );
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
  adminUsername = "",
  adminPassword = "",
  backupCode = "",
  environmentContract = false,
  providerContracts = false,
  providerContractRunner = runExternalProviderContracts,
  providerEnv = process.env,
  randomUUID = () => crypto.randomUUID(),
  totpCode = "",
  twoFactor = false,
  log = (line) => {
    process.stdout.write(`${line}\n`);
  },
}) {
  if (environmentContract) {
    const plan = assertProductionEnvironmentContract(providerEnv);
    log(`environment contract configured for ${plan.configured.join(", ")}`);
  }
  if (auth)
    validateAuthenticatedSmokeConfiguration({
      adminEmail,
      adminUsername,
      adminPassword,
    });
  if (twoFactor) {
    if (!auth)
      throw new Error(
        "two-factor production smoke requires authenticated smoke",
      );
    if (Number(Boolean(totpCode)) + Number(Boolean(backupCode)) !== 1)
      throw new Error(
        "two-factor production smoke requires exactly one injected TOTP code or backup code",
      );
  }

  const call = async (path, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      headers.set("x-request-id", randomUUID());
      try {
        return await fetchImpl(new URL(path, base), {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch {
        throw new Error(`request ${path} failed`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const sameOrigin = {
    origin: base.origin,
    referer: new URL("/sign-in", base).toString(),
    "sec-fetch-site": "same-origin",
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
  const requiredDependencies = [
    "configuration",
    "postgres",
    "redis",
    "storage",
  ];
  if (
    requiredDependencies.some(
      (dependency) => ready.body?.dependencies?.[dependency] !== "ok",
    )
  )
    throw new Error(
      "readiness did not include successful dependency evidence for configuration, postgres, redis, and storage",
    );
  log("provider readiness configuration=ok postgres=ok redis=ok storage=ok");
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
    const cookieHeader = (jar) =>
      [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const absorbCookies = (response, jar) => {
      const values =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [response.headers.get("set-cookie")].filter(Boolean);
      for (const value of values) {
        const pair = value.split(";", 1)[0];
        const separator = pair.indexOf("=");
        if (separator < 1) continue;
        const name = pair.slice(0, separator).trim();
        const cookieValue = pair.slice(separator + 1).trim();
        if (/max-age=0/iu.test(value) || cookieValue === "") jar.delete(name);
        else jar.set(name, cookieValue);
      }
    };
    const signIn = async ({ path, body, label }) => {
      const jar = new Map();
      const response = await call(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base.origin,
          referer: new URL("/sign-in", base).toString(),
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(
          `authenticated ${label} sign-in returned ${response.status} (request ${requestId(response.headers)})`,
        );
      absorbCookies(response, jar);
      if (jar.size === 0)
        throw new Error(
          `authenticated ${label} sign-in did not return an authentication cookie`,
        );
      const result = await response.json().catch(() => null);
      return {
        jar,
        label,
        twoFactorRequired: result?.twoFactorRedirect === true,
      };
    };
    const completeSecondFactor = async (session) => {
      const method = totpCode ? "totp" : "backup-code";
      const code = totpCode || backupCode;
      const response = await call(`/api/auth/two-factor/verify-${method}`, {
        method: "POST",
        headers: {
          ...sameOrigin,
          cookie: cookieHeader(session.jar),
          "content-type": "application/json",
        },
        body: JSON.stringify({ code, trustDevice: false }),
      });
      if (!response.ok)
        throw new Error(
          `authenticated ${session.label} two-factor verification returned ${response.status} (request ${requestId(response.headers)})`,
        );
      absorbCookies(response, session.jar);
      log(
        `authenticated ${session.label} two-factor verified request=${requestId(response.headers)}`,
      );
      return session;
    };
    const verifyViewer = async (session) => {
      const viewer = await call("/api/graphql", {
        method: "POST",
        headers: {
          ...sameOrigin,
          cookie: cookieHeader(session.jar),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName: "SmokeViewer",
          query: "query SmokeViewer { viewer { id workspace { id } } }",
        }),
      });
      const viewerBody = await viewer.json().catch(() => null);
      const workspaceId = viewerBody?.data?.viewer?.workspace?.id;
      if (!viewer.ok || !UUID.test(workspaceId ?? ""))
        throw new Error(
          `authenticated ${session.label} viewer failed (request ${requestId(viewer.headers)})`,
        );
      log(
        `authenticated ${session.label} viewer 200 request=${requestId(viewer.headers)}`,
      );
      return { jar: session.jar, workspaceId };
    };
    const emailSignIn = await signIn({
      path: "/api/auth/sign-in/email",
      body: { email: adminEmail, password: adminPassword },
      label: "email",
    });
    if (emailSignIn.twoFactorRequired !== twoFactor)
      throw new Error(
        twoFactor
          ? "authenticated email sign-in did not require configured two-factor verification"
          : "authenticated email sign-in requires two-factor verification; rerun with --two-factor and one injected code",
      );
    const emailSession = await verifyViewer(
      twoFactor ? await completeSecondFactor(emailSignIn) : emailSignIn,
    );
    const usernameSignIn = await signIn({
      path: "/api/auth/sign-in/username",
      body: { username: adminUsername, password: adminPassword },
      label: "username",
    });
    if (usernameSignIn.twoFactorRequired !== twoFactor)
      throw new Error(
        "email and username sign-in identifiers did not return the same two-factor policy",
      );
    if (twoFactor) {
      log(
        "authenticated username password accepted; two-factor challenge required",
      );
    } else {
      const usernameSession = await verifyViewer(usernameSignIn);
      if (usernameSession.workspaceId !== emailSession.workspaceId)
        throw new Error(
          "authenticated email and username sign-in did not resolve the same workspace",
        );
    }
    const sessionHeaders = { cookie: cookieHeader(emailSession.jar) };
    const idempotencyKey = randomUUID();
    const expectedDisplayName = `Production smoke ${idempotencyKey.slice(0, 8)}`;
    const create = await call("/api/graphql", {
      method: "POST",
      headers: {
        ...sameOrigin,
        ...sessionHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationName: "SmokeCreatePerson",
        query:
          "mutation SmokeCreatePerson($input: CreatePersonInput!) { createPerson(input: $input) { person { id displayName } code } }",
        variables: {
          input: {
            displayName: expectedDisplayName,
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
      headers: {
        ...sameOrigin,
        ...sessionHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationName: "SmokePerson",
        query:
          "query SmokePerson($id: UUID!) { person(id: $id) { id displayName } }",
        variables: { id: personId },
      }),
    });
    await validateSyntheticPersonRead(read, {
      expectedId: personId,
      expectedDisplayName,
    });
    log(
      `authenticated synthetic person read 200 request=${requestId(read.headers)}`,
    );
  }
  if (providerContracts) {
    await providerContractRunner({ env: providerEnv, log });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: pnpm production:smoke -- [--diagnose-provider-config] [--base-url https://host] [--environment-contract] [--authenticated] [--two-factor] [--provider-contracts]\n",
      );
      process.exit(0);
    }
    if (options.diagnoseProviderConfig) {
      process.stdout.write(
        `${JSON.stringify(providerConfigurationDiagnostics(process.env))}\n`,
      );
      process.exit(0);
    }
    const base = parseBaseUrl(
      options.baseUrl ?? process.env.PRODUCTION_SMOKE_URL,
    );
    await runProductionSmoke({
      base,
      auth: options.authenticated || process.env.PRODUCTION_SMOKE_AUTH === "1",
      environmentContract:
        options.environmentContract ||
        process.env.PRODUCTION_SMOKE_ENVIRONMENT_CONTRACT === "1",
      adminEmail: process.env.ADMIN_EMAIL,
      adminUsername: process.env.ADMIN_USERNAME,
      adminPassword: process.env.ADMIN_PASSWORD,
      backupCode: process.env.PRODUCTION_SMOKE_BACKUP_CODE,
      providerContracts: options.providerContracts,
      totpCode: process.env.PRODUCTION_SMOKE_TOTP,
      twoFactor: options.twoFactor || process.env.PRODUCTION_SMOKE_2FA === "1",
    });
    process.stdout.write("production smoke passed\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "production smoke failed"}\n`,
    );
    process.exitCode = 1;
  }
}
