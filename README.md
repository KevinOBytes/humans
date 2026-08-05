# Humans

Humans is an open-source, workspace-scoped research platform for building evidence-backed records about people and the relationships between them. The current self-hosted alpha combines structured facts, provenance, a social graph, GraphQL, file ingestion, and cited analysis through an OpenAI-compatible model.

> **Project status:** usable self-hosted alpha and MVP release candidate; neither the full MVP nor production readiness is complete. The current tree supports an authenticated, workspace-scoped research loop through generated GraphQL operations: people, facts, relationships, evidence, private files, CSV/JSON imports, search, graph exploration and deterministic analysis, plus a cited AI analyst when an operator configures a reachable provider. [The self-hosted alpha boundary](docs/releases/SELF_HOSTED_ALPHA.md) states what is proven and what is not. [TODO.md](TODO.md) remains the authoritative requirement-linked MVP closure and production-hardening backlog; Vercel deployment proof, external-provider acceptance, mutable policy administration, extraction runs, and the remaining exhaustive security, accessibility, performance, and recovery matrices are not finished.

## Quick start

Prerequisites:

- Node.js 24
- pnpm 11.11.0 (the version declared by `packageManager`)

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm db:migrate
pnpm admin:bootstrap
pnpm dev
```

Open <http://localhost:3000>. The example environment contains documentation-only placeholders; replace them before enabling services. Never commit a populated environment file.
The one-shot `db:migrate` and `admin:bootstrap` scripts load the ignored
`.env.local` directly through Node's environment-file support; secret values
are not placed in command arguments. Next.js loads the same file for `dev`.

The analyst also needs the durable worker. Run `pnpm worker` in a second
terminal, sign in with `analysis:read`, `analysis:create`, and `analysis:run`,
then open `/analyst`. Cancellation is shown only with `analysis:cancel`.

Administrator provisioning is an explicit one-shot operation. For Compose,
start or migrate the backing services and run:

```bash
docker compose --profile bootstrap run --rm bootstrap-admin
```

Only that disposable container receives `ADMIN_*`; the application, worker,
migration, and seed roles do not. Re-running it reconciles administrator
identity and role but deliberately does not replace an existing credential.
See the [Docker operations runbook](docs/operations/docker.md) for recovery,
rotation, and hosted deployment guidance.

For a new Compose installation, populate the ignored `.env` and run the
attended first-run command:

```bash
cp .env.example .env
# Replace every placeholder and choose the public application URL.
pnpm compose:first-run
```

The command validates the Compose configuration, starts the application and
worker with their required PostgreSQL, Redis, and MinIO services, then runs the
isolated administrator bootstrap. It does not pass `ADMIN_*` values on the
command line or expose them to the long-running application roles. The base
stack does not start Ollama; configure an external AI provider or explicitly
start the Ollama overlay before treating AI as available.

Keep `AUTH_SECURE_COOKIES=true`. Secure cookies are supported by browsers on
the `http://localhost` loopback exception used by the default Compose binding;
non-loopback self-hosts must serve `NEXT_PUBLIC_APP_URL` over HTTPS through a
trusted edge. Production validation rejects `AUTH_SECURE_COOKIES=false` in
every deployment mode.

Registration defaults to invitation-only. Set `AUTH_REGISTRATION_MODE` to
`disabled`, `invite_only`, or `public` for the intended deployment and review
the [authentication operations runbook](docs/operations/authentication.md)
before exposing the application.
Invite-only signup holds a PostgreSQL invitation/workspace lock through the
Better Auth user and credential transaction, so cancellation and expiry cannot
slip between policy approval and insertion. Interactive auth routes reject API
key headers even when a session cookie is present.

Workspace owners and admins manage invitations and members from
`/settings/members` through generated GraphQL operations. Owners can invite or
assign non-owner roles; admins can manage analyst, contributor, and viewer
roles. Every write rechecks current authority and owner invariants in the same
transaction as principal-bound idempotency and a redacted audit event.
Invitation messages use the encrypted authentication outbox and Resend worker.
Invitation identifiers are scrubbed from the browser URL before rendering and
carried across authentication only in a short-lived encrypted HTTP-only cookie.

