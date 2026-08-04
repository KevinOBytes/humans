import "server-only";

import type { Database } from "@/modules/auth/bootstrap-admin";

class SignupTransactionResponse extends Error {
  constructor(readonly response: Response) {
    super("The transactional sign-up request was rejected");
  }
}

/**
 * Keeps the invitation row lock acquired by the registration policy alive
 * through the Better Auth user/account transaction. A rejected handler result
 * rolls the outer transaction back before its generic response is returned.
 */
export function createTransactionalInviteSignUpHandler(input: {
  createHandler(database: Database):
    | ((request: Request) => Promise<Response>)
    | {
        afterCommit?(): Promise<void> | void;
        handler(request: Request): Promise<Response>;
      };
  database: Database;
  onPostCommitFailure?(request: Request): void;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const committed = await input.database.transaction(
        async (transaction) => {
          const created = input.createHandler(
            transaction as unknown as Database,
          );
          const handler =
            typeof created === "function" ? created : created.handler;
          const result = await handler(request);
          if (!result.ok) throw new SignupTransactionResponse(result);
          return {
            afterCommit:
              typeof created === "function" ? undefined : created.afterCommit,
            response: result,
          };
        },
      );
      try {
        await committed.afterCommit?.();
      } catch {
        input.onPostCommitFailure?.(request);
      }
      return committed.response;
    } catch (error) {
      if (error instanceof SignupTransactionResponse) return error.response;
      throw error;
    }
  };
}
