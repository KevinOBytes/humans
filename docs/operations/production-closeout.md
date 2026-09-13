# Production closeout

## Current release evidence (2026-09-13, collaboration/runtime release)

Commits `4b55c33`, `556ad33`, and the documentation release `d08bbcd` are
pushed to `main`. GitHub Actions runs `34767480893` and `34768072841` passed
all nine required jobs: Node 24 quality, real PostgreSQL
integration, browser acceptance, production build, generated drift, Compose
lifecycle, image security, dependency policy, and secret scanning. The current
runtime tree was deployed as Vercel `dpl_F4MjcikAGaGnh1AEgKBgxyEyvQhk`
(`READY`) with aliases `humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. Redacted production smoke passed homepage,
liveness, readiness with PostgreSQL/Redis/storage, unauthenticated GraphQL,
and the protected jobs boundary. Vercel inspection reports Node 24 runtime
functions.

This release adds first-class workspace-scoped teams, team membership, explicit
case-team sharing grants, investigations, and investigation-case links. Their
schema, migration, authorization, principal-bound idempotency, audit, and
GraphQL contract tests are green. There is not yet a dedicated investigations/
teams administration UI, and hosted credentialed sign-in/person creation plus
external provider-contract acceptance remain unverified. Vercel's protected
secret values were not exported; the attended administrator password-rotation
procedure below is still required before accepting hosted authentication.

## Current release evidence (2026-09-13, latest runtime)

The latest verified `main` tree at commit `591c1d7` is pushed to GitHub and
deployed as Vercel `dpl_HSK2gk4swq1gvyiBYawCrx3UiJaT` (`READY`). The deployment
aliases `humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. GitHub Actions run `34760813821` passed all
nine required jobs: Node 24 quality, PostgreSQL integration, browser
acceptance, production build, generated drift, Compose lifecycle, image
security, dependency policy, and secret scanning. Public probes returned
homepage `200`, liveness `200`, readiness `200` with PostgreSQL/Redis/storage
healthy, unauthenticated GraphQL `401`, and protected jobs `401`, all with
correlation IDs.

Hosted credentialed sign-in, administrator bootstrap/rotation, person creation,
and external-provider contract acceptance remain unverified because protected
Vercel secrets are intentionally not exported into the local environment. The
break-glass and bulk-query features are bounded, auditable local/runtime seams;
the administrator review UI is now available at `/settings/break-glass` for
owner/admin users. The complete hosted/provider/privacy/accessibility/
performance matrix remains open. Bulk-query alert counts are
computed across the complete visible query result before cursor pagination for
both text and protected-exact search; this remains subject to the fixed
statement timeout and operation budgets.

This was a manual Vercel deployment of the current `main` tree after the
documentation-only release commit. Vercel does not expose a Git SHA for this
manual deployment, so the repository commit and deployment ID are recorded
together; this does not substitute for hosted authenticated/provider evidence.

An additional redacted hosted smoke attempt on 2026-09-13 parsed the
operator-controlled ignored `.env` with dotenv and injected it without
printing secret values. Public routes/readiness passed, but email sign-in
returned `403 AUTH_REQUEST_FAILED`. Treat this as an unsuccessful credentialed
probe only; complete the attended hosted password rotation procedure below
before accepting production authentication.

## Current release evidence (2026-09-13, latest)

The clean `main` tree at commit `f74c82a` is pushed to GitHub and has a green
GitHub Actions run `34751719602` (dependency policy, secret scan, generated
drift, Compose lifecycle, production build, PostgreSQL integration, quality,
browser acceptance, and image security all passed). It was deployed directly
to Vercel as `dpl_A5jgMwiP6CqAdjZxHaLsGCZZfPsX` (`READY`) with aliases
`humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`.

Fresh public probes against `https://humans.kevinbytes.com` returned homepage
`200`, liveness `200`, readiness `200` with PostgreSQL/Redis/storage healthy,
and unauthenticated GraphQL `401` with a correlated request ID. This proves
the deployed public boundary and provider readiness only. Hosted credentialed
sign-in, administrator bootstrap/rotation, person creation, and external
provider-contract acceptance remain unverified because protected Vercel
secrets are not exported into the local environment. Do not mark those rows
complete without an attended operator run using temporary mode-0600 values.

## Current release evidence (2026-09-13)

