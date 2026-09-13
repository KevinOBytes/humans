# Temporal fact authoring

## Goal

Expose the temporal and confidence metadata already supported by the fact
service in the profile's fact-creation form. This is a bounded rich-profile
slice for HUM-FR-012/HUM-FR-013/HUM-FR-028 and does not grant review approval.

## Constraints

- Preserve sparse typed-value validation, contradiction coexistence,
  workspace/person authorization, consent/purpose checks, audit, optimistic
  versions, and generated GraphQL boundaries.
- Ordinary users may create asserted/disputed/disproven/unknown claims but may
  not self-assign approved review state.
- Invalid temporal ranges must fail before mutation and preserve the draft;
  timestamps must use the existing UTC-safe DateTime contract.
- Do not expose protected values or allow direct browser database access.
- Use TDD, Node 24, pnpm 11.11.0, and update TODO/REQUIREMENTS only with
  bounded evidence. Do not claim hosted/provider completion.

## Task 1

Extend `FactForm` to author temporal semantics and precision, optional earliest
and latest validity timestamps, observed-at timestamp, confidence method and
explanation, optional superseded-fact selection from the same person, and
language. Wire these fields through the existing generated `CreateFact`
operation and preserve existing value-type editors and sensitivity defaults.
Add focused component tests for draft preservation, valid metadata, invalid
ranges, review-state restrictions, and workspace-scoped superseded-fact
options. Run formatting, lint, typecheck, codegen drift, unit tests, and
production build.

## Acceptance boundary

This improves authoring of existing fact schema fields without changing
review/approval semantics. It does not add source citations to names/events/
identifiers/addresses or close the whole-product browser/accessibility matrix.
