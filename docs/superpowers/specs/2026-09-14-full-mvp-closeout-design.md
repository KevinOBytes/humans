# Humans full-MVP closeout design

## Objective

Continue the original Humans objective toward a production-complete,
consent-governed research application. Close the highest-impact remaining
runtime gaps without weakening workspace isolation, provenance, human review,
redaction, audit, or lawful-purpose controls.

## Scope

1. Extend principal-bound durable idempotency to the remaining reversible
   person reconciliation mutations and identity-candidate generation.
2. Audit and harden the hosted/provider acceptance boundary so every external
   credential is opt-in, redacted, and reported by variable name rather than
   value; preserve the public smoke as the default.
3. Audit the rich person profile and graph contracts against the requirements,
   adding only fields and generated operations that are missing, with focused
   GraphQL, PostgreSQL, browser, and accessibility evidence.

## Non-goals

- No autonomous adverse decisions, threat scores, or unreviewed collection.
- No retrieval or printing of hosted secrets.
- No real-person surveillance dataset; synthetic fixtures remain mandatory.
- No claim of external-provider success without a live provider run.

## Acceptance criteria

- Reconciliation retries are exact, opaque, principal/workspace fenced, expiry
  takeover safe, optimistic-version aware, and audited once per mutation.
- Provider/auth acceptance tools fail closed when opt-in credentials are absent,
  never echo secret values or credential-bearing URLs, and retain public smoke
  behavior by default.
- Every rich-profile field and relationship property has an authorized
  generated GraphQL read/write path or is explicitly documented as incomplete.
- Focused tests fail before implementation, pass afterward, and the complete
  CI quality/database/browser/build/security gates remain green.
