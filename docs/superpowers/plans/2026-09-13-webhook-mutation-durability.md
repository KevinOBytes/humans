# Next production closure — webhook mutation durability

## Context

The Humans GraphQL monolith already has workspace-scoped webhook create, secret rotation, disable, and test-delivery flows. The test-delivery path has durable replay protection, but administrative create/rotate/disable mutations still return one-time secrets or state changes without principal-bound durable response references. This leaves a concrete gap in `HUM-FR-024` and `HUM-NFR-008`.

## Global constraints

- Preserve workspace-leading tenant keys, least-privilege administrator authorization, audit redaction, secret-envelope encryption, and optimistic version semantics.
- Webhook secret plaintext may be returned only to the first successful executor; replay must never expose it again.
- Browser code uses generated GraphQL operations only; do not add direct repository access.
- Do not weaken unkeyed legacy callers if compatibility is explicitly supported; new keyed paths must be fail-closed and principal-bound.
- Use TDD with disposable PostgreSQL acceptance, generated GraphQL drift checks, and Node 24/pnpm 11.11.0 gates.
- Do not commit `.env`, credentials, logs, dumps, or agent state.

## Task 1 — Durable webhook administration mutations

Add durable principal-bound HMAC response-reference idempotency to generated GraphQL `createWebhook`, `rotateWebhookSecret`, and `disableWebhook`. Preserve the one-time secret contract for first create/rotate execution and return a redacted/secretless replay result for later retries. Bind request material, workspace, principal, current webhook identity/version, and audit effect; reject malformed references, changed material, stale versions, expired claims, foreign workspaces, and unauthorized actors. Extend the webhook integration matrix to cover concurrent convergence, one-time secret presentation, replay secrecy, expiry takeover, malformed references, optimistic/version fencing, audit deduplication, and workspace/principal isolation. Regenerate GraphQL artifacts. Update the scoped TODO/requirements evidence while keeping `HUM-FR-024` and `HUM-NFR-008` incomplete until broader provider/browser matrices are proven.
