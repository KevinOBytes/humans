## Requirement IDs

List the `HUM-FR-*` and `HUM-NFR-*` requirements affected by this change.

## Test evidence

Provide RED-to-GREEN evidence and the exact validation commands and results.

## Migration and schema impact

Describe database, Drizzle, Better Auth, GraphQL, and generated-file impact, or state why none exists.

## Security and privacy impact

Describe authentication, authorization, tenant isolation, secret handling, personal-data, upload, audit, and dependency impact.

## Documentation

List updated documentation or explain why no documentation change is required.

## Operations

Describe self-hosted, worker, storage, backup, observability, and support impact.

## Rollback

Describe the tested rollback path, including data compatibility and irreversible steps.

## Deployment

List configuration changes, rollout order, health checks, and post-deployment verification. Do not include secrets.

## Checklist

- [ ] Tests use synthetic data and contain no credentials or personal data.
- [ ] Generated artifacts are in sync.
- [ ] Security, dependency, and operations gates relevant to this change pass.
- [ ] Migration and rollback behavior are documented and tested when applicable.
