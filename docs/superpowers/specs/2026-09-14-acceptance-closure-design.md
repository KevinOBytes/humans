# Acceptance closure tranche — design

## Objective

Advance the consent-governed Humans MVP toward the remaining production
acceptance requirements without weakening workspace isolation, provenance,
privacy, audit, or human-review boundaries.

## In scope

1. Close the local webhook delivery lifecycle matrix: signed payloads,
   retry/backoff and terminal failure, redirect/destination rebinding, disabled
   targets, idempotent test-event requests, and redacted audit outcomes.
2. Close a concrete remaining rich-profile/accessibility gap in the person
   record, preserving generated GraphQL access and server authorization rather
   than introducing browser-side repositories.
3. Close a concrete remaining retryable-mutation gap in the job/settings or
   person domain using the existing principal-bound HMAC response-reference
   ledger, with real PostgreSQL coverage and legacy compatibility.

External provider calls and hosted credentials remain explicit operator gates;
synthetic adapters do not count as provider evidence. No threat scores,
autonomous adverse decisions, unconsented collection, or raw secret logging are
permitted.

## Acceptance

Each task must have a focused failing test, smallest passing implementation,
Node 24 quality checks, and an independent review before cherry-pick. TODO.md
and docs/REQUIREMENTS.md must be updated together only with evidence-backed
claims.
