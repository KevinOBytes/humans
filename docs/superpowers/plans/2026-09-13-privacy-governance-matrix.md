# Privacy governance matrix tranche

## Context

The privacy model already has workspace-scoped consent, retention policies,
legal holds, staged privacy requests, processor propagation, and a deletion
worker. The remaining bounded gap is a retention worker using policy rows read
before the workspace lock. A concurrent policy edit can therefore queue a
request using stale retention days, deletion behavior, and policy version.

## Global constraints

- Preserve workspace-leading tenant keys, least-privilege authorization,
  legal-hold fencing, redacted immutable audit, and idempotency.
- The worker only queues reviewable requests; it must never delete directly.
- Revalidate policy state after taking the workspace advisory lock.
- Add tests before production code and update requirements ledgers only with
  evidence-backed bounded claims.
- Do not claim hosted/provider/browser evidence.

## Task 1 — Revalidate retention policy under the workspace lock

Add a small pure policy-snapshot comparison helper with tests for unchanged,
version-changed, deleted, and behavior/interval-changed rows. Use it in the
retention worker after acquiring the workspace policy lock, reloading the
current policy and skipping stale candidates. Add a gated PostgreSQL regression
test documenting concurrent policy-update revalidation if the existing live
fixture can support it without altering unrelated tests. Run focused unit
tests, format, lint, typecheck, database/schema checks, and build.

## Scan

| Pair | Shared surface | Finding | Ruling |
|---|---|---|---|
| Task 1 / existing settings mutations | `retentionPolicies`, workspace advisory lock | Settings already serialize policy writes through the same lock; worker must acquire it before reading current policy. | Revalidate inside the worker transaction; no settings changes. |
| Task 1 / existing deletion worker | `privacyRequests`, legal holds | Retention only queues `requested`; deletion remains independently reviewed and hold-fenced. | Preserve staged workflow and do not broaden deletion behavior. |
| Task 1 / graph tranche | None | Graph editor files are out of scope. | Avoid graph files entirely. |
| Task 1 self-consistency | `retention-worker.ts`, unit/integration tests, ledgers | Snapshot helper can be tested without PostgreSQL; live test remains gated. | Commit only after focused and relevant gates pass. |

Ruling: stale policy rows must never create new retention requests — the cost
if wrong is delaying a queue until the next worker pass, which is safer than
processing under an obsolete policy.
