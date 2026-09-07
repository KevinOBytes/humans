# Person enrichment and web research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand person entry and add a safe web-research draft/acceptance workflow.

**Architecture:** Reuse the existing people GraphQL service and optimistic person mutation. Add a small provider-neutral research adapter that consumes only public person fields and returns strict source-backed suggestions; keep drafts in the browser until explicit acceptance.

**Tech Stack:** Next.js, TypeScript, Pothos GraphQL, Drizzle, React, Vitest, existing OpenAI-compatible AI provider boundary.

**Spec:** `docs/superpowers/specs/2026-09-07-person-enrichment-research.md`

## Global Constraints

- Preserve workspace scoping, authorization, redaction, and audit behavior.
- Do not add private values, secrets, or populated environment files.
- Use TDD for behavior changes and run formatting, lint, typecheck, tests, and build before completion.
- Keep browser code out of database repositories and use generated GraphQL operations.

### Task 1: Person form enrichment

**Files:**
- Modify: `src/components/people/person-form.tsx`
- Modify: `src/components/people/person-create-form.tsx`
- Modify: `src/graphql/operations/research.graphql`
- Modify: `tests/unit/person-form.test.tsx`
- Modify: `tests/unit/person-create-form.test.tsx`

**Deliverable:** expose confidence and confidence explanation, use an explicit ACTIVE default for new records, keep all optional fields blank unless supplied, and ensure the generated create operation carries the values to GraphQL.

### Task 2: Web-research provider and GraphQL contract

**Files:**
- Create: `src/modules/people/research.ts`
- Modify: `src/modules/people/graphql.ts`
- Modify: `src/graphql/context.ts`
- Modify: `src/graphql/loaders.ts`
- Modify: `src/lib/env/server-schema.ts`
- Modify: `.env.example`
- Modify: `src/app/api/graphql/route.ts`
- Modify: `tests/unit/person-research.test.ts`
- Modify: `tests/integration/graphql-product-acceptance.test.ts`

**Deliverable:** add `personWebResearch` GraphQL query/mutation plumbing that checks `person:read`, `analysis:create`, and `analysis:run`, validates bounded public input/output, and returns source-backed suggestions without writing the person.

### Task 3: Research review UI

**Files:**
- Create: `src/components/people/person-research-panel.tsx`
- Modify: `src/app/(app)/people/[personId]/page.tsx`
- Modify: `src/graphql/operations/research.graphql`
- Modify: `tests/unit/person-research-panel.test.tsx`

**Deliverable:** add a disclosure and research action on the person page, show editable suggestions with unchecked acceptance controls and source links, apply only checked fields through the existing update mutation, and preserve drafts/errors.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`
- Modify: `README.md`

**Deliverable:** record the implemented acceptance boundary and remaining provider/runtime evidence; run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, focused tests, and `pnpm build`.
