# Assignment queue browser acceptance

## Context

The protected case workspace now has a reviewed generated-GraphQL assignment
queue panel. The remaining bounded browser evidence should exercise the panel
through the existing authenticated Chromium fixture without granting queue rows
any additional case-resource access.

## Global constraints

- Use the existing browser fixture and generated GraphQL boundary.
- Keep all setup and assertions workspace/case scoped and fictional.
- Do not weaken authorization, redaction, optimistic versioning, or
  idempotency requirements.
- Preserve the explicit distinction between local/CI browser evidence and
  hosted authenticated/provider acceptance.

## Task

Add a focused authenticated Chromium journey for the case assignment queue that
selects a seeded case, verifies bounded list/filter rendering, creates an
assignment, assigns a valid case member, transitions it with a required reason,
escalates it, and verifies the resulting state through authorized generated
GraphQL/database assertions. Include a viewer or foreign-case denial assertion
where the existing fixture supports it. Add responsive/keyboard assertions for
the queue controls and keep all test data fictional and disposable. Update
`docs/REQUIREMENTS.md` and `TODO.md` with measured CI evidence without marking
the whole FR-038/NFR-009 rows complete.

## Verification

Run the focused browser test, then formatting, lint, typecheck, generated drift,
the relevant unit suite, and production build. Report skipped hosted/provider
evidence explicitly.
