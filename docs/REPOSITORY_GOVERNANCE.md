# Repository governance

This document defines the repository controls Humans maintainers intend to use. The workflow is executable locally and on GitHub Actions, but hosted controls are not yet verified. Creating a public repository does not by itself enable branch protection, required checks, private vulnerability reporting, Dependabot alerts, or hosted secret scanning.

## Required-capable checks

After the first successful run on the public repository, maintainers should verify the exact check names and require these checks on the default branch:

- `quality`: formatting, lint, TypeScript, and unit tests.
- `generated-drift`: Drizzle metadata, Better Auth schema, and generated GraphQL operations.
- `database-integration`: the real PostgreSQL 18 integration seam.
- `production-build`: the production Next.js build.
- `compose-lifecycle`: Compose configuration and the isolated persistence, recovery, health, and cleanup lifecycle.
- `dependency-policy`: fail-closed production licenses, high/critical production audit, and pull-request dependency review.
- `secret-scan`: full-history and pull-request Gitleaks scanning.
- `image-security`: one local application image, its bounded SBOM artifact, and high/critical vulnerability scanning of that exact image.

The public-repository owner must still confirm branch protection or rulesets, require pull requests, require conversation resolution, prevent force pushes and branch deletion, restrict bypasses, and verify the checks above from an actual workflow run. Record the live evidence before changing `HUM-NFR-014` or `HUM-NFR-017` to Complete.

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

## Public-repository settings checklist

The following items require live configuration and evidence and are not yet verified:

- Repository visibility, default branch, merge strategy, and deletion policy.
- Branch protection or rulesets and the actual required check names.
- Dependabot alerts and security updates.
- Private vulnerability reporting and the security-policy route.
- Hosted secret scanning, push protection, and any availability constraints for a public repository.
- Environment protection, deployment credentials, Vercel integration, and production-domain ownership.

## Release image verification

The application Dockerfile pins the official Node `24.18.0-trixie-slim`
builder and Distroless `nodejs24-debian13:nonroot` runtime by immutable
multi-architecture index digest and records those digests plus the resolution
date in OCI labels. The image workflow builds `linux/amd64`; local release
evidence also verifies `linux/arm64`, including the architecture-specific
Sharp/libvips optimizer path. A hosted workflow result is still required.

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