For an explicit, idempotent local Docker seed after migrations, run:

```bash
docker compose --profile seed run --rm seed
```

The seed command refuses non-test databases unless that operation explicitly
sets `ALLOW_DATABASE_SEED=true`; the Compose seed service scopes that override
to the one-off seed container.

Run the current quality gates with:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The repository also provides fail-closed dependency-license review, a
high/critical production audit, local Gitleaks/Syft/Trivy wrappers, and an
eight-job GitHub Actions workflow covering quality, generated drift, PostgreSQL,
production build, Compose lifecycle, dependencies, secrets, and exact-image
SBOM/vulnerability scanning. As verified on 2026-08-04, all eight checks pass on
the public repository and are required on `main` by the active repository
ruleset. Merges are squash-only, resolved conversations are required, force
pushes and deletion are blocked, and merged branches are deleted automatically.
See [Repository governance](docs/REPOSITORY_GOVERNANCE.md) and
[Dependency policy](docs/DEPENDENCY_POLICY.md).

## Private file lifecycle

The evidence workspace creates checksum-bound private upload sessions for
session users, verifies the stored bytes before a file becomes available, and
shows only the current user's pending uploads. A user can resume a pending
upload only by reselecting a local file with the same name, byte length, and
SHA-256 digest, or cancel it into immediate durable cleanup. Available files
can be downloaded, and authorized users or API keys with `file:delete` can
archive a visible file with optimistic version confirmation.

GraphQL exposes file and variant metadata but never provider, bucket, endpoint,
or object-key coordinates. Upload and download grants for MinIO, R2, and generic
S3 use the same opaque application storage route; only the application decrypts
the short-lived grant and reaches the configured provider. Each upload grant is
bound to its pending database session, and the proxy holds that session lock
only while it claims or reconciles a durable attempt; no database connection is
held while the provider PUT streams. The PUT is bounded to 60 seconds, and each
claim reserves a further 60-second quiescence window before cleanup or a
replacement claim may proceed. A provider commit followed by a timeout/error
advances the durable mutation generation and restarts that window, so cleanup
cannot certify a delete made before an ambiguous publication. Archive cleanup
reads storage coordinates only inside the worker,
requires exclusive coordinate ownership, deletes the exact primary and variant
objects, and records completion once. `pnpm test:db` includes the
real-context file API and durable cleanup suites. The required Compose lifecycle
also signs in through the built application, creates/completes/archives through
its `/api/graphql` endpoint, uploads through the returned opaque grant, and
waits for the running worker to delete the primary and seeded variant while
retaining a sibling sentinel.

Because private bytes pass through that application route, Vercel deployments
accept uploads up to 4 MiB for evidence, CSV, and JSON. The limit is enforced
when an upload session is created and is shown beside the file picker. Docker
deployments retain the purpose-specific limits: 50 MiB for evidence, 25 MiB for
CSV imports, and 10 MiB for JSON imports.

## Search and reproducible graph analysis

The current deterministic research slice is exposed entirely through generated GraphQL operations:

- `/search` supports bounded PostgreSQL full-text search, structured filters, exact protected PHONE or PERSON_IDENTIFIER lookup, opaque keyset pagination, and plain-text matched snippets.
- Session users can create PRIVATE or WORKSPACE saved searches, update or archive only searches they own, and rerun them under their current permissions. Protected exact values cannot be saved.
- The graph explorer can create immutable current-data snapshot manifests, check whether a snapshot remains reproducible, run versioned Degree, PageRank, or Louvain community analysis, page stored results, and export authorized results as JSON or spreadsheet-safe CSV.

Search result pages are not cached. Search text and protected values are kept out of URLs, browser storage, Redis keys, audits, and metric labels. Every expensive search, saved-query run, snapshot, replay, analysis, and analysis-export path uses bounded Redis operation budgets before database or graph work.

Research writes maintain redacted, version-aware search documents in the same PostgreSQL transaction as the authoritative mutation and audit event. The application and worker use the concrete transactional maintainer. To inspect or rebuild one workspace in bounded batches after migration, run:

