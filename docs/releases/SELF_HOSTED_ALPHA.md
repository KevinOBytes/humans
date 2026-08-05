# Self-hosted alpha and MVP release-candidate boundary

Humans is usable today as a self-hosted research alpha and is an MVP release
candidate. An operator can configure the required secrets, start the Docker
dependencies and application, bootstrap the first administrator through the
isolated one-shot service, sign in, create or select a workspace, and complete
a representative research loop.

This is **not** a completed MVP and is not a production-readiness claim. Full
MVP completion still requires every requirement in `docs/REQUIREMENTS.md` to be
complete, including the current release evidence required by `HUM-NFR-018` and
the Vercel deployment contract in `HUM-FR-035`. `TODO.md` remains the exact
requirement-linked MVP closure and production-hardening backlog.

## Current usable capability boundary

The self-hosted alpha includes:

- session authentication, optional TOTP, an explicit administrator bootstrap,
  workspace creation/selection, workspace isolation, member administration,
  invitations, and provisioned API keys within their documented limitations;
  focused live-PostgreSQL generated-GraphQL coverage verifies invitation resend
  creates a distinct replacement delivery intent and authorized cancellation/removal
  removes safe directory projections without cross-workspace mutation;
- the canonical GraphQL Yoga endpoint and generated browser operations;
- a role-aware research dashboard with recent visible people and imports,
  graph and principal-owned AI analysis history, exact authorized graph counts,
  safe workspace defaults, and administrator activity;
- person creation and overview correction, structured and unstructured facts,
  evidence/provenance, notes, tags, contacts, places, addresses, temporal
  relationships, and private file lifecycle controls;
- bounded CSV and JSON import preparation and execution with row diagnostics;
- authorized PostgreSQL search, saved searches, graph views, immutable
  snapshots, Degree/PageRank/Louvain analysis, and safe JSON/CSV exports;
- durable PostgreSQL jobs, a continuous worker, Redis leases, redacted audit and
  idempotency foundations; and
- a cited AI analyst when a reachable OpenAI-compatible or Ollama provider is
  explicitly configured. The ordinary base Compose stack does not start
  Ollama, and AI is unavailable until the operator supplies a provider or uses
  the opt-in Ollama overlay.

The local dependency topology includes PostgreSQL, authenticated Redis, private
MinIO storage and bucket initialization. The application and worker use the
same server-side provider interfaces intended for Neon, Upstash Redis,
Cloudflare R2, and other S3-compatible services.

## Work still required for MVP closure and production readiness

The following evidence or capability remains open:

- a verified Vercel deployment at the intended public hostname and parity
  evidence using Neon, Upstash Redis, R2/S3, Resend, and an external AI
  provider, including an attended one-shot administrator-bootstrap and recovery
  record that excludes bootstrap secrets (local PostgreSQL coverage alone does
  not establish this hosted evidence);
- external Resend delivery and recipient acceptance, external object-storage
  acceptance, external OpenAI-compatible provider smoke, and optional Ollama
  model smoke;
- mutable retention/access/AI policy administration, grants, legal holds,
  consent and deletion workflows, and provider administration;
- live webhook destination, destination-rebinding, retry progression,
  upgrade-migration, and external provider-failure acceptance beyond the
  generated-GraphQL/PostgreSQL lifecycle and signed-delivery evidence;
- extraction-run execution beyond the current schema foundation;
- remaining identity reconciliation/merge, exhaustive person-presentation,
  invitation-race, API-key activation, and whole-product error/failure matrices;
- the exhaustive tenant-bypass, security, accessibility, responsive/RTL/zoom,
  browser, recovery, upgrade, and dependency-provider acceptance matrices; and
- continuous proof of the documented latency, concurrency, graph frame-rate,
  Web Vitals, and bundle budgets.

Each item retains the status and MVP traceability assigned by
`docs/REQUIREMENTS.md` and `TODO.md`. This alpha boundary does not reclassify
any design-included work as post-MVP.

No statement in this document is evidence of a live hosted deployment,
third-party provider acceptance, full MVP completion, or production readiness.

## Operator path

For an attended self-hosted first run, populate an ignored `.env` from
`.env.example`, replace every placeholder, configure HTTPS for non-loopback
hosts, and run:

```bash
pnpm compose:first-run
```

The command validates Compose, starts the application and worker with required
dependencies, and invokes only the isolated administrator-bootstrap service.
It prints the sign-in URL and reports that AI is unavailable in the base stack.
See `docs/operations/docker.md` for the full deployment, backup, recovery,
upgrade, and optional Ollama procedures.

The operator must supply valid, independent application secrets and a working
Resend API key/sender for email-dependent registration, verification, recovery,
and invitations. AI additionally requires an explicitly configured and
reachable provider. Ordinary Compose without an external provider or the
opt-in Ollama overlay has no AI service; a rendered analyst page is not evidence
that analysis can run.

## Release-candidate verification contract

