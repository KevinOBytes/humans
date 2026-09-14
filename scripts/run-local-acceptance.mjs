import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { providerConfigurationDiagnostics } from "./production-readiness-smoke.mjs";

export const acceptanceContractTests = [
  "tests/unit/direct-route-method-contract.test.ts",
  "tests/unit/direct-route-input-contract.test.ts",
  "tests/unit/auth-request-boundary.test.ts",
  "tests/unit/auth-route-boundary.test.ts",
  "tests/unit/auth-route-import-boundary.test.ts",
  "tests/unit/invitation-acceptance-route.test.ts",
  "tests/unit/invitation-handoff.test.ts",
  "tests/unit/two-factor-disable-route.test.ts",
  "tests/unit/jobs-route.test.ts",
  "tests/unit/storage-route-boundary.test.ts",
  "tests/unit/storage-not-found-route.test.ts",
  "tests/integration/health.test.ts",
  "tests/unit/graphql-route-boundary.test.ts",
  "tests/unit/graphql-error-contract.test.ts",
  "tests/unit/graphql-server-error-contract.test.ts",
  "tests/unit/local-acceptance-runner.test.ts",
  "tests/unit/provider-acceptance-diagnostics.test.ts",
  "tests/unit/provider-adapter-contract.test.ts",
  "tests/unit/ai-provider.test.ts",
  "tests/unit/resend-email.test.ts",
  "tests/unit/infrastructure-config.test.ts",
  "tests/unit/compose-config.test.ts",
];

const childRuntimeVariables = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
];

export function localAcceptanceChildEnvironment(env = {}) {
  return {
    ...Object.fromEntries(
      childRuntimeVariables
        .filter((name) => env[name] !== undefined)
        .map((name) => [name, env[name]]),
    ),
    NODE_ENV: "test",
  };
}

async function executeVitest({ args, env }) {
  const vitest = resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [vitest, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.once("error", () => {
      reject(new Error("local acceptance test runner could not start"));
    });
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode: exitCode ?? 1 });
    });
  });
}

export async function runLocalAcceptance({
  env = process.env,
  execute = executeVitest,
  log = (line) => process.stdout.write(`${line}\n`),
  testsOnly = false,
} = {}) {
  const childEnv = localAcceptanceChildEnvironment(env);
  const result = await execute({
    args: ["run", ...acceptanceContractTests, "--no-file-parallelism"],
    env: childEnv,
  });
  if (result.exitCode !== 0) {
    throw new Error("local acceptance contracts failed");
  }
  if (!testsOnly) {
    log(JSON.stringify(providerConfigurationDiagnostics(childEnv)));
  }
  return { exitCode: 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = process.argv.slice(2);
    if (options.some((option) => option !== "--tests-only")) {
      throw new Error("unknown local acceptance option");
    }
    await runLocalAcceptance({ testsOnly: options.includes("--tests-only") });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "local acceptance failed"}\n`,
    );
    process.exitCode = 1;
  }
}
