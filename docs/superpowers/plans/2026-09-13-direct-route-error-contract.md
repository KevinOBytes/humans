# Direct-route error and correlation contract

## Context

The application has a centralized redacted GraphQL error boundary and typed
invitation/2FA clients, but the release matrix still calls out adoption across
every direct route. This tranche audits the remaining concrete route handlers
and closes any missing stable status/code/request-ID/no-store behavior without
changing route-specific authorization semantics.

## Constraints

- Preserve route-specific public codes and existing status behavior unless a
  missing contract is demonstrated by a test.
- Never include secrets, provider payloads, stack traces, credentials, or
  arbitrary exception messages in responses or audit events.
- Use validated/header-authoritative correlation IDs and `private, no-store`.
- Keep production route initialization lazy and fail closed.
- Update both requirements documents only with measured evidence.

## Task

Inventory every handler under `src/app/api`, add focused tests for any route
that lacks the stable redacted error envelope, correlation header/body, and
cache policy, and implement the smallest fixes needed for the complete direct
route set. Include malformed JSON, method denial, dependency failure, and
authorization cases where applicable. Do not claim hosted/provider completion.

## Verification

Run the focused route-contract tests, full unit suite, formatting, lint,
typecheck, Drizzle/codegen drift, and production build. Report remaining
whole-product/provider evidence explicitly.
