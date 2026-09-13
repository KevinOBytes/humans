# Invitation lifecycle matrix

## Context

HUM-FR-004 has application-owned workspace invitation issue/resend/cancel,
member management, encrypted email outbox delivery, and atomic recipient
acceptance. Existing local evidence covers the happy path and selected race
boundaries, but it does not prove that a Resend/provider outage leaves the
invitation usable and retryable through the generated GraphQL boundary.

## Global constraints

- Keep all writes workspace-scoped and transactionally authorized.
- Preserve principal-bound idempotency, redacted audit records, and encrypted
  invitation payloads.
- Provider failures must not leak credentials, message bodies, or provider
  diagnostics, and must not roll back a committed invitation.
- Do not claim hosted Resend/provider acceptance from local evidence.
- Use generated GraphQL operations for application acceptance coverage.

## Task 1

Add a real PostgreSQL/generated GraphQL regression for a configured email
provider failure during invitation issuance. The mutation must return the
durable applied result, retain a pending invitation and one encrypted queued
outbox intent with a stable retry error, and allow a later worker retry with the
same provider idempotency key to complete delivery. Assert redacted database
and response state. Add the bounded evidence to REQUIREMENTS.md and TODO.md.

Run the focused integration test and the repository quality gates before
committing. No production behavior change is expected unless the new test
demonstrates a failing contract.