A commit presented as this self-hosted alpha or MVP release candidate must pass
the repository's generated drift, type, unit, database and production-build
gates:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm db:check
pnpm db:drift:check
pnpm auth:schema:check
pnpm codegen:check
pnpm build
```

The Docker configuration must also render from a populated ignored `.env`:

```bash
docker compose config --quiet
```

GitHub Actions remains the release evidence for the PostgreSQL integration,
Compose lifecycle, dependency, secret, image and security jobs. A source-only
checkout or this document by itself is not proof that those jobs passed for a
particular release commit.

## Latest local runtime evidence

On 2026-08-04, the isolated `pnpm test:compose:lifecycle` run built the
production image and passed the health-gated PostgreSQL, authenticated Redis,
private MinIO, migration, application, and continuous-worker stack. The run
also exercised the GraphQL research and file-upload paths, PostgreSQL/object
storage/Redis restart recovery, SHA-256 backup restore, active-job shutdown
fencing, and diagnostic secret/private-data leakage checks. This is local
self-hosted evidence only; it does not close the hosted Vercel, external
provider, or remaining whole-product requirements.

## Current conventions-contract evidence

`tests/integration/conventions-contract.test.ts` is a bounded `HUM-NFR-003`
contract. It checks UUIDv7 generation and ordering, representative
workspace-leading composite references across people, facts, locations, files,
and relationships, and UTC actor/version/soft-delete schema metadata. When
`TEST_DATABASE_URL` is supplied, it resets the disposable PostgreSQL database
and additionally proves a cross-workspace relationship reference is rejected,
representative metadata columns are `timestamptz`, a stale person update returns
no row, and an archived file is hidden from current repository reads. It does
not establish conventions for every domain, GraphQL input enforcement,
append-only revisions, or deletion-policy completeness; `HUM-NFR-003` and its
TODO remain open.

## Current optional Ollama evidence

The optional Ollama profile was exercised against the production image on
2026-08-05 with:

```sh
OLLAMA_SMOKE=1 OLLAMA_MODEL=tinyllama:latest pnpm test:compose:ollama
```

The smoke pulled the configured model, waited for the Ollama health gate,
executed an OpenAI-compatible chat request through the application, and
reported `Ollama smoke passed for model tinyllama:latest`. The default Compose
stack remains Ollama-free and does not require a model download.

## Current worker and lease evidence

On 2026-08-05, the production-image Compose smoke exercised both unauthorized
and authorized GET requests to `/api/jobs/run` after the application and
continuous worker became healthy. The authorized route returned a bounded job
summary, while the worker process-tree and health checks verified the Docker
runtime entrypoint. The real Redis lease acceptance then passed with:

```sh
RUN_REDIS_LEASE_SMOKE=true REDIS_TEST_URL=redis://127.0.0.1:6381 \
  pnpm vitest run tests/integration/redis-leases-real.test.ts
```

All 7 tests passed, including concurrent single-owner acquisition for both the
local and Upstash-shaped adapters. The previously recorded full lifecycle pass
also covers PostgreSQL/Redis restart recovery and active-claim SIGTERM fencing;
these checks are the current cross-mode evidence for the shared bounded and
continuous executor.

## Current extraction evidence

The PostgreSQL integration job now starts a disposable MinIO service and passes
its endpoint and credentials only to the database-test process. The extraction
worker acceptance uses the real S3-compatible object-store adapter for JSON
reads, malformed JSON, and an object larger than the bounded 8 MiB extraction
budget; the same suite keeps cancellation and retry assertions on the
transactional service lifecycle. A typed `ObjectReadLimitError` prevents a
provider stream-limit exception from being recorded as an opaque internal
failure.

## Current provider-adapter architecture evidence

On 2026-08-05, `pnpm test:unit` included the deterministic
`tests/unit/provider-adapter-contract.test.ts` suite. It scans production
sources to keep concrete Redis and S3 SDK imports at the declared adapter entry
points, prohibits AI SDK imports because the AI adapter uses raw HTTP, and
verifies local/Upstash Redis and MinIO/R2/generic-S3 configuration selection.
This is a source-level architecture contract; it does not claim hosted-provider
runtime acceptance.

## Current reconciliation collision evidence

On 2026-08-05, the live PostgreSQL reconciliation transaction acceptance
verified that a cross-workspace actor cannot merge foreign people; a colliding
tag remains linked to the fenced loser, while a loser-only tag and external
record move to the winner. A current-version unmerge restored the loser’s
active state, both tag and external-record ownership, and the identity
candidate’s prior review state. This is a bounded service-level acceptance and
does not close the remaining identity, conflict, or browser matrices for
`HUM-FR-010`.

## Current saved-query and graph-view evidence

On 2026-08-05, the live PostgreSQL generated-GraphQL lifecycle acceptance
passed for saved queries and graph views. It verifies owner updates,
workspace-shared visibility, non-owner mutation denial, stale optimistic-version
conflicts, archive exclusion from current reads and saved-query runs, and
cross-workspace non-disclosure for both resource types. This closes
`HUM-FR-020`; it does not replace the remaining whole-product release gates.

## Current webhook lifecycle evidence

On 2026-08-05, the live PostgreSQL generated-GraphQL acceptance passed webhook
create, secret rotation, test-event enqueue, and disable. Its deterministic
outbound edge verifies the delivered body’s timestamped HMAC against the
rotated secret, records a redacted HTTP 503 retry state, and verifies that a
replayed completed delivery makes no second outbound call. It does not claim a
live destination, DNS-rebinding defense, retry progression, upgrade migration,
or external provider-failure matrix; `HUM-FR-024` remains incomplete.
