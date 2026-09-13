# Accepted AI enrichment history

## Goal

Make accepted AI-assisted profile enrichment auditable from the person profile
after it leaves the pending review queue. This is a bounded provenance slice
for HUM-FR-023/HUM-FR-028 and does not close hosted provider or full retention
acceptance.

## Constraints

- Reuse the existing workspace/person/purpose authorization and AI review
  service; never expose another workspace's suggestions or raw provider data.
- Preserve immutable run/provider/model/policy, confidence, uncertainty,
  reviewer, decision reason, accepted resource, and evidence references.
- Browser code must use generated GraphQL operations, with bounded pagination.
- Accepted history is read-only and separate from pending suggestions; it must
  not reopen or mutate a review decision.
- Use TDD, Node 24, pnpm 11.11.0, and update TODO/REQUIREMENTS only with
  bounded evidence. Do not claim hosted/provider completion.

## Task 1

Add a permission-gated, workspace/person/purpose-scoped generated GraphQL
connection for reviewed AI suggestions with a bounded page. Project only safe
review metadata and accepted evidence references, including provider/model,
run ID, reviewer, timestamps, decision reason, confidence, uncertainty, field,
and accepted resource. Render an “Accepted research history” section in the
person research panel with explicit empty and redacted states. Add focused
service/GraphQL/component tests for accepted versus pending rows,
cross-workspace denial, purpose filtering, and evidence redaction. Run
formatting, lint, typecheck, codegen drift, unit tests, and production build.

## Acceptance boundary

This makes accepted provenance discoverable at the profile without changing
the immutable review record. Names, events, identifiers, addresses, hosted
provider, and whole-product accessibility matrices remain separate work.
