#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const enabled = /^(1|true|yes)$/iu.test(process.env.OLLAMA_SMOKE ?? "");
if (!enabled) {
  process.stdout.write(
    "Ollama smoke skipped: set OLLAMA_SMOKE=1 to run the opt-in model acceptance check.\n",
  );
  process.exit(0);
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const project = `humans-ollama-${suffix}`;
const model = process.env.OLLAMA_MODEL?.trim() || "llama3.2:3b";
const image = process.env.HUMANS_IMAGE?.trim() || "humans:local";

function secret(bytes = 24) {
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

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code ?? signal}: ${stderr}`));
    });
  });
}

const appPort = await availablePort();
const appUrl = `http://127.0.0.1:${appPort}`;
const environment = {
  ...process.env,
  APP_PORT: String(appPort),
  NEXT_PUBLIC_APP_URL: appUrl,
  AUTH_TRUSTED_ORIGINS: appUrl,
  MINIO_CORS_ALLOW_ORIGIN: appUrl,
  HUMANS_IMAGE: image,
  POSTGRES_DB: "humans",
  POSTGRES_USER: "humans",
  POSTGRES_PASSWORD: secret(),
  REDIS_PASSWORD: secret(),
  MINIO_ROOT_USER: `ollama-${suffix}`,
  MINIO_ROOT_PASSWORD: secret(),
  STORAGE_BUCKET: `humans-private-${suffix}`,
  AUTH_SECRET: secret(32),
  AUTH_ENCRYPTION_KEY: secret(32),
  DATA_ENCRYPTION_KEY: secret(32),
  PROTECTED_LOOKUP_HMAC_KEY: secret(32),
  OPERATION_LIMIT_HMAC_KEY: secret(32),
  AUTH_REGISTRATION_MODE: "public",
  RESEND_API_KEY: `re_test_${secret(16)}`,
  AI_PROVIDER: "ollama",
  AI_BASE_URL: "http://ollama:11434/v1",
  AI_MODEL: model,
};

const compose = [
  "compose",
  "--project-name",
  project,
  "--file",
  "docker-compose.yml",
  "--file",
  "docker-compose.ollama.yml",
  "--profile",
  "ollama",
];
let started = false;

async function composeRun(args, options) {
  return run("docker", [...compose, ...args], options);
}

async function waitFor(predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result === true) return;
      lastError = String(result);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function ollamaList() {
  const result = await composeRun(
    ["exec", "--no-TTY", "ollama", "ollama", "list"],
    { capture: true },
  );
  return result.stdout;
}

async function ollamaChat() {
  const script = [
    "const response = await fetch('http://ollama:11434/v1/chat/completions', {",
    "method: 'POST', headers: {'content-type':'application/json'},",
    `body: JSON.stringify({model:${JSON.stringify(model)},messages:[{role:'user',content:'Reply with exactly: humans-smoke'}],max_tokens:16,temperature:0})});`,
    "const body = await response.json();",
    "if (!response.ok || typeof body?.choices?.[0]?.message?.content !== 'string') { console.error(JSON.stringify(body)); process.exit(1); }",
  ].join(" ");
  await composeRun([
    "exec",
    "--no-TTY",
    "app",
    "/nodejs/bin/node",
    "--input-type=module",
    "-e",
    script,
  ]);
}

async function main() {
  await composeRun(["config", "--quiet"]);
  await composeRun([
    "up",
    "--detach",
    "--build",
    "ollama-init",
    "app",
    "worker",
  ]);
  started = true;

  await waitFor(async () => {
    const output = await ollamaList();
    return output.includes(model) || `model ${model} not listed`;
  }, "Ollama model");
  await ollamaChat();

  await waitFor(async () => {
    const response = await fetch(`${appUrl}/api/health/live`);
    const text = await response.text();
    return (response.ok && text.includes('"status":"ok"')) || text;
  }, "application health");
  process.stdout.write(
    `Ollama smoke passed for model ${model} and application ${appUrl}.\n`,
  );
}

try {
  await main();
} finally {
  if (started) {
    await composeRun(["down", "--volumes", "--remove-orphans"]).catch(
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
      },
    );
  }
}
