# Humans next production-gap tranches

## Goal

Move the remaining requirement matrix toward full production completion without
claiming hosted or provider behavior that has not been verified.

## Global constraints

- Preserve workspace authorization, consent/purpose checks, redaction, audit,
  and generated GraphQL boundaries.
- Use TDD and add focused evidence; do not weaken existing tests.
- Never persist recoverable API-key plaintext or commit secrets/private data.
- Update `docs/REQUIREMENTS.md` and `TODO.md` together, retaining bounded
  evidence language when whole-product acceptance remains open.

## Tasks

## Task 1 — API-key lifecycle

Audit create/rotate retry behavior and implement a
   secure idempotent response design for one-time credentials, if a safe design
   can be proven without storing recoverable secrets. Add tests and docs.
## Task 2 — Person profile completeness

Audit the current rich profile/schema against
   the requested names, aliases, pronouns, biography, employment, education,
   contacts, addresses/effective dates, languages, organizations, public
   identifiers, notes, and custom fields. Implement one bounded missing profile
   surface through generated GraphQL with authorization and tests.
## Task 3 — Governance and retention

Audit deletion, legal-hold, consent, retention, and
   subject-access behavior; add the highest-value missing local test or safe
   implementation tranche without asserting external erasure.
## Task 4 — Performance and release evidence

Audit the existing representative graph and
   route-budget harness against `HUM-NFR-020`; add deterministic missing
   measurements or tests only where they are reproducible locally.

## Review

Each task requires an implementer report and focused review. A final whole-branch
review must verify no broad requirement was falsely marked complete.
