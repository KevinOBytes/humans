# Humans Full MVP Closeout Design

## Status

Approved continuation of the Humans objective. This design extends the
existing modular-monolith architecture and current requirements matrix; it
does not redefine the product as an intelligence, threat-scoring, covert
collection, or autonomous-adverse-decision system.

## Goal

Close the remaining implementable production gaps while keeping hosted
credentials and external-provider acceptance explicit operator gates. The
result must provide a usable consent-governed research workspace with rich
person profiles, temporal social graphs, provenance-preserving AI assistance,
privacy controls, and safe data lifecycle operations.

## Boundaries

The application remains a Next.js App Router modular monolith. Browser code
uses generated GraphQL operations only; domain services own authorization,
workspace/case scoping, lawful-purpose and consent checks, redaction, audit,
optimistic versions, and idempotency. PostgreSQL is authoritative, Redis is
coordination/rate-limit state, and S3-compatible storage is accessed through
the existing storage contract. OpenAI, Ollama, Resend, R2, generic S3, and
Upstash remain provider adapters, never direct browser dependencies.

Irreversible privacy operations are not ordinary CRUD. They require an
approved, independently reviewed privacy request, a current retention/purpose
snapshot, no applicable legal hold, a workspace lock, a durable redacted
audit record, and explicit processor outcomes. If any resource or processor
cannot be safely handled, the request remains durably rejected or pending;
there is no silent downgrade to soft delete and no partial destructive commit.
Provenance needed to explain the decision is retained or cryptographically
redacted according to the retention policy.

Profile enrichment uses the existing catalog-backed fact model. The default
catalog is explicit and versioned, existing workspaces receive only missing
definitions through an idempotent backfill, and AI/web suggestions remain
pending until a human accepts individual fields. Relationship evidence and
source citations remain separately governed and version-bound.

Operational acceptance is strengthened with deterministic local fixtures,
provider contract tests that never use production secrets by accident,
route/error/redaction coverage, and documented hosted checks. Tests prove
behavior; documentation never upgrades an incomplete requirement without
matching runtime evidence.

## Workstreams

1. Governed privacy execution: implement the safe executor and lifecycle
   contracts for supported irreversible actions, preserving legal holds,
   provenance, processor state, audit, and replay safety.
2. Profile/catalog completeness: audit and fill the rich profile definitions,
   idempotent workspace backfill, default form values, and source-to-field
   authoring gaps without duplicating existing behavior.
3. Acceptance hardening: close the remaining implementable whole-product
   failure/security/accessibility contracts and make provider/hosted acceptance
   reproducible without exposing secrets.

## Non-goals

- No real-person surveillance dataset or autonomous collection.
- No threat score, adverse decision, biometric matching, or covert access.
- No deletion of legal-hold data or audit/provenance required for accountability.
- No retrieval, printing, or committing of Vercel/provider secrets.

## Verification

Each workstream requires focused failing tests first, implementation, focused
PostgreSQL/GraphQL tests, review, and documentation updates. The final gate is
the existing Node 24/pnpm 11.11.0 CI matrix, including generated drift,
Compose PostgreSQL/Redis/MinIO lifecycle, browser acceptance, security and
secret scanning, and a production build. Hosted administrator/provider checks
remain marked incomplete until actually attended with configured credentials.
