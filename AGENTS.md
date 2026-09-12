# Repository guidance for coding agents

These instructions are safe for the public repository and apply to all files.

- Use Node.js 24 and the pnpm version declared in `package.json`.
- Preserve the modular-monolith boundaries described in `docs/ARCHITECTURE.md`.
- Keep browser code out of database repositories. Route application-data access through generated GraphQL operations and authorized domain services.
- Use test-driven development for behavior changes: add a focused failing test, implement the smallest passing change, then run relevant quality gates.
- Treat workspace scoping, authorization, redaction, and audit behavior as mandatory. Never weaken them to make a test pass.
- Never commit secrets, populated environment files, private data, uploads, dumps, logs, or local agent state. Add only safe placeholders to `.env.example`.
- Update `docs/REQUIREMENTS.md` and `TODO.md` together when scope or acceptance status changes. A checked requirement must have test or runtime evidence.
- Before committing, run formatting, linting, type checking, tests, and the production build appropriate to the change.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
