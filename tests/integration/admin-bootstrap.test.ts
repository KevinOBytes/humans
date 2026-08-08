// @vitest-environment node

import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { accounts, users } from "@/db/schema/auth";
import { createHumansAuth } from "@/lib/auth/config";
import { parseBootstrapAdminEnv } from "@/lib/env/server-schema";
import { bootstrapAdmin } from "@/modules/auth/bootstrap-admin";
import {
  CookieJar,
  TestEmailSender,
  authRequest,
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
  testAdminEnv,
} from "../support/auth";

const connection = process.env.TEST_DATABASE_URL
  ? createTestConnection(12)
  : undefined;
const database = connection ? createTestDatabase(connection) : undefined;
const liveDescribe = connection ? describe : describe.skip;

liveDescribe("administrator bootstrap", () => {
  beforeAll(async () => {
    if (connection) await resetTestDatabase(connection);
  });

  beforeEach(async () => {
    if (connection) await resetTestDatabase(connection);
  });

  afterAll(async () => {
    await connection?.end();
  });

  it("creates one verified global administrator and credential", async () => {
    const result = await bootstrapAdmin(database!, testAdminEnv);
    expect(result).toEqual({
      userId: expect.any(String),
      created: true,
      reconciled: false,
    });

    const [user] = await database!
      .select()
      .from(users)
      .where(eq(users.id, result.userId));
    expect(user).toMatchObject({
      email: testAdminEnv.ADMIN_EMAIL,
      emailVerified: true,
      username: testAdminEnv.ADMIN_USERNAME,
      displayUsername: testAdminEnv.ADMIN_USERNAME,
      name: testAdminEnv.ADMIN_DISPLAY_NAME,
      role: "admin",
    });

    const credentials = await database!
      .select()
      .from(accounts)
      .where(eq(accounts.userId, result.userId));
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      accountId: result.userId,
      providerId: "credential",
    });
    expect(credentials[0]?.password).toBeTruthy();
  });

  it("is idempotent and returns the same user without another credential", async () => {
    const first = await bootstrapAdmin(database!, testAdminEnv);
    const second = await bootstrapAdmin(database!, testAdminEnv);

    expect(second).toEqual({
      userId: first.userId,
      created: false,
      reconciled: false,
    });
    expect(
      await database!
        .select()
        .from(accounts)
        .where(eq(accounts.userId, first.userId)),
    ).toHaveLength(1);
  });

  it("uses validated environment values to recover a missing credential without retaining its password", async () => {
    const bootstrapEnv = parseBootstrapAdminEnv({
      NODE_ENV: "test",
      ADMIN_EMAIL: "  Recovered.Admin@Example.test  ",
      ADMIN_USERNAME: "  recovered-admin  ",
      ADMIN_DISPLAY_NAME: "  Recovered Administrator  ",
      ADMIN_PASSWORD: "Bootstrap recovery password! 2026",
    });
    expect(bootstrapEnv).toMatchObject({
      ADMIN_EMAIL: "recovered.admin@example.test",
      ADMIN_USERNAME: "recovered-admin",
      ADMIN_DISPLAY_NAME: "Recovered Administrator",
      ADMIN_PASSWORD: "Bootstrap recovery password! 2026",
    });
    const first = await bootstrapAdmin(database!, bootstrapEnv);
    const second = await bootstrapAdmin(database!, bootstrapEnv);

    await database!.delete(accounts).where(eq(accounts.userId, first.userId));

    const recovered = await bootstrapAdmin(database!, bootstrapEnv);
    const [user] = await database!
      .select()
      .from(users)
      .where(eq(users.id, first.userId));
    const credentials = await database!
      .select()
      .from(accounts)
      .where(eq(accounts.userId, first.userId));
    const observable = JSON.stringify({
      first,
      second,
      recovered,
      user,
      credentials,
    });

    expect(second).toEqual({
      userId: first.userId,
      created: false,
      reconciled: false,
    });
    expect(recovered).toEqual({
      userId: first.userId,
      created: false,
      reconciled: true,
    });
    expect(user).toMatchObject({
      email: "recovered.admin@example.test",
      username: "recovered-admin",
      displayUsername: "recovered-admin",
      name: "Recovered Administrator",
      role: "admin",
    });
    expect(credentials).toHaveLength(1);
    await expect(
      verifyPassword({
        hash: credentials[0]!.password!,
        password: bootstrapEnv.ADMIN_PASSWORD,
      }),
    ).resolves.toBe(true);
    expect(observable).not.toContain(bootstrapEnv.ADMIN_PASSWORD);
  });

  it("converges two concurrent calls on one user and one credential", async () => {
    const [first, second] = await Promise.all([
      bootstrapAdmin(database!, testAdminEnv),
      bootstrapAdmin(database!, testAdminEnv),
    ]);
    expect(first.userId).toBe(second.userId);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);

    const matchingUsers = await database!
      .select()
      .from(users)
      .where(eq(users.email, testAdminEnv.ADMIN_EMAIL));
    const credentials = await database!
      .select()
      .from(accounts)
      .where(eq(accounts.userId, first.userId));
    expect(matchingUsers).toHaveLength(1);
    expect(credentials).toHaveLength(1);
  });

  it("fails closed when configured email and username resolve to different users", async () => {
    const now = new Date();
    await database!.insert(users).values([
      {
        id: "collision-email-user",
        name: "Email owner",
        email: testAdminEnv.ADMIN_EMAIL,
        emailVerified: true,
        username: "different-name",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "collision-username-user",
        name: "Username owner",
        email: "different@example.test",
        emailVerified: true,
        username: testAdminEnv.ADMIN_USERNAME,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await expect(bootstrapAdmin(database!, testAdminEnv)).rejects.toThrow(
      "Configured administrator identity is ambiguous",
    );
  });

  it("reconciles identity without replacing an existing credential hash", async () => {
    const initial = await bootstrapAdmin(database!, testAdminEnv);
    const changedHash = await hashPassword(
      "A separately changed password! 2026",
    );
    await database!
      .update(accounts)
      .set({ password: changedHash })
      .where(eq(accounts.userId, initial.userId));
    await database!
      .update(users)
      .set({ emailVerified: false, name: "Stale Name", role: "user" })
      .where(eq(users.id, initial.userId));

    const result = await bootstrapAdmin(database!, testAdminEnv);
    const [credential] = await database!
      .select()
      .from(accounts)
      .where(eq(accounts.userId, initial.userId));
    expect(result).toEqual({
      userId: initial.userId,
      created: false,
      reconciled: true,
    });
    expect(credential?.password).toBe(changedHash);
  });

  it("uses Better Auth's password format for the initial credential", async () => {
    const result = await bootstrapAdmin(database!, testAdminEnv);
    const [credential] = await database!
      .select()
      .from(accounts)
      .where(eq(accounts.userId, result.userId));
    await expect(
      verifyPassword({
        hash: credential!.password!,
        password: testAdminEnv.ADMIN_PASSWORD,
      }),
    ).resolves.toBe(true);
  });

  it("supports authenticated login after the explicit bootstrap", async () => {
    await bootstrapAdmin(database!, testAdminEnv);
    const runtime = createHumansAuth({
      database: database!,
      emailSender: new TestEmailSender(),
      settings: testAdminEnv,
    });
    const jar = new CookieJar();

    const response = await authRequest(
      runtime.handler,
      "/api/auth/sign-in/email",
      {
        body: {
          email: testAdminEnv.ADMIN_EMAIL,
          password: testAdminEnv.ADMIN_PASSWORD,
        },
        jar,
      },
    );

    expect(response.status).toBe(200);
    expect(jar.toString()).not.toBe("");
  });

  it("never returns or logs password material", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await bootstrapAdmin(database!, testAdminEnv);
      const [credential] = await database!
        .select()
        .from(accounts)
        .where(eq(accounts.userId, result.userId));
      const observable = JSON.stringify({
        result,
        log: log.mock.calls,
        error: error.mock.calls,
      });
      expect(observable).not.toContain(testAdminEnv.ADMIN_PASSWORD);
      expect(observable).not.toContain(credential!.password!);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps migration separate from the explicit bootstrap entrypoint", async () => {
    const [migrationSource, bootstrapSource] = await Promise.all([
      readFile("src/db/migrate.ts", "utf8"),
      readFile("src/db/bootstrap-admin-entry.ts", "utf8"),
    ]);

    expect(migrationSource).toContain("await migrate(");
    expect(migrationSource).not.toContain("bootstrapAdmin");
    expect(bootstrapSource).toContain("await bootstrapAdmin(");
    expect(bootstrapSource).toContain("parseBootstrapAdminEnv(process.env)");
    expect(bootstrapSource).toContain("invokedPath === import.meta.url");
  });
});
