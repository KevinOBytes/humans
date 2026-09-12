# Production closeout

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
