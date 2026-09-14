# Humans governance and profile closeout plan

> For agentic workers: use `superpowers:subagent-driven-development` and
> complete each task in an isolated worktree. Do not weaken consent,
> provenance, authorization, redaction, or audit boundaries.

## Goal

Advance the original Humans objective by closing three concrete gaps that still
prevent an honest production-complete claim: retention actions beyond the
soft-delete review queue, protected identifier evidence citations, and any
missing rich-profile/temporal-graph contract surface.

## Global constraints

- Preserve workspace and case scoping, least privilege, lawful-purpose and
  consent checks, legal holds, audit attribution, and optimistic versions.
- No autonomous adverse decisions, threat scores, covert collection, or
  real-person surveillance data.
- Use Node 24 and pnpm 11.11.0. Use TDD and generated GraphQL operations.
- Never print or commit secrets, populated environment files, uploads, dumps,
  logs, or provider responses.
- Update `TODO.md` and `docs/REQUIREMENTS.md` only with evidence from tests or
  runtime checks.

## Task 1: governed retention action execution

Audit the retention policy, privacy-request, and deletion-worker paths. Add a
durable, legal-hold-fenced review/approval workflow for `hard_delete` and
`anonymize` actions for resources that can safely support them, or explicitly
reject unsupported resource kinds before mutation. The executor must never
delete evidence/provenance needed to explain the action, must preserve an
immutable redacted audit record, and must propagate file/search/AI cleanup
through the existing processor boundary. Cover concurrency, stale policy,
legal holds, workspace/principal fencing, idempotent replay, and failure
recovery with focused PostgreSQL tests and GraphQL/service tests.

## Task 2: protected identifier citation evidence

Extend evidence assertions so protected identifiers can be cited without
creating plaintext shadow copies. Use the existing sealed-envelope/data-key
primitives for encrypted quote and locator material, keep GraphQL redaction and
field-level authorization intact, and preserve version binding and reclassify
guards. Public citations must remain compatible. Add a migration, generated
operations if needed, focused unit/integration tests proving encryption at
rest, authorized decryption, unauthorized omission, no audit leakage, and
cross-workspace rejection.

## Task 3: rich profile and temporal graph contract audit

Compare the user requirements against the current schema, generated GraphQL,
service authorization, and profile/graph UI. Implement the smallest concrete
missing operation or field set for aliases, pronouns, biography, employment,
education, contacts, dated addresses, languages, organizations, identifiers,
notes, custom fields, temporal directed relationships, provenance, and the
documented-versus-analyst-hypothesis distinction. Add focused failing tests,
GraphQL authorization coverage, and an accessible browser/component assertion.
If a requirement is already implemented, strengthen its evidence instead of
duplicating the feature and record the exact proof in the requirement ledger.

## Final verification

Run formatting, lint, typecheck, generated checks, Drizzle checks, focused
PostgreSQL/integration tests, unit tests, browser acceptance, Compose, build,
and security gates. Review every task diff, merge only reviewed commits to
`main`, push, and record exact CI/deployment evidence. Hosted credentials and
external provider runs remain explicit operator gates until actually run.