```bash
pnpm search:reindex -- --workspace <workspace-uuid> --dry-run
pnpm search:reindex -- --workspace <workspace-uuid> --batch-size 100
```

The command accepts only one workspace UUID, an optional batch size from 1 to 500, and an optional dry run. Its output contains identifiers and counts, never indexed text. Migration `0009_task12_search_analysis` intentionally refuses to transform non-empty provisional search or analysis tables: operators must review and explicitly clear or export that provisional data, apply the migration, then reindex search documents and recreate deterministic snapshots.

Task 12 production metrics are emitted as structured `humans.task12.metric.v1` events with fixed names and low-cardinality labels. They exclude workspace, actor, request, query, protected value, resource, cursor, and Redis-key material; metrics writer failures never alter product authorization or availability.

## Cited AI analyst

`/analyst` uses generated GraphQL operations to start, read, and cancel one
workspace- and principal-scoped run. The client creates a fresh random
idempotency key for each deliberate valid submission, polls with bounded
exponential delay, and renders only the public run projection: state,
provider/model, validated citations, and approved tool names with count-only
summaries. Questions, provider credentials and endpoints, raw tool material,
and upstream errors are not placed in URLs, browser storage, initial HTML,
logs, or public error messages.

Configure exactly one server-side provider in `.env.local`:

- OpenAI: `AI_PROVIDER=openai`, the canonical
  `AI_BASE_URL=https://api.openai.com/v1`, a private `AI_API_KEY`, and an
  enabled `AI_MODEL`.
- Another OpenAI-compatible service: `AI_PROVIDER=compatible`, an HTTPS
  `AI_BASE_URL` without user information, query, or fragment, a private
  `AI_API_KEY`, and `AI_MODEL`. The runtime revalidates public DNS and rejects
  redirects and non-public destinations.
- Ollama: `AI_PROVIDER=ollama`, `AI_BASE_URL=http://ollama:11434/v1`, and
  `AI_MODEL`; no API key is required. The ordinary Compose stack does not start
  or download Ollama. Use only the separate opt-in Ollama profile described in
  the Docker operations runbook.

Prompts and answers are sealed with `DATA_ENCRYPTION_KEY`; searchable request
identity uses domain-separated HMAC material. New private AI threads inherit the
workspace retention window, and the worker purges completed expired threads
unless an active legal hold applies. Every tool call and final write rechecks
current workspace authority. Local focused evidence on 2026-08-04 is
8 passing component tests and 2 passing Chromium tests (including axe,
reduced-motion, mobile/reflow, cancellation, and leakage checks). This is not
external-provider smoke, deployment proof, or production-readiness evidence.

## Deployment direction

The application is designed for one contract in two modes, but only the local
dependency topology and self-hosted application path are part of the current
usable alpha boundary. The hosted Vercel path still requires deployment
evidence before full MVP completion:

When a hosted deployment URL is available, you can run:

```sh
VERCEL_SMOKE_URL=https://humans.kevinbytes.com \
VERCEL_SMOKE_CRON_SECRET=<cron-secret> \
pnpm vercel:smoke
```

The command validates:

- `/api/health/live` and `/api/health/ready` reachability
- unauthenticated GraphQL boundary response shape
- `/api/jobs/run` auth enforcement with an invalid secret and optional secret probe

- **Vercel:** Neon PostgreSQL, Upstash Redis, S3-compatible storage such as Cloudflare R2, Resend, and an OpenAI-compatible model endpoint.
- **Docker Compose:** the application and worker with PostgreSQL, Redis, MinIO, bucket initialization, and optional Ollama.

