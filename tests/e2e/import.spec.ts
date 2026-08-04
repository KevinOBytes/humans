import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import IORedis from "ioredis";

import { createObjectStore } from "@/lib/storage/s3";
import { parseServerEnv } from "@/lib/env/server-schema";
import { LocalRedisStore } from "@/lib/redis";
import { people } from "@/db/schema/people";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createRuntimeJobRegistry } from "@/worker/runtime";
import { runJobsOnce } from "@/worker/run-once";

import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_REDIS_URL &&
  process.env.TEST_STORAGE_ENDPOINT &&
  process.env.TEST_STORAGE_ACCESS_KEY_ID &&
  process.env.TEST_STORAGE_SECRET_ACCESS_KEY,
);
const fixture = new ResearchFixture();
let actor: Awaited<ReturnType<ResearchFixture["createActor"]>>;

async function authenticate(context: BrowserContext, jar: CookieJar) {
  await context.addCookies(
    jar
      .toString()
      .split(";")
      .flatMap((pair) => {
        const separator = pair.indexOf("=");
        return separator > 0
          ? [
              {
                name: pair.slice(0, separator).trim(),
                value: pair.slice(separator + 1).trim(),
                domain: "127.0.0.1",
                path: "/",
              },
            ]
          : [];
      }),
  );
}

function browserFailures(page: Page) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  // Chromium reports successful bodyless 204 fetches as ERR_ABORTED after the
  // response; the test separately requires verified upload completion.
  page.on("requestfailed", (request) =>
    request.failure()?.errorText === "net::ERR_ABORTED" &&
    (request.url().includes("_rsc=") ||
      (request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/storage/objects"))
      ? undefined
      : failures.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        ),
  );
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

function workerEnvironment() {
  return parseServerEnv({
    NODE_ENV: "test",
    DEPLOYMENT_MODE: "docker",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3106",
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    REDIS_URL: process.env.TEST_REDIS_URL!,
    STORAGE_PROVIDER: "minio",
    STORAGE_ENDPOINT: process.env.TEST_STORAGE_ENDPOINT!,
    STORAGE_REGION: process.env.TEST_STORAGE_REGION ?? "us-east-1",
    STORAGE_BUCKET: process.env.TEST_STORAGE_BUCKET ?? "humans-private",
    STORAGE_ACCESS_KEY_ID: process.env.TEST_STORAGE_ACCESS_KEY_ID!,
    STORAGE_SECRET_ACCESS_KEY: process.env.TEST_STORAGE_SECRET_ACCESS_KEY!,
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_BUCKET_PUBLIC: "false",
    AUTH_SECRET: "auth-fixture-signing-secret-0123456789abcdef0123456789abcdef",
    AUTH_SECURE_COOKIES: "false",
    AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3106",
    AUTH_ENCRYPTION_KEY: "31".repeat(32),
    DATA_ENCRYPTION_KEY: "42".repeat(32),
    PROTECTED_LOOKUP_HMAC_KEY: "53".repeat(32),
    OPERATION_LIMIT_HMAC_KEY: "64".repeat(32),
    TRUSTED_PROXY_MODE: "none",
    ADMIN_EMAIL: "admin@example.test",
    ADMIN_USERNAME: "humans-admin",
    ADMIN_DISPLAY_NAME: "Humans Administrator",
    ADMIN_PASSWORD: "Task11ImportAdministratorPassword!2026",
    RESEND_API_KEY: "resend-fixture-key",
    EMAIL_FROM: "Humans <humans@example.test>",
    AI_PROVIDER: "ollama",
    AI_BASE_URL: "http://127.0.0.1:11434/v1",
    AI_MODEL: "fixture-model",
  });
}

test.beforeAll(async () => {
  if (!enabled) return;
  await fixture.reset();
  actor = await fixture.createActor("owner");
});
test.afterAll(async () => fixture.close());

test("uploads, previews, executes, and displays a real MinIO-backed people import", async ({
  context,
  page,
}) => {
  test.skip(!enabled, "requires PostgreSQL, Redis, and MinIO test services");
  const expectNoFailures = browserFailures(page);
  await authenticate(context, actor.jar);
  await page.goto("/imports");
  await expect(page.getByRole("heading", { name: "Imports" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Evidence" })).toBeVisible();

  await page.getByLabel("Choose file").setInputFiles({
    name: "people.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "external_id,name\ne2e-person,E2E Imported Person\n",
      "utf8",
    ),
  });
  await expect(
    page.getByText("people.csv is verified and available."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(
    page.getByText("Mapping saved. You can now prepare the preview."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Prepare preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Validated preview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Import preview" }),
  ).toContainText("E2E Imported Person");
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(
    page.getByText("Import queued. Its progress is now tracked below."),
  ).toBeVisible();

  const env = workerEnvironment();
  const redisClient = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 0 });
  try {
    await redisClient.flushdb();
    const summary = await runJobsOnce({
      database: fixture.database,
      encryptionKey: env.DATA_ENCRYPTION_KEY,
      redis: new LocalRedisStore(redisClient),
      registry: createRuntimeJobRegistry({
        database: fixture.database,
        encryptionKey: env.DATA_ENCRYPTION_KEY,
        objectStore: createObjectStore(env),
        searchIndexMaintenance: disabledSearchIndexMaintenance,
      }),
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96ca1",
    });
    expect(summary).toMatchObject({ claimed: 1, completed: 1 });
  } finally {
    await redisClient.quit();
  }

  await page.reload();
  await expect(
    page.getByRole("table", { name: "Workspace imports" }),
  ).toContainText("COMPLETED");
  const storedPeople = await fixture.database.select().from(people);
  expect(storedPeople.map((person) => person.displayName)).toContain(
    "E2E Imported Person",
  );
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations,
    axe.violations.map(({ id, help }) => `${id}: ${help}`).join("\n"),
  ).toEqual([]);
  expectNoFailures();
});
