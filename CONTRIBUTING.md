# Contributing to Humans

Thank you for helping build Humans. This project handles potentially sensitive research records, so correctness, privacy, and auditable behavior take priority over speed.

## Development setup

1. Install Node.js 24 and enable Corepack.
2. Run `pnpm install --frozen-lockfile`.
3. Copy `.env.example` to `.env.local` and replace placeholders locally. Never commit that file.
4. Run `pnpm dev` for the current application shell.

## Change workflow

1. Choose one or more IDs from [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
2. Add a focused failing test for each behavior change and confirm the expected failure.
3. Implement the smallest safe change, preserving authorization, workspace scope, redaction, and audit behavior.
4. Update documentation and [TODO.md](TODO.md) with evidence-backed status only.
5. Run `pnpm validate` before requesting review. Also run `pnpm deps:licenses`, `pnpm deps:audit`, and the relevant generated-drift, PostgreSQL, Compose, or supply-chain checks for the affected area.

Pull requests should explain the requirement IDs, tests, migration impact, security/privacy impact, documentation changes, and deployment notes. Keep generated schemas and migrations in the same review as the source change that produces them.

The pull-request template also requires operations and rollback evidence. Review
[Repository governance](docs/REPOSITORY_GOVERNANCE.md) and
[Dependency policy](docs/DEPENDENCY_POLICY.md) before changing workflows,
actions, dependencies, container images, or release controls. Never replace an
immutable action pin with a moving tag.

## Commit and review guidelines

- Keep commits focused and use imperative commit messages.
- Do not mix unrelated refactors with feature or security changes.
- Use synthetic data in examples and tests.
- Treat review comments about tenant isolation, authentication, file handling, and secret management as release blockers until resolved.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues through [SECURITY.md](SECURITY.md), not a public issue.
