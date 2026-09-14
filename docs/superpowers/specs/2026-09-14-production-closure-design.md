# Humans production-closure design

## Objective

Close the next code-and-evidence tranche for the Humans MVP while preserving
the existing consent, workspace isolation, provenance, audit, and human-review
boundaries. The product must remain a governed research application; it must
not introduce autonomous adverse decisions, threat scoring, or unreviewed
personal-data collection.

## Scope

This tranche covers three independent gaps that are implementable and testable
without retrieving hosted secrets:

1. Extend durable principal-bound GraphQL idempotency to the remaining person
   history mutations (names and events), with replay, expiry takeover,
   optimistic-version, workspace fencing, and redacted-audit evidence.
2. Finish the direct-route stable error/correlation contract for the remaining
   invitation, authentication, two-factor, job, health, and storage boundaries,
   including no-store policy and secret-free payload assertions.
3. Harden the hosted acceptance harness so an operator can run authenticated
   sign-in/bootstrap, workspace/person, AI-review, provider, and recovery checks
   from a 0600 local env file without printing or committing credentials.

The following remain explicit external gates rather than being faked locally:
real hosted credential acceptance, Resend delivery, OpenAI/Ollama/web-search
provider calls, external R2/S3/Upstash contracts, DNS/rebinding behavior, and
reference-device performance/Web Vitals.

## Architecture

The existing modular monolith remains unchanged. GraphQL mutations continue to
derive opaque principal-bound response references in the audit transaction
layer. Direct HTTP routes use the centralized error envelope and request-ID
helpers. The production smoke script remains a read-only-by-default CLI and
accepts secrets only through process environment or a caller-provided local
file; it never logs values.

## Acceptance criteria

- Name and event mutations are replay-safe and workspace/principal fenced.
- All covered direct routes return stable allowlisted `{code,message,requestId}`
  errors, `private, no-store`, and a valid `x-request-id` on failures.
- Hosted smoke has explicit opt-ins for authentication and provider calls,
  validates required variable presence without echoing values, and exits with
  actionable redacted failures.
- Focused tests fail before implementation and pass after it; generated
  GraphQL artifacts, Drizzle drift, unit/integration suites, browser acceptance,
  production build, and docs remain green.

