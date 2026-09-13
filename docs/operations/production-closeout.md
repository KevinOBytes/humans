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
acceptance open until an authorized operator supplies that URL directly to the
temporary mode-0600 rotation environment and reruns the authenticated smoke.

The repository includes a redacted smoke harness for a deliberately selected
deployment. It is safe to run against a local Compose URL, a Vercel preview,
or the production hostname only when the operator has chosen that target:

```sh
pnpm production:smoke -- --base-url https://humans.kevinbytes.com
```

The harness checks the homepage, liveness, readiness, unauthenticated
GraphQL, and the protected jobs route. It prints status codes, workspace IDs,
and correlation IDs only; response bodies, credentials, cookies, provider
payloads, and person values are never printed. Authenticated synthetic-person
coverage is opt-in and requires process-injected values:

```sh
PRODUCTION_SMOKE_AUTH=1 \
  ADMIN_EMAIL='operator-provided-value' \
  ADMIN_USERNAME='operator-provided-value' \
  ADMIN_PASSWORD='operator-provided-value' \
  pnpm production:smoke -- --base-url https://humans.kevinbytes.com
```

The authenticated smoke signs in separately through both the configured email
and username endpoints before creating the synthetic person. All three
administrator values are required so a successful smoke proves the same
identifier paths exposed by the sign-in page; it does not rotate the password
or claim provider acceptance.

Provider contracts are separately opt-in with
`--provider-contracts` and `RUN_EXTERNAL_PROVIDER_CONTRACTS=true`; missing
provider credentials skip the external portion rather than making an
unexpected request. Do not place these values in the repository or paste them
into logs. The harness is evidence collection, not a deployment command: an
operator must record the exact Ready deployment SHA, aliases, provider
configuration, and authenticated result in the release record after running
it.

## Hosted administrator recovery

Administrator bootstrap is deliberately idempotent: changing `ADMIN_PASSWORD`
does not silently overwrite an existing credential. If the configured hosted
credential is unknown or stale, an operator with approved database-secret
access must place the hosted `DATABASE_URL` and the four `ADMIN_*` values in a
temporary, mode-0600 `.env.local`, run:

```sh
pnpm admin:rotate-password
```

Then remove the temporary file and rerun the authenticated smoke with the same
operator-injected email/password. Vercel's protected secret values must not be
exported into the repository, shell history, logs, or a browser. This explicit
procedure is required before marking hosted sign-in/person creation complete.
