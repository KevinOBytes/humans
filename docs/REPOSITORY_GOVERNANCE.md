# Repository governance

This document defines the repository controls Humans maintainers use. Live settings were verified through the GitHub API on 2026-08-04 against the public `KevinOBytes/humans` repository. Repository ruleset `20371861` protects `main`; security and merge settings are recorded below. Re-verify these external controls during every release audit because committed files cannot enforce or prove their continued state.

## Required checks

The active `Protect main` ruleset requires these exact successful checks on the latest commit before merge:

- `quality`: formatting, lint, TypeScript, and unit tests.
- `generated-drift`: Drizzle metadata, Better Auth schema, and generated GraphQL operations.
- `database-integration`: the real PostgreSQL 18 integration seam.
- `production-build`: the production Next.js build.
- `compose-lifecycle`: Compose configuration and the isolated persistence, recovery, health, and cleanup lifecycle.
- `dependency-policy`: fail-closed production licenses, high/critical production audit, and pull-request dependency review.
- `secret-scan`: full-history and pull-request Gitleaks scanning.
- `image-security`: one local application image, its bounded SBOM artifact, and high/critical vulnerability scanning of that exact image.

Ruleset `20371861` requires pull requests, resolved review conversations, strict current-branch checks, and squash merges. It blocks force pushes and deletion. Only the GitHub repository-admin role has an explicit bypass; ordinary collaborators and automation have none. Successful public runs [30900728396](https://github.com/KevinOBytes/humans/actions/runs/30900728396), [30900760773](https://github.com/KevinOBytes/humans/actions/runs/30900760773), and post-merge `main` run [30901164011](https://github.com/KevinOBytes/humans/actions/runs/30901164011) prove the exact check names and all eight gates.

## Workflow safety

The CI workflow grants read-only repository contents, cancels superseded runs, bounds jobs and steps, and does not use `pull_request_target`. Pull requests do not receive repository secrets or write permissions. Checkout credentials are not persisted. Dependency review is limited to pull-request events because its comparison API is not available on ordinary pushes; the local license and audit checks run on every event.

Every third-party action is pinned to a 40-character commit SHA with its release tag in an adjacent comment. To update a pin:

1. Read the upstream release notes and action source from the official repository.
2. Resolve both the tag and any annotated-tag target with `git ls-remote https://github.com/OWNER/REPOSITORY.git 'refs/tags/TAG' 'refs/tags/TAG^{}'`.
3. Use the dereferenced action-code commit, not an annotated tag object.
4. Review transitive actions and runtime changes, update the contract test, and run all CI contracts.
5. Keep the pin update in a focused pull request with rollback notes.

No `CODEOWNERS` file is committed until the actual maintainer account or team has been verified in the public repository.

### Gitleaks false-positive review

Gitleaks scans both repository history and the exact staged change. The committed
`.gitleaksignore` contains only full fingerprints for reviewed historical test
fixtures and one prose match. It contains no rule, path, regular-expression, or
wildcard suppression. A new match must be removed or investigated; adding a
fingerprint requires independent review proving the redacted finding is
synthetic, non-provider-specific, and not a live credential. Never ignore a
Task 15C or later finding merely to make CI pass.

## Dependency and automation updates

Dependabot proposes bounded weekly npm/pnpm and GitHub Actions updates. Maintainers review lockfile scope, changelogs, licenses, audit results, build output, generated drift, migrations, and deployment compatibility. Automatic merging is not part of this policy. Docker update automation remains disabled until architecture-aware digest verification and safe cross-major review are enforceable.

Policy exceptions require a named owner, exact package/version or control, justification, compensating controls, and an expiry date. Expired exceptions fail the relevant gate. Renewals require a new review; permanent blanket exceptions are prohibited.

## Public-repository settings evidence

The 2026-08-04 live API audit verified:

- The repository is public and `main` is the default branch.
- Squash is the only enabled merge strategy and merged branches are deleted automatically.
- Ruleset `20371861` is active for `main` with the pull-request, conversation-resolution, deletion, non-fast-forward, and eight required-check rules described above.
- Dependabot alerts/security updates, private vulnerability reporting, hosted secret scanning, and push protection are enabled.
- The committed security policy, contribution templates, issue forms, weekly bounded Dependabot policy, and SHA-pinned workflow remain the reviewed source controls. The live checks above verify only the corresponding hosted settings.

Environment protection, deployment credentials, the Vercel integration, and production-domain ownership remain deployment evidence under the hosting requirements; they are not claimed by the repository-governance rows. `CODEOWNERS` remains intentionally absent until a second verified maintainer account or team exists.

## Release image verification

The application Dockerfile pins the official Node `24.18.0-trixie-slim`
builder and Distroless `nodejs24-debian13:nonroot` runtime by immutable
multi-architecture index digest and records those digests plus the resolution
date in OCI labels. The image workflow builds `linux/amd64`; local release
evidence also verifies `linux/arm64`, including the architecture-specific
Sharp/libvips optimizer path. Hosted `image-security` evidence is included in
the successful public runs above.

Before renewing either application base, resolve the official tag, inspect the
manifest list, confirm both supported architectures, review upstream provenance
and the strict vulnerability result, and change the Dockerfile pin, OCI label,
resolution date, and contract tests together. Do not substitute a
single-platform child digest for a multi-platform index digest.

PostgreSQL, Redis, MinIO, and MinIO client Compose tags are not yet digest
pinned. Before release, resolve each official tag, record its immutable
manifest-list digest, review platform membership, and verify signatures or
attestations when the publisher provides them. Any application or service
digest change requires a focused operational review and a clean Compose
lifecycle run.
