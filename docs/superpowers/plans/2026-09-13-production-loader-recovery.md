# Production loader recovery

## Goal and specification

Advance `HUM-FR-033` by preventing rejected application initialization promises
from permanently poisoning the GraphQL, Better Auth, and storage routes in one
running process. The binding specification is `docs/REQUIREMENTS.md`.

## Global constraints

- Preserve authentication, workspace authorization, redaction, correlation,
  private/no-store responses, and existing route-specific error codes.
- Share one in-flight initialization between concurrent requests and retain a
  successfully initialized handler. Retry only on a later request after failure;
  do not replay a request or retry a mutation.
- Do not change hosted configuration, credentials, database schema, or providers.
- Keep `HUM-FR-033` incomplete: native ESM evaluation failures can remain cached
  by the runtime and require restart; this task does not implement module reload,
  provider outage drills, or the whole-application failure matrix.

## Task 1: Recover failed production handler initialization

1. Read the three production route loaders and existing boundary tests, plus the
   installed Next.js route-handler guide. Verify the focused baseline.
2. Add failing tests against the exported production routes: concurrent requests
   share a failed initialization; later requests retry; recovered routes still
   deny unauthenticated/unsigned requests; successful initialization stays cached.
   Keep infrastructure errors redacted, correlated, and private/no-store.
3. Evict rejected GraphQL and auth initialization promises. Remove the redundant
   storage inner promise cache so its existing retrying boundary owns caching.
   Do not reset successful handlers following a delegated request failure.
4. Update `TODO.md` and `docs/REQUIREMENTS.md` with this bounded evidence.
5. Run focused tests, full unit tests, formatting, lint, typecheck, Drizzle checks,
   GraphQL generation drift checks, and production build. Record exact evidence
   and remaining limitations in the task report; commit for independent review.
