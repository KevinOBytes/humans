# Dependency policy

Humans reviews production dependency licenses and vulnerabilities as release gates. The repository-local checker uses the installed production graph reported by pnpm and evaluates each declared SPDX expression against `config/allowed-dependency-licenses.json`.

## License evaluation

The checker understands SPDX parentheses plus `AND`, `OR`, and `WITH`: every `AND` term must be allowed, one allowed `OR` choice is sufficient, and a `WITH` exception must be separately approved. Malformed, missing, unknown, `LicenseRef-*`, or unapproved expressions fail closed. A package is not approved merely because a parent package uses an approved license.

The allowlist records why each license family is acceptable. Obligations still apply: preserve notices and attribution, keep covered modifications compliant with file-level or library copyleft, and review distribution changes. Maintainers must inspect upstream license files when metadata is ambiguous.

Run the policy with:

```bash
corepack pnpm deps:licenses
corepack pnpm deps:audit
```

The production audit fails on high or critical advisories. A new dependency or update must pass both commands without deleting findings or reducing severity thresholds.

## Exceptions

License exceptions belong in the policy file and must identify one exact package, version, and license expression. Every exception requires an owner, a concrete rationale, an ISO date expiry, and documented compensating controls. The checker rejects expired or incomplete exceptions. Vulnerability exceptions require separate security review and similarly narrow ownership and expiry; there are no implicit or permanent exceptions.

## Review and updates

For every dependency change:

1. Review the package source, maintainer history, release notes, license files, install scripts, and transitive graph.
2. Confirm the lockfile contains only intended changes and rerun the fail-closed license checker.
3. Run the high/critical production audit and image scan.
4. Run affected tests, the production build, generated-drift checks, and the Compose lifecycle where runtime packages change.
5. Document rollback, migration, and deployment consequences in the pull request.

Dependabot groups bounded minor and patch updates weekly. Major updates remain individually reviewable. GitHub Actions updates must also be converted from proposed tags to official, dereferenced 40-character action-code commits before merge.

## SBOM and container boundary

CI builds one local application image without publishing it, verifies its
Distroless configuration and behavior, generates an SPDX JSON SBOM from that
exact image, uploads only the bounded SBOM artifact for seven days, and scans
the unchanged image. The runtime manifest records every package name and
version discovered in the final assembled runtime filesystem; CI fails if any
of them is absent from the SBOM or if
esbuild, Node File Trace, TypeScript, Vitest, tsx, Drizzle Kit, or Playwright is
present in the deployed filesystem/SBOM. Platform-specific Sharp and libvips
packages are selected from the exact lockfile installation and remain visible
to inventory and scanning.

The Trivy gate is strict: `HIGH,CRITICAL`, `--ignore-unfixed=false`, exit code
1, and no ignore file or risk acceptance. The accepted exact-image result is
zero high and zero critical. Environment files, credentials, runtime volumes,
uploads, database dumps, and user data must never enter the image or SBOM
artifact. Release-time service-image manifest-list digest verification follows
`docs/REPOSITORY_GOVERNANCE.md`.
