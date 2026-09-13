# Relationship evidence discoverability

## Goal

Make already-authorized relationship evidence visible in the person profile
and generated GraphQL relationship reads. This is a bounded provenance slice
for HUM-FR-028/HUM-FR-012 and does not close the whole profile or provenance
matrix.

## Constraints

- Reuse the existing workspace-scoped evidence loader/service and permission
  checks; do not query repositories from browser components.
- Preserve neutral disclosure for inaccessible relationships/evidence, source
  sensitivity redaction, case and consent coverage, and audit behavior.
- Keep pagination bounded and use generated GraphQL operations in the UI.
- Do not turn an evidence link into an assertion or change review state.
- Use TDD, Node 24, pnpm 11.11.0, and update TODO/REQUIREMENTS only with
  bounded evidence. Do not claim hosted/provider completion.

## Task 1

Add a nullable paginated `Relationship.evidence` connection exposing the
existing relationship-evidence rows and safe evidence/source projections,
authorized through the existing relationship and evidence loaders. Extend the
person relationship operation and profile relationship cards to show a compact
source title/citation/locator and review state, with an explicit empty state.
Add focused GraphQL/service/UI tests for authorized evidence, inaccessible
evidence, pagination, and source sensitivity redaction. Run formatting, lint,
typecheck, codegen drift, unit tests, and production build before commit.

## Acceptance boundary

This proves relationship evidence is discoverable where the relationship is
already visible. It does not add citation workflows for names/events/
identifiers/addresses or close whole-product accessibility/provider evidence.
