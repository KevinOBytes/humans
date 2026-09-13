# Humans web-source evidence linkage tranche

## Goal

Promote accepted, consented web-research citations into ordinary workspace-
scoped source/evidence/excerpt/assertion records while preserving human review,
purpose, sensitivity, audit, idempotency, and redaction boundaries.

## Global constraints

- Web research remains consent-gated and suggestions remain human accept/reject.
- Never write a profile field or fact autonomously.
- Never trust provider text or a client-supplied URL; only persisted run/source
  snapshots may be promoted.
- Do not expose private provider credentials, raw upstream payloads, or hidden
  storage coordinates.
- Preserve workspace and case boundaries, field-level citations, optimistic
  versions, and append-only audit behavior.
- Use TDD; generated GraphQL artifacts must be regenerated, never hand-edited.
- Update `TODO.md` and `docs/REQUIREMENTS.md` together, and keep whole-product
  provider/hosted acceptance explicitly incomplete.

## Task 1 — Promote accepted web citations

Audit the existing AI review acceptance path and implement a bounded service-
level promotion of each accepted web evidence reference into a normal source,
evidence item, excerpt, and field-level evidence assertion. Use the persisted
`person_web_research_sources` snapshot as the authority, make repeated review
replays converge without duplicate records, and retain the originating run ID,
provider/model, retrieval hash, collection timestamp, purpose, and reviewer in
metadata/custody records. Keep promotion in the same transaction as acceptance
where the transaction abstraction permits it; otherwise use a durable
principal-bound idempotency claim and prove recovery semantics. Add focused unit
and disposable-PostgreSQL coverage for successful acceptance, duplicate/replay,
tampered URL/snippet, foreign workspace, field-path, redaction, and rollback
behavior. Update both tracking documents with bounded evidence.

## Review

The implementer must write a report. A separate reviewer must assess spec
compliance and code quality. Run all relevant quality gates and a final diff
check before pushing.
