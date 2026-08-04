# Docker operations

This runbook covers the local and self-hosted Compose topology. It is not proof
of a hosted production deployment. The application builder and runtime bases
are pinned to reviewed multi-architecture index digests; the PostgreSQL, Redis,
MinIO, and MinIO client service tags remain explicit but are not digest pinned.
Resolving and verifying those service manifest-list digests is a release
blocker. Never invent or copy a per-platform child digest into the Compose
files.

## Ownership and recovery targets

- RPO: TBD by the deployment owner.
- RTO: TBD by the deployment owner.
- Region: TBD by the deployment owner.
- Alert owner: TBD by the deployment owner.
- Backup retention and encryption-key custodian: TBD by the deployment owner.

## Topology and prerequisites

Use Docker Engine with Compose v2. The base stack runs PostgreSQL 18, an
authenticated Redis 8.6.1 with AOF, private MinIO, idempotent bucket
initialization, one-shot migration, the Next application, and its continuous
worker. An opt-in one-shot administrator bootstrap uses that same image.
Migrate, bootstrap, app, worker, and smoke use the same image reference. The
backend network is internal; only the application is bound, on loopback, by
default.

The application image uses Next.js standalone output plus explicitly compiled
runtime launchers and Node File Trace dependencies. Its final stage is the
digest-pinned Distroless Node 24 Debian 13 nonroot image. Compose retains
`init: true`, so Docker's init is PID 1 and the direct Node child receives
forwarded termination signals without a shell or package-manager wrapper. The
image contains no shell, package manager, TypeScript source, test tree, or
build-only tooling. Compose passes JavaScript entrypoint arguments directly and
uses `/nodejs/bin/node` for health checks. The automated lifecycle proof checks
the live init-to-Node process tree before exercising signal drain and fencing.
The writable surfaces are bounded tmpfs mounts owned by UID/GID 65532.

MinIO is a local/CI compatibility service, not the recommended production
object store. A production deployment should use private Cloudflare R2 or AWS
S3 with provider-native durability, lifecycle, versioning, and recovery. Do not
claim R2 or AWS S3 parity based on a MinIO smoke.

Copy `.env.example` to the ignored `.env`. Generate every secret independently;
for 32-byte hexadecimal values use `openssl rand -hex 32`. Do not reuse the
PostgreSQL, Redis, MinIO, authentication, encryption, HMAC, administrator,
Resend, proxy, cron, or AI credentials. Restrict `.env` to the deployment
operator and rotate a credential immediately if it appears in a log, image,
shell history, backup, or support artifact.

Set `AUTH_REGISTRATION_MODE=invite_only` for the default self-hosted posture,
or explicitly choose `disabled` or `public`. Registration-mode changes require
an application restart. Recovery and two-factor operational guidance lives in
the [authentication runbook](authentication.md).

Docker defaults `TRUSTED_PROXY_MODE=none`: the application ignores forwarding
headers and auth limits use a target-bound keyed fallback. To retain per-client
address buckets behind an edge, use `hmac` mode only when the edge strips inbound
forwarding/Humans headers, signs its directly observed peer address, and is the
only network path to the application. Never forward a client-supplied
`x-forwarded-for` value into this trust boundary.

Validate and start the ordinary stack:

```sh
docker compose config --quiet
docker compose up --build --detach --wait app worker
docker compose ps --all
```

The migration and bucket initializer must exit zero; app and worker plus the
three durable services must report healthy. The ordinary stack intentionally
has no Ollama container. Its configured Ollama endpoint is unavailable until
the explicit overlay is enabled, and AI availability is not part of app
readiness.

## One-shot administrator bootstrap

Migration never creates or reconciles an administrator. After migrations have
completed, run the explicit bootstrap service from an attended operator shell:

```sh
docker compose --profile bootstrap run --rm bootstrap-admin
```

Only this disposable service receives `ADMIN_EMAIL`, `ADMIN_USERNAME`,
`ADMIN_DISPLAY_NAME`, and `ADMIN_PASSWORD`. The app, worker, migration, and
seed services neither receive nor parse those values. Confirm the container is
removed after it exits and avoid shell tracing or command-line assignment of
the password; keep the values in the ignored, operator-restricted `.env` only
for the duration needed.

