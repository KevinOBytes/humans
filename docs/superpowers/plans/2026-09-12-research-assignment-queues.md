# Research assignment queues

## Context

Humans already has workspace/case membership, consent-governed resources, an AI
review queue, privacy requests, and auditable mutations. The consent-governed
research design also requires a first-class assignment queue for review,
verification, consent follow-up, source reconciliation, and privacy requests.
This task adds the smallest durable queue boundary without weakening existing
resource authorization or inventing autonomous decisions.

## Global constraints

- Keep all rows workspace-scoped and use workspace-leading foreign keys for
  case and assignee references.
- Queue rows contain metadata and assignment state only; they never grant
  access to a person, fact, relationship, source, or privacy request.
- Reads require workspace visibility; case-linked rows additionally require
  case membership. Mutations require `workspace:update` or membership-aware
  reviewer permissions and must write redacted audit events.
- Use application UUIDv7 IDs, UTC timestamps, optimistic versions, bounded
  pagination, and generated GraphQL operations.
- Use tests first, preserve the modular-monolith boundaries, and leave
  external provider/runtime acceptance as an explicit TODO.

## Task 1: durable assignment queue

Add a Drizzle schema and migration for `research_assignment_items` and
append-only `research_assignment_events`. Queue items must include workspace,
optional case, queue kind (`review`, `verification`, `consent_follow_up`,
`source_reconciliation`, `privacy_request`), title, description, priority,
status (`open`, `in_progress`, `blocked`, `completed`, `cancelled`), optional
assignee principal, due date, escalation count, and normal attribution/version
columns. Events must record assignment/status/escalation changes, actor,
reason, and timestamp and must reject update/delete.

Implement repository/service/GraphQL query and mutations for bounded list,
create, assign, transition, and escalate. Enforce workspace/case visibility,
valid state transitions, optimistic expectedVersion, nonempty bounded reasons,
and audit events. Assigning a queue item must not imply access to linked case
resources. Require idempotency keys for retryable mutations using the existing
principal-bound response-reference transaction helper.

Add generated operations and focused unit/schema tests plus a gated real
PostgreSQL lifecycle test covering workspace/case isolation, state transitions,
optimistic conflicts, event immutability, idempotent replay, and audit output.
Update `docs/REQUIREMENTS.md` and `TODO.md` with bounded evidence; do not mark
the whole workspace/case requirement complete until browser/provider evidence
exists.

## Verification

Run the focused tests first, then formatting, lint, typecheck, Drizzle checks,
GraphQL codegen drift, full unit tests, and production build. Report the commit
and any skipped live evidence.
