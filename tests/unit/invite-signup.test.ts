// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createAuthRouteHandlers } from "@/app/api/auth/[...all]/route";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { createTransactionalInviteSignUpHandler } from "@/modules/auth/invite-signup";

function databaseWithTransaction(
  transaction: (
    callback: (transaction: Database) => Promise<unknown>,
  ) => Promise<unknown>,
): Database {
  return { transaction } as unknown as Database;
}

describe("transactional invitation signup", () => {
  it.each(["construction", "callback", "commit"] as const)(
    "contains a %s failure without running post-commit work",
    async (failure) => {
      const afterCommit = vi.fn();
      const transaction = vi.fn(
        async (callback: (transaction: Database) => Promise<unknown>) => {
          if (failure === "construction")
            throw new Error("construction failed");
          const result = await callback({} as Database);
          if (failure === "commit") throw new Error("commit failed");
          return result;
        },
      );
      const transactionalHandler = createTransactionalInviteSignUpHandler({
        database: databaseWithTransaction(transaction),
        createHandler: () => ({
          afterCommit,
          handler: async () => {
            if (failure === "callback") throw new Error("callback failed");
            return Response.json({ ok: true });
          },
        }),
      });

      const logger = { log: vi.fn() };
      const handler = createAuthRouteHandlers(
        async () => ({ POST: transactionalHandler }),
        logger,
      ).POST;
      const response = await handler(
        new Request("https://humans.example.test/api/auth/sign-up/email", {
          headers: {
            "x-request-id": "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1",
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-request-id")).toBe(
        "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      );
      expect(await response.text()).not.toContain(`${failure} failed`);
      expect(logger.log).toHaveBeenCalledWith({
        event: "auth.infrastructure.failure",
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
        severity: "error",
      });
      expect(afterCommit).not.toHaveBeenCalled();
    },
  );

  it("runs post-commit work only after transaction resolution and contains its failure", async () => {
    const order: string[] = [];
    const postCommitFailure = vi.fn();
    const handler = createTransactionalInviteSignUpHandler({
      database: databaseWithTransaction(async (callback) => {
        const result = await callback({} as Database);
        order.push("committed");
        return result;
      }),
      createHandler: () => ({
        handler: async () => {
          order.push("handled");
          return Response.json({ ok: true });
        },
        afterCommit: async () => {
          order.push("post-commit");
          throw new Error("provider detail");
        },
      }),
      onPostCommitFailure: postCommitFailure,
    });

    const response = await handler(
      new Request("https://humans.example.test/api/auth/sign-up/email"),
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["handled", "committed", "post-commit"]);
    expect(postCommitFailure).toHaveBeenCalledOnce();
  });
});