Bootstrap is transactional, advisory-lock serialized, and idempotent. A first
run creates the verified global administrator and Better Auth credential. A
later run may reconcile that identity's email, username, display name, and
administrator role, and may recreate a missing credential. It deliberately
does not replace an existing password hash. Therefore changing
`ADMIN_PASSWORD` and rerunning bootstrap is not password rotation. Use the
authenticated password-change/recovery flow when available; if the credential
is lost before that production flow is approved, stop the application, follow
an audited database recovery procedure to remove only the affected credential,
then rerun bootstrap and rotate/remove the bootstrap secret immediately.

For a source-based or hosted deployment, run the equivalent one-shot command
from a restricted release environment with the production database and normal
server configuration available:

```sh
pnpm db:migrate
pnpm admin:bootstrap
```

For Vercel/Neon, this is a release or operator job, not a Vercel function
startup action. Supply `ADMIN_*` only to that one-shot job (or temporarily to a
restricted operator environment), never commit them, and remove them from
Vercel project/runtime variables afterward. Record only the non-secret result
and timestamp in the deployment evidence.

## Console and optional Ollama

The MinIO root console is absent from the ordinary stack. For local, attended
troubleshooting only, add `docker-compose.console.yml`; it binds the console to
loopback:

```sh
docker compose -f docker-compose.yml -f docker-compose.console.yml up --detach minio
```

Do not use that override on a public host. Remove it after the diagnostic
session and rotate the MinIO root credentials if they were exposed.

Ollama and model download are explicit opt-in work:

```sh
docker compose -f docker-compose.yml -f docker-compose.ollama.yml \
  --profile ollama config --quiet
docker compose -f docker-compose.yml -f docker-compose.ollama.yml \
  --profile ollama up --detach ollama-init app worker
```

Model download time, disk use, model suitability, and the optional AI smoke are
not base-stack prerequisites. The optional Ollama runtime remains unverified in
the current Task 15B evidence.

## Health, worker drain, and observability

- `/api/health/live` proves the HTTP process is responding.
- `/api/health/ready` verifies configuration, PostgreSQL, Redis, and object
  storage without returning credentials.
- The worker writes only `{"updatedAt":<epoch-ms>}` to its private tmpfs
  heartbeat. It refreshes the bounded marker from the live claim loop and
  removes it after drain. The container healthcheck rejects missing, malformed,
  future, oversized, or older-than-40-second markers.
- `SIGTERM` and `SIGINT` stop new work and signal the current bounded pass.
  Cooperative handlers check the signal at lease and transaction boundaries.
  PostgreSQL and Redis ownership are retained until the active handler promise
  actually settles. Only then does the worker use the PostgreSQL lease owner
  and claim generation to fence completion, return the job to the retry queue
  without consuming an attempt, release its Redis lease, and exit zero. This is
  a durable retry handoff, not a claim that interrupted work completed.
- Each pass signals its handler at 25 seconds. If the handler has not settled
  after another 5 seconds, the worker hard-exits nonzero without requeueing or
  releasing either lease; process death stops the handler, and durable lease
  expiry/fencing controls retry. Compose grants 35 seconds before forced
  termination. An externally signalled non-cooperative handler similarly keeps
  ownership until Compose sends `SIGKILL` at its grace boundary; it is not
  reported as a graceful drain.
- The heartbeat refreshes independently during healthy work, stops immediately
  on drain or deadline, and disappears when the worker or its private tmpfs
  exits. Startup or heartbeat failures exit nonzero.

Inspect `docker compose ps --all` and narrowly scoped `docker compose logs`.
Never export raw production logs without redaction. Alert on app/worker
unhealthy state, one-shot nonzero exit, dependency restarts, PostgreSQL storage
pressure, MinIO failures, Redis persistence errors, and dead-letter growth.
Metric labels and logs must not contain credentials, cookies, authorization
headers, query variables, private file bytes, protected values, prompts, or
presigned URLs.

## Automated isolated proof

The runners generate unique Compose project, image, volume, network, bucket,
port, database, and synthetic-secret values. Cleanup always uses `down
--volumes`; they never attach to the ordinary `humans` project or developer
volumes.

```sh
pnpm test:compose:config
pnpm test:compose:smoke
pnpm test:compose:lifecycle
pnpm runtime:image:verify -- humans:local .tmp/runtime-manifest.json
pnpm runtime:image:optimizer -- humans:local
```

The smoke builds without cache, starts the health-gated stack, reuses the Task
12 authenticated session/API-key path, and scans service logs plus image
metadata/history for its runtime secrets. The lifecycle drill also proves
PostgreSQL and object bytes across restarts, Redis AOF continuity followed by
safe empty-Redis recovery, a custom-format PostgreSQL backup restored into a
fresh database with an integrity count, and an active claimed-job drain that
verifies durable retry state, stale-completion fencing, heartbeat removal, and
exit within the Compose grace period.

