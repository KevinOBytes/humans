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
- the canonical GraphQL Yoga endpoint and generated browser operations;
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
  provider;
- external Resend delivery and recipient acceptance, external object-storage
  acceptance, external OpenAI-compatible provider smoke, and optional Ollama
  model smoke;
- mutable retention/access/AI policy administration, grants, legal holds,
  consent and deletion workflows, and provider administration;
- webhook lifecycle, signing, delivery retries, and operator controls;
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
