# Production closeout

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
  ADMIN_PASSWORD='operator-provided-value' \
  pnpm production:smoke -- --base-url https://humans.kevinbytes.com
```

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
