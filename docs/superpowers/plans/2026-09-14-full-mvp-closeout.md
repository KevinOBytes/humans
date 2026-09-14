# Humans full-MVP closeout implementation plan

> **For agentic workers:** use `superpowers:subagent-driven-development` and
> work from the task brief supplied by the controller.

**Goal:** Advance the original Humans production objective by closing the
remaining person-reconciliation, provider-acceptance, and rich-profile gaps.

**Architecture:** Preserve the modular monolith, generated GraphQL boundary,
principal-bound audit/idempotency layer, and consent/provenance invariants.

**Spec:** `docs/superpowers/specs/2026-09-14-full-mvp-closeout-design.md`

## Global constraints

- Workspace scope, authorization, redaction, audit, consent, and provenance
  are mandatory; never weaken them to satisfy a test.
- Use Node 24 and pnpm 11.11.0 for verification.
- Use TDD and update `TODO.md` plus `docs/REQUIREMENTS.md` only with evidence.
- Never print or commit secrets, populated env files, uploads, dumps, or logs.

## Task 1: reconciliation mutation durability

Audit and implement principal-bound durable idempotency for `person.merge`,
`person.unmerge`, and `person.identity-candidate.generate` if any path remains
legacy/unkeyed. Cover concurrent convergence, changed material, malformed and
foreign-workspace opaque references, expiry takeover, optimistic conflicts,
principal/API-key/workspace fencing, and redacted single-effect audit output.

## Task 2: hosted/provider acceptance contract

Audit `scripts/production-readiness-smoke.mjs`, Vercel environment-name
handling, and provider contract configuration. Add only safe contract checks
that identify missing variable names and provider state, never values. Cover
OpenAI/Ollama, Resend, R2/S3, Upstash, authentication/recovery, and public
readiness while leaving real provider calls explicit opt-in.

## Task 3: rich profile and graph contract audit

Compare the requirements against schema, generated GraphQL operations, service
authorization, and profile/graph UI. Implement the smallest missing field or
operation set for aliases, pronouns, biography, employment, education,
contacts, dated addresses, languages, organizations, identifiers, notes,
custom fields, temporal relationships, provenance, and hypothesis/documented
state. Add focused tests and accessibility/browser evidence.

## Final verification

Run focused tests and then formatting, lint, typecheck, generated checks,
unit/integration/browser/build/Compose gates. Push only reviewed commits and
record exact CI/deployment evidence, leaving external gates open when not run.
