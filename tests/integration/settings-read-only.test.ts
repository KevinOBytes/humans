// @vitest-environment node

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { apiKeys, invitations, members, users } from "@/db/schema/auth";
import { createHumansAuth } from "@/lib/auth/config";
import {
  provisionOrganizationApiKey,
  provisionWorkspace,
} from "@/modules/auth/workspaces";
import {
  SettingsAccessError,
  listSafeWorkspaceDirectory,
} from "@/modules/settings/administration";
import { createSettingsService } from "@/modules/settings/service";
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
  ? createTestConnection(8)
  : undefined;
const database = connection ? createTestDatabase(connection) : undefined;
const liveDescribe = connection ? describe : describe.skip;
const password = ["Settings", "Read", "Only!", "2026", "Safe"].join("");

function headersFor(jar: CookieJar): Headers {
  const headers = new Headers({
    origin: new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin,
  });
  jar.apply(headers);
  return headers;
}

function latestEmailUrl(sender: TestEmailSender): string {
  const message = sender.messages.at(-1);
  const content = `${message?.text ?? ""}\n${message?.html ?? ""}`;
  const match = content.match(/https?:\/\/[^\s<>"]+/u);
  if (!match) throw new Error("Verification URL was not captured.");
  return match[0].replaceAll("&amp;", "&");
}

liveDescribe(
  "read-only settings through real Better Auth and PostgreSQL",
  () => {
    beforeEach(async () => {
      await resetTestDatabase(connection!);
    });

    afterAll(async () => {
      await connection?.end();
    });

    it("returns owner-safe DTOs and denies a live non-administrator", async () => {
      const emailSender = new TestEmailSender();
      const runtime = createHumansAuth({
        database: database!,
        emailSender,
        settings: testAdminEnv,
      });
      expect(
        (
          await authRequest(runtime.handler, "/api/auth/sign-up/email", {
            body: {
              name: "Settings Owner",
              email: "settings-owner@example.test",
              username: "SettingsOwner",
              displayUsername: "SettingsOwner",
              password,
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (await runtime.handler(new Request(latestEmailUrl(emailSender))))
          .status,
      ).toBeLessThan(400);

      const jar = new CookieJar();
      expect(
        (
          await authRequest(runtime.handler, "/api/auth/sign-in/email", {
            body: { email: "settings-owner@example.test", password },
            jar,
          })
        ).status,
      ).toBe(200);
      const [user] = await database!
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "settings-owner@example.test"));
      const workspace = await provisionWorkspace(database!, {
        userId: user!.id,
        name: "Settings workspace",
        slug: `settings-${newId()}`,
      });
      expect(
        (
          await authRequest(
            runtime.handler,
            "/api/auth/organization/set-active",
            {
              body: { organizationId: workspace.organizationId },
              jar,
            },
          )
        ).status,
      ).toBe(200);

      const invitationId = `invitation-${newId()}`;
      await database!.insert(invitations).values({
        id: invitationId,
        organizationId: workspace.organizationId,
        email: "pending@example.test",
        role: "viewer",
        status: "pending",
        expiresAt: new Date("2026-08-03T11:59:59.000Z"),
        inviterId: user!.id,
      });
      const createdKey = await provisionOrganizationApiKey({
        auth: runtime,
        database: database!,
        headers: headersFor(jar),
        name: "Settings read test",
        permissions: { person: ["read"] },
      });

      const directory = await listSafeWorkspaceDirectory({
        auth: runtime,
        headers: headersFor(jar),
        now: new Date("2026-08-03T12:00:00.000Z"),
      });
      const settingsService = createSettingsService({
        actor: {
          type: "user",
          id: user!.id,
          principalId: workspace.principalId,
          sessionId: "settings-test-session",
          memberId: workspace.memberId,
          role: "owner",
        },
        database: database!,
        workspaceId: workspace.workspaceId,
      });
      const keys = await settingsService.listOrganizationApiKeys(0);
      const serialized = JSON.stringify({ directory, keys });

      expect(directory.members.nodes).toEqual([
        expect.objectContaining({
          displayName: "Settings Owner",
          email: "settings-owner@example.test",
          role: "owner",
        }),
      ]);
      expect(directory.invitations).toEqual([
        expect.objectContaining({
          email: "pending@example.test",
          role: "viewer",
          status: "expired",
        }),
      ]);
      expect(keys.nodes).toEqual([
        expect.objectContaining({
          name: "Settings read test",
          scopes: ["person:read"],
        }),
      ]);
      expect(serialized).not.toContain(createdKey.key);
      expect(serialized).not.toContain(createdKey.id);
      expect(serialized).not.toContain(invitationId);
      expect(serialized).not.toContain(workspace.organizationId);
      expect(serialized).not.toContain(workspace.memberId);
      await expect(
        createSettingsService({
          actor: {
            type: "user",
            id: user!.id,
            principalId: workspace.principalId,
            sessionId: "settings-test-session",
            memberId: workspace.memberId,
            role: "owner",
          },
          database: database!,
          workspaceId: workspace.workspaceId,
        }).readPolicySettings(),
      ).resolves.toMatchObject({
        workspace: { name: "Settings workspace" },
      });

      const pagedUsers = Array.from({ length: 101 }, (_, index) => ({
        id: `paged-user-${String(index).padStart(3, "0")}`,
        name: `Paged Member ${String(index).padStart(3, "0")}`,
        email: `paged-member-${String(index).padStart(3, "0")}@example.test`,
        emailVerified: true,
      }));
      await database!.insert(users).values(pagedUsers);
      await database!.insert(members).values(
        pagedUsers.map((pagedUser, index) => ({
          id: `paged-member-${String(index).padStart(3, "0")}`,
          organizationId: workspace.organizationId,
          userId: pagedUser.id,
          role: "viewer",
          createdAt: new Date(
            `2026-08-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          ),
          workspaceId: workspace.workspaceId,
        })),
      );
      await database!.insert(apiKeys).values(
        Array.from({ length: 101 }, (_, index) => ({
          id: `paged-key-${String(index).padStart(3, "0")}`,
          configId: "organization",
          name: `Paged key ${String(index).padStart(3, "0")}`,
          start: String(index).padStart(6, "0"),
          prefix: "hum_",
          referenceId: workspace.organizationId,
          key: `stored-secret-${String(index).padStart(3, "0")}`,
          enabled: true,
          createdAt: new Date("2026-08-02T00:00:00.000Z"),
          updatedAt: new Date("2026-08-02T00:00:00.000Z"),
          permissions: JSON.stringify({ person: ["read"] }),
          workspaceId: workspace.workspaceId,
        })),
      );

      const directoryPages = [];
      for (const memberOffset of [0, 25, 50, 75, 100]) {
        directoryPages.push(
          await listSafeWorkspaceDirectory({
            auth: runtime,
            headers: headersFor(jar),
            memberOffset,
          }),
        );
      }
      const firstDirectoryPage = directoryPages[0]!;
      const lastDirectoryPage = directoryPages[4]!;
      const firstKeyPage = await settingsService.listOrganizationApiKeys(0);
      const lastKeyPage = await settingsService.listOrganizationApiKeys(100);
      for (const page of [firstDirectoryPage.members, firstKeyPage]) {
        expect(page).toMatchObject({
          offset: 0,
          limit: 25,
          total: 102,
          hasPrevious: false,
          hasMore: true,
        });
        expect(page.nodes).toHaveLength(25);
      }
      for (const page of [lastDirectoryPage.members, lastKeyPage]) {
        expect(page).toMatchObject({
          offset: 100,
          limit: 25,
          total: 102,
          hasPrevious: true,
          hasMore: false,
        });
        expect(page.nodes).toHaveLength(2);
      }
      const everyMember = directoryPages.flatMap((page) => page.members.nodes);
      const everyMemberEmail = everyMember.map((member) => member.email);
      expect(everyMember).toHaveLength(102);
      expect(new Set(everyMemberEmail)).toHaveLength(102);
      expect(new Set(everyMemberEmail)).toEqual(
        new Set([
          "settings-owner@example.test",
          ...pagedUsers.map((pagedUser) => pagedUser.email),
        ]),
      );
      expect(JSON.stringify({ firstKeyPage, lastKeyPage })).not.toContain(
        "stored-secret-",
      );

      await database!
        .update(members)
        .set({ role: "viewer" })
        .where(eq(members.id, workspace.memberId));
      await expect(
        listSafeWorkspaceDirectory({
          auth: runtime,
          headers: headersFor(jar),
          memberOffset: 25,
        }),
      ).rejects.toBeInstanceOf(SettingsAccessError);
      await expect(
        createSettingsService({
          actor: {
            type: "user",
            id: user!.id,
            principalId: workspace.principalId,
            sessionId: "settings-test-session",
            memberId: workspace.memberId,
            role: "owner",
          },
          database: database!,
          workspaceId: workspace.workspaceId,
        }).readPolicySettings(),
      ).rejects.toThrow("Workspace settings require an administrator session.");
    });
  },
);