The committed Vercel schedule invokes `GET /api/jobs/run` every five minutes.
Set an independent `CRON_SECRET`; Vercel sends it as an exact `Authorization:
Bearer ...` value and the route fails closed without it. A five-minute schedule
requires Vercel Pro or Enterprise. Vercel Hobby currently permits cron jobs only
once per day, so Hobby deployments must change `vercel.json` to a daily
schedule. See [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Self-hosted Docker deployments do not depend on scheduled HTTP requests. The
same digest-pinned, nonroot Distroless application image runs the standalone
server, one-shot migration, administrator bootstrap, seed, continuous worker, and smoke launchers as
direct Node commands. Compose retains `init: true`: Docker's init is PID 1 and
the Node runtime is its direct child, with no shell or package-manager wrapper.
It contains no shell, package manager, TypeScript source, test tree, or
build-only tools. Operators can execute `pnpm jobs:run-once` from
a source checkout for a bounded diagnostic pass; that development command is
not shipped in the runtime image.

The ordinary Compose stack publishes only the loopback application port. Its
PostgreSQL, authenticated Redis, private MinIO API, migration, bucket
initializer, and worker remain private. The MinIO root console requires the
explicit loopback-only `docker-compose.console.yml` override; Ollama and model
download require the separate Ollama profile. MinIO is local/CI compatibility
storage—production operators should use private R2 or AWS S3. See the
[Docker operations runbook](docs/operations/docker.md) for secrets,
health/drain, isolated smoke, backup/restore, upgrade, and incident procedures.

Client-address rate limits accept proxy metadata only through an explicit
trust mode. Vercel deployments use `TRUSTED_PROXY_MODE=vercel` and accept only
Vercel's single-address `x-vercel-forwarded-for` value. Docker defaults to
`TRUSTED_PROXY_MODE=none`, so ordinary forwarding headers never select a client
bucket. Authentication requests without a verified client address use an
`AUTH_SECRET`-keyed, target-bound fallback bucket; this keeps unknown clients
fail-closed without letting one spoofed or missing address exhaust every user's
signup, sign-in, or recovery budget. Better Auth receives only the application's internal
verified-address header and never reads caller-supplied `x-forwarded-for`. The optional
Docker `hmac` mode accepts only `x-humans-client-address` paired with a lowercase
hex `x-humans-client-address-signature` HMAC. That mode requires an edge proxy
which strips client-supplied Humans and forwarding headers, replaces them with
the network peer address it directly observes, and canonicalizes and signs that
observed peer rather than any client-supplied forwarding value. The proxy must
also prevent all direct access to the application port. A signed header is not
a safe boundary if clients can bypass that proxy.

The application-owned 2FA password boundary uses the same trusted client
classification plus user/operation HMAC material in PostgreSQL for an atomic
five-attempt, five-minute budget. Auth responses expose a sanitized
`x-request-id`, with the same value added to JSON error bodies for support-safe
correlation.

Generate `PROTECTED_LOOKUP_HMAC_KEY`, `OPERATION_LIMIT_HMAC_KEY`, and (when
needed) `TRUSTED_PROXY_HMAC_KEY` independently with `openssl rand -hex 32`.
They must differ from every other application secret. Protected exact lookup
uses its HMAC key only for workspace-bound blind indexes; display values remain
under the separate `DATA_ENCRYPTION_KEY`. The canonical search GraphQL field
exposes only an authorized PERSON result for an exact PHONE or
PERSON_IDENTIFIER match; it never returns the submitted value, ciphertext, or
blind index. Phone, email, and other protected contacts support durable create,
read, update, and archive operations with post-write authorization checks.

Deployment evidence is not complete yet. Track it in [TODO.md](TODO.md) and use
[the self-hosted alpha boundary](docs/releases/SELF_HOSTED_ALPHA.md) rather than
treating this foundation as a completed MVP or as production-ready.

## Security and privacy

Humans is designed for sensitive research data. Workspace isolation, record-level authorization, private object storage, redacted logs, explicit AI access policy, and auditable changes are acceptance requirements. The public repository ignores local secrets, data exports, uploads, database volumes, and agent scratch state. See [SECURITY.md](SECURITY.md) for reporting instructions and [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for the verifiable security contract.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Requirements](docs/REQUIREMENTS.md)
- [Self-hosted alpha boundary](docs/releases/SELF_HOSTED_ALPHA.md)
- [Product and interface design](docs/DESIGN.md)
- [Docker operations](docs/operations/docker.md)
- [Authentication operations](docs/operations/authentication.md)
- [Workspace member operations](docs/operations/workspace-members.md)
- [Repository governance](docs/REPOSITORY_GOVERNANCE.md)
- [Dependency policy](docs/DEPENDENCY_POLICY.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
