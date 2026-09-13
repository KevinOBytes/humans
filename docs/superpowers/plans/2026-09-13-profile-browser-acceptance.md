# Rich profile browser acceptance

## Spec and scope

The expanded rich-profile contract in `docs/REQUIREMENTS.md`, especially HUM-FR-028 and HUM-NFR-009, requires usable names and timeline editors as part of the wider profile. Existing `research-core.spec.ts`, `locations.spec.ts`, and storage browser journeys already cover multiple facts, relationships, evidence, notes, contacts, addresses, files, and names/timeline reading. This tranche adds the missing authenticated name/event create-update-archive journey rather than duplicating those suites. Public identifier editing is not currently exposed by this UI and is not claimed here.

## Global Constraints

- Use Node.js 24 and pnpm 11.11.0. Preserve generated GraphQL operations, workspace authorization, redaction, consent, and mandatory audit behavior.
- Test fixtures are fictional and isolated. No hosted credentials or production writes.
- Browser code never accesses database repositories; Node-side fixture setup and verification may use existing test helpers.
- Write a browser regression before any production fix; change only the smallest UI surface exposed by the regression.
- Keep HUM-FR-028 and HUM-NFR-009 incomplete; this is bounded evidence, not whole-product acceptance.

## Task 1: Name and timeline editor browser lifecycle

Add `tests/e2e/profile-records.spec.ts` using real authenticated Next.js, GraphQL, and PostgreSQL. Create a fictional person, add multiple names and a dated event via the UI, edit and archive those records with keyboard activation, and verify persistence through generated reads. Exercise read-only workspace membership and foreign-workspace direct URL denial. Check axe and horizontal reflow on desktop, 390px mobile, and RTL with 200% CSS zoom, including long unbroken record labels. If a layout regression appears, fix only the implicated profile elements. Retain page-error assertions and meaningful exact content checks.

Run focused browser tests, relevant unit tests, formatting, lint, typecheck, full unit tests, and production build before commit. Update `TODO.md` and `docs/REQUIREMENTS.md` together with bounded evidence. Write task report under `.superpowers/sdd/2026-09-13-profile-browser-acceptance/`. Parent controller performs independent review and integration.