The merged `main` tree (`56d276e`, `19a0a77`, `b062fdb`) was deployed as
`dpl_HZhpCKissKs3Ei3KuP8icFBgS3eh` (`READY`) with the configured custom
aliases. Redacted public smoke passed the homepage, liveness, readiness,
unauthenticated GraphQL, and protected jobs checks. The opt-in authenticated
smoke returned `403 AUTH_REQUEST_FAILED`; Vercel marks the production
`DATABASE_URL` sensitive and the CLI will not retrieve it, so the documented
attended rotation has not been run. Keep hosted authentication and provider
acceptance open until an authorized operator injects that URL from the approved
secret manager for the attended rotation and reruns the authenticated smoke.

The repository includes a redacted smoke harness for a deliberately selected
deployment. It is safe to run against a local Compose URL, a Vercel preview,
or the production hostname only when the operator has chosen that target:

```sh
pnpm production:smoke -- --base-url https://humans.kevinbytes.com
```

The harness checks the homepage, liveness, readiness, unauthenticated GraphQL,
and the protected jobs route. A successful readiness probe must identify
configuration, PostgreSQL, Redis, and object storage as healthy; a bare
`status=ready` response is not accepted. It prints status codes, dependency
names, provider labels, and correlation IDs only. Response bodies, account or
workspace identifiers, credentials, cookies, provider payloads, person values,
TOTP values, and backup codes are never printed.

For production authentication, use a secret manager to inject values only into
the child process. The repository includes a reference-only 1Password template;
copy it to an ignored file and edit only its `op://` references:

```sh
cp docs/operations/production-operator.op.env.example .env.operator.op.tpl
$EDITOR .env.operator.op.tpl
op run --env-file .env.operator.op.tpl -- \
  pnpm production:smoke -- --base-url https://humans.kevinbytes.com --two-factor
```

The private template contains references, not rendered values. `op run` resolves
them only in the child environment and masks resolved secrets in child output;
never use `--no-masking`. Do not use `op inject`, `vercel env pull`, shell
assignments, command substitutions, or a populated temporary environment file
for this acceptance procedure. Use a narrowly scoped 1Password account or
service account with access only to the required items.

The authenticated smoke checks password acceptance through both the email and
username endpoints. With `--two-factor`, it requires the same account policy on
both identifiers, completes one email-session challenge through exactly one
process-injected TOTP or backup code, then proves the authenticated GraphQL
viewer and creates/reads a fictional smoke-test person. A backup code is
consumed; use a disposable current code approved for this check. TOTP and backup
values are mutually exclusive, and a requested 2FA check fails before making a
network request when neither or both are injected.

Provider lifecycle contracts are separately opt-in. Add
`--provider-contracts` to the same `op run` command only when
`RUN_EXTERNAL_PROVIDER_CONTRACTS=true` and at least one complete Upstash REST or
S3-compatible test credential group is injected. Partial credential groups fail
closed before any provider request. No complete group produces an explicit
`unavailable` result and no request. When enabled, the child provider suite
round-trips disposable, namespaced Redis and private object-storage fixtures,
deletes them, suppresses all child output, and reports provider labels only.
This is destructive only to the generated test keys/objects and must use an
approved test bucket/database rather than irreplaceable data.

The readiness endpoint and these lifecycle checks cover PostgreSQL, Redis, and
object storage. They do not prove Resend delivery, OpenAI-compatible/Ollama
generation, or web-search results; keep those provider rows unverified until
their dedicated attended acceptance is recorded. The harness is evidence
collection, not a deployment command. Record only the exact Ready deployment
SHA/ID, aliases, timestamp, redacted outcomes, and provider labels.

## Hosted administrator recovery

Administrator bootstrap is deliberately idempotent: changing `ADMIN_PASSWORD`
does not silently overwrite an existing credential. If the configured hosted
credential is unknown or stale, an operator with approved database-secret
access must use the same reference-only template to inject the hosted
`DATABASE_URL` and four `ADMIN_*` values into the explicit recovery command:

```sh
op run --env-file .env.operator.op.tpl -- \
  pnpm operator:rotate-admin-password
```

The operator command intentionally does not load `.env` or `.env.local`. It
parses only the injected database URL and administrator fields, takes the
database advisory lock, rotates the selected credential, and emits only
`created`, `reconciled`, and `passwordRotated` booleans. It does not emit the
administrator UUID or any secret material. Delete the reference-only private
template after the window if local policy requires it; it never contains
rendered secrets.

After rotation, run the authenticated 2FA smoke in a new `op run` invocation so
1Password supplies a current TOTP. Vercel's protected values are not a recovery
transport and must not be retrieved or copied into the repository, shell
history, logs, tickets, screenshots, or a browser. If an approved database URL,
replacement password, and current second factor are unavailable, report the
corresponding acceptance step as **unverified**; do not disable 2FA, weaken
authentication, or infer success from public readiness.