The image verifier checks the pinned-base labels, architecture, Node version,
direct PID-1 command, nonroot/read-only behavior, cold imports for migration,
bootstrap, seed, and worker launchers, required assets, bounded symlinks, and the absence
of source, secrets, package managers, and build tools. The optimizer proof
forces a cache miss in the final read-only image, requires a valid PNG to become
valid WebP through the platform-specific Sharp/libvips payload, rejects bounded
malformed and excessive-channel probes, and confirms the server remains live.

## PostgreSQL and object backup/restore

Run backups from a direct, authenticated PostgreSQL connection. A minimum
database procedure is:

```sh
pg_dump --format=custom --no-owner --file=humans.dump "$MIGRATION_DATABASE_URL"
sha256sum humans.dump
chmod 600 humans.dump
createdb "$ISOLATED_RESTORE_DATABASE_URL"
pg_restore --no-owner --exit-on-error --dbname="$ISOLATED_RESTORE_DATABASE_URL" humans.dump
```

Encrypt the backup before it leaves the restricted host, store its checksum and
schema/application version separately, apply retention, and rehearse restore
into a fresh database. After restore, run migrations, compare workspace and
critical-table counts, and perform authorized sample reads. Never restore over
the active database.

Database and object backups form one recovery point. For local MinIO, record a
manifest of object keys, ETags, sizes, and application checksums and use `mc
mirror` into a new private target. Verify representative object bytes and their
database references after restore. Production R2 or AWS S3 must use the
provider's maintained versioning, replication, lifecycle, and recovery tools.

Redis contains only cache, rate-limit, coordination, and lease state. AOF gives
local restart continuity, but Redis is never part of the authoritative backup.
The application must recover safely from an empty Redis.

## Upgrade and rollback

1. Re-resolve the official Node builder and Distroless runtime tags, verify
   their multi-architecture indexes contain `linux/amd64` and `linux/arm64`,
   review publisher provenance and vulnerabilities, then update both exact
   Dockerfile digests, their OCI labels, the resolution date, and contract
   tests together. Resolve the remaining Compose service digests and update the
   release record.
2. Verify a fresh backup and isolated restore before changing services.
3. Review migration backward compatibility. Deploy schema-compatible code,
   then run the one-shot migration exactly once.
4. Roll app and worker with the same image digest and observe health, logs, job
   leases, and dead letters.
5. Roll application code back only while the migrated schema is documented as
   compatible. Otherwise forward-fix; migrations are forward-only.

Never attach a Redis AOF volume to a different Redis major. Export only state
that is truly needed, stop the old service, and start the new major with a clean
Redis volume. An empty coordination/cache store must be safe. PostgreSQL and
MinIO volume formats also require their upstream compatibility procedure.

## Incident response and secret rotation

1. Restrict access, preserve a redacted timeline, and identify affected
   workspaces/services without copying private payloads into tickets.
2. If integrity is uncertain, stop new writes and gracefully drain the worker.
   Do not destroy containers or volumes needed for investigation.
3. Rotate one credential at a time in the backing service and ignored runtime
   environment, restart the affected consumers, verify readiness, then revoke
   the old value. Encryption-key rotation requires an application-specific
   re-encryption plan; do not simply replace a key protecting stored data.
4. For database/object loss, restore both sides to the same recovery point in
   isolated targets, validate counts/checksums/authorization, then approve a
   controlled cutover.
5. Record root cause, affected data, recovery evidence, and preventive action.

## Release checks

Before a self-host release, run exact Node 24 formatting, linting, type checking,
unit/integration suites, schema/codegen drift checks, the production build, the
rendered Compose contracts, and the isolated lifecycle drill. Review the staged
diff and image history for secrets. Record service image digests,
architectures, backup checksum, restore counts, worker drain duration, skipped
external checks, and cleanup evidence. A mutable tag, missing optional Ollama
smoke, unassigned recovery target, or unverified hosted provider remains an
explicit blocker; do not relabel it as passed.

Generate an SPDX JSON SBOM from the exact image under review, verify every
runtime manifest dependency is present and build tools are absent, then scan
that unchanged image with Trivy using `HIGH,CRITICAL`,
`--ignore-unfixed=false`, and exit code 1. The accepted count is zero high and
zero critical; use a separate diagnostic image only for an explicit,
non-release debugging session.
