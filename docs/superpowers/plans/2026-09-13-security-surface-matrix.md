# Extraction security boundary

## Scope and authority

This bounded tranche advances HUM-NFR-004 and HUM-NFR-007 after inspecting
settings, imports, files, cases, evidence, and graph GraphQL boundaries. It
does not close whole-product security acceptance or claim hosted/provider proof.

## Global Constraints

- Domain services must enforce permissions independently of GraphQL resolvers.
- Preserve workspace/resource visibility, consent, audit, and rate-limit checks.
- Stored diagnostic JSON must not expose arbitrary provider or private content.
- Keep successful extraction output available to authorized readers.
- Use Node.js 24, pnpm 11.11.0, focused failing tests, and full local gates before commit.

## Task 1: Close the extraction read and diagnostic boundaries

1. Prove `extraction.list` denies missing `file:read` before database access,
   for both user and API-key actors even when they retain `file:update`.
2. Add the missing service-level permission guard without changing the existing
   workspace and resource-visibility SQL. Require read permission before
   request/retry GraphQL mutations enqueue work whose response reads the run.
3. Prove the real GraphQL `ExtractionRun.errorSummary` field projects only a
   stable allowlisted worker failure code, preserving null and normalizing
   malformed or unknown values. Drop every additional JSON field.
4. Extend the existing live files/imports test rather than duplicating its
   cross-workspace lifecycle: seed a secret-bearing persisted diagnostic and
   verify authorized output is safe, authorized extracted data still works,
   and foreign reads retain their neutral denial and private response policy.
5. Update REQUIREMENTS and TODO with scoped evidence and remaining gaps.
6. Run focused/unit tests, format, lint, typecheck, schema/codegen checks, build,
   and the focused live PostgreSQL test. Commit for independent parent review.
