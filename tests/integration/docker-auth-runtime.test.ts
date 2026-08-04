// @vitest-environment node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const runSmoke = process.env.RUN_DOCKER_AUTH_SMOKE === "true";
const dockerDescribe = runSmoke ? describe : describe.skip;
const executeFile = promisify(execFile);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a Docker smoke-test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function docker(args: string[]): Promise<string> {
  const result = await executeFile("docker", args, {
    env: {
      DOCKER_HOST: process.env.DOCKER_HOST,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      PATH: process.env.PATH,
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return `${result.stdout}${result.stderr}`;
}

dockerDescribe("Docker auth runtime", () => {
  it("builds without runtime secrets and initializes auth only after container start", async () => {
    const suffix = randomBytes(6).toString("hex");
    const image = `humans-auth-smoke:${suffix}`;
    const container = `humans-auth-smoke-${suffix}`;
    const port = await availablePort();
    const runtimeSecrets = {
      auth: randomBytes(32).toString("hex"),
      authEncryption: randomBytes(32).toString("hex"),
      database: randomBytes(18).toString("base64url"),
      dataEncryption: randomBytes(32).toString("hex"),
      redis: randomBytes(18).toString("base64url"),
      storage: randomBytes(24).toString("hex"),
      resend: randomBytes(24).toString("hex"),
    };

    try {
      await docker(["build", "--tag", image, "."]);
      await docker([
        "run",
        "--detach",
        "--name",
        container,
        "--publish",
        `127.0.0.1:${port}:3000`,
        "--env",
        "NODE_ENV=production",
        "--env",
        "DEPLOYMENT_MODE=docker",
        "--env",
        `NEXT_PUBLIC_APP_URL=http://127.0.0.1:${port}`,
        "--env",
        `DATABASE_URL=postgresql://runtime:${runtimeSecrets.database}@127.0.0.1:5432/runtime`,
        "--env",
        `REDIS_URL=redis://default:${runtimeSecrets.redis}@127.0.0.1:6379`,
        "--env",
        "STORAGE_PROVIDER=minio",
        "--env",
        "STORAGE_ENDPOINT=http://127.0.0.1:9000",
        "--env",
        "STORAGE_REGION=us-east-1",
        "--env",
        "STORAGE_BUCKET=humans-private",
        "--env",
        "STORAGE_ACCESS_KEY_ID=runtime-fixture",
        "--env",
        `STORAGE_SECRET_ACCESS_KEY=${runtimeSecrets.storage}`,
        "--env",
        "STORAGE_FORCE_PATH_STYLE=true",
        "--env",
        "STORAGE_BUCKET_PUBLIC=false",
        "--env",
        `AUTH_SECRET=${runtimeSecrets.auth}`,
        "--env",
        "AUTH_SECURE_COOKIES=true",
        "--env",
        `AUTH_TRUSTED_ORIGINS=http://127.0.0.1:${port}`,
        "--env",
        `AUTH_ENCRYPTION_KEY=${runtimeSecrets.authEncryption}`,
        "--env",
        `DATA_ENCRYPTION_KEY=${runtimeSecrets.dataEncryption}`,
        "--env",
        `RESEND_API_KEY=${runtimeSecrets.resend}`,
        "--env",
        "EMAIL_FROM=Humans <humans@localhost.invalid>",
        "--env",
        "AI_PROVIDER=ollama",
        "--env",
        "AI_BASE_URL=http://127.0.0.1:11434/v1",
        "--env",
        "AI_MODEL=fixture-model",
        image,
        "app",
      ]);

      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          response = await fetch(`http://127.0.0.1:${port}/api/auth/ok`);
          if (response.ok) break;
        } catch {
          // The container may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const logs = await docker(["logs", container]);
      expect(response?.status, logs).toBe(200);
      await expect(response!.json()).resolves.toEqual({ ok: true });
      for (const secret of Object.values(runtimeSecrets)) {
        expect(logs).not.toContain(secret);
      }
    } finally {
      await docker(["rm", "--force", container]).catch(() => undefined);
      await docker(["image", "rm", "--force", image]).catch(() => undefined);
    }
  }, 300_000);
});
