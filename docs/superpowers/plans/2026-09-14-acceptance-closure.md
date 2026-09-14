# Acceptance closure tranche — implementation plan

> **For the implementing agent:** use the subagent-driven-development workflow
> and do not claim a requirement complete without matching runtime evidence.

**Goal:** advance three bounded remaining acceptance areas while preserving all
workspace, consent, provenance, redaction, audit, and human-review invariants.

**Workflow:** each task is isolated in its own worktree, uses TDD, runs its
focused tests plus Node 24 quality gates, records a report, and receives an
independent review before merge.

## Task 1 — webhook delivery lifecycle matrix

Inspect the current webhook worker/service and tests. Add or repair the
smallest behavior needed for signed delivery, retry/backoff, terminal provider
failure, redirect/destination rebinding, disabled-target cancellation, and
idempotent test-event requests. Use local deterministic transports and real
PostgreSQL/Redis where the existing suite requires them; never contact an
external provider. Commit as `test(webhooks): close delivery lifecycle matrix`.

## Task 2 — rich-profile/accessibility gap

Audit the person record against the expanded profile requirements and identify
one concrete missing user-facing capability that can be completed safely in
this tranche (prefer contradiction/timeline/provenance or a governed optional
field). Implement it through generated GraphQL operations and authorized
services, add focused component/browser coverage, and preserve redaction and
purpose checks. Commit as `feat(profile): close governed profile acceptance gap`.

## Task 3 — remaining retryable mutation gap

Audit the remaining retryable mutation families and choose one bounded domain
not already covered by the durable principal-bound HMAC ledger (prefer a
job/settings or person mutation). Add exact opaque response references,
changed-material conflicts, expiry takeover, workspace/principal fencing,
redacted audit deduplication, and optional unkeyed compatibility. Add the
real-PostgreSQL matrix and include it in `test:db`. Commit as
`feat(idempotency): close remaining mutation gap`.

## Final verification

After review and cherry-pick, run formatting, lint, typecheck, generated checks,
unit tests, the complete database gate, build, and the relevant browser/Compose
checks. Update TODO.md and docs/REQUIREMENTS.md with exact commit, CI, and
deployment evidence. Keep hosted/provider rows incomplete until attended runs
actually execute with approved credentials.
