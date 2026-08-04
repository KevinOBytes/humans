# Humans MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the public, self-hostable Humans MVP described in `docs/superpowers/specs/2026-07-10-humans-mvp-design.md`.

**Architecture:** A modular Next.js monolith exposes a GraphQL Yoga/Pothos API over Drizzle/PostgreSQL, with Better Auth for identity, workspace-scoped domain services, Redis-backed coordination, S3-compatible storage, and an OpenAI-compatible AI boundary. The same application image runs on Vercel-managed services or in Docker Compose with PostgreSQL, Redis, MinIO, and an optional Ollama profile.

**Tech Stack:** Node.js 24 LTS, pnpm 11, Next.js 16.2, React 19.2, TypeScript, Tailwind CSS 4, Better Auth 1.6, GraphQL Yoga 5, Pothos 4, Drizzle ORM/PostgreSQL, Zod, Redis/Upstash, AWS S3 SDK, Resend, Sigma.js/Graphology, React Flow, Vercel AI SDK, Vitest, Testing Library, Playwright, and Docker Compose.

## Global Constraints

- `docs/superpowers/specs/2026-07-10-humans-mvp-design.md` is the binding product and architecture specification.
- Use Node.js `24.x` LTS and pin the package manager in `package.json`; commit the exact lockfile.
- Use current stable Next.js `16.2.x`, React `19.2.x`, Tailwind CSS `4.x`, GraphQL Yoga `5.x`, Pothos `4.x`, Better Auth `1.6.x`, and Drizzle ORM `0.45.x` releases compatible with the lockfile.
- GraphQL at `/api/graphql` is the canonical application-data API; UI code must not import Drizzle repositories.
- Better Auth owns authentication endpoints under `/api/auth/[...all]`.
- Domain IDs are application-generated UUIDv7 values stored as PostgreSQL `uuid`; every domain query is scoped by `workspace_id`.
- A person may have multiple current, historical, or contradictory facts with the same field definition.
- PostgreSQL is authoritative. Redis is never the sole copy of application data.
- The default `docker-compose.yml` must start `app`, `migrate`, `worker`, `postgres`, `redis`, `minio`, and `minio-init`; Ollama is optional by profile.
- Secrets, `.env` files, local data, uploads, dumps, agent scratch/state, and private development artifacts must never be committed.
- TOTP QR images are temporary; TOTP secrets are encrypted; backup codes and API keys are never logged and are displayed only at creation/regeneration.
- AI tools are read-only, workspace-authorized, and cannot execute generated SQL or arbitrary GraphQL.
- Every task follows test-first development, runs its focused tests, and leaves the full existing suite passing.
- Do not claim production or deployment success without a real passing build and runtime evidence.

## File and module map

```text
src/app/                         routes, layouts, auth pages, workspace UI
src/components/                  accessible shared UI, graph, forms
src/db/                          client, exhaustive Drizzle schema, migrations
src/graphql/                     Yoga route support, Pothos schema, context, loaders
src/lib/                         environment, logging, Redis, storage, email, security
src/modules/auth/                Better Auth, bootstrap, permissions
src/modules/people/              people domain service, repository, GraphQL, UI adapters
src/modules/facts/               definitions, assertions, selections, revisions
src/modules/relationships/       relationship definitions and social edges
src/modules/evidence/            sources, evidence, notes, tags
src/modules/files/               signed object operations, quarantine, metadata
src/modules/imports/             CSV/JSON mapping and durable imports
src/modules/search/              full-text documents, structured search, saved queries
src/modules/graph/               graph query, layouts, snapshots, metrics
src/modules/ai/                  compatible providers, tools, runs, citations
src/modules/audit/               redacted immutable activity records
src/modules/jobs/                durable PostgreSQL jobs and Redis leases
src/worker/                      bounded and continuous job runners
tests/unit/                      pure behavior tests
tests/integration/               PostgreSQL, Redis, MinIO, GraphQL, auth tests
tests/e2e/                       Playwright user journeys
tests/smoke/                     Docker and deployed-runtime checks
```

---

### Task 1: Application shell and quality toolchain

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `.npmrc`, `.nvmrc`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `vitest.setup.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/lib/project-meta.ts`
- Test: `tests/unit/project-meta.test.ts`, `tests/unit/home-page.test.tsx`

**Interfaces:**
- Produces: `PROJECT_META: { name: "Humans"; deploymentModes: readonly ["vercel", "docker"] }` and the shared `pnpm` scripts used by every later task.

- [ ] **Step 1: Scaffold with exact stable toolchain**

Run:

```bash
scaffold_dir="$(mktemp -d)/humans"
pnpm dlx create-next-app@16.2.10 "$scaffold_dir" --ts --tailwind --eslint --app --src-dir --import-alias '@/*' --use-pnpm --yes
rsync -a --exclude .git "$scaffold_dir/" ./
pnpm add -D vitest@4.1.10 @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event prettier prettier-plugin-tailwindcss
```

Expected: Next.js App Router files exist and the lockfile records exact resolved versions.

- [ ] **Step 2: Write failing metadata and home tests**

```ts
// tests/unit/project-meta.test.ts
import { describe, expect, it } from "vitest";
import { PROJECT_META } from "@/lib/project-meta";

describe("PROJECT_META", () => {
  it("declares both supported deployment modes", () => {
    expect(PROJECT_META).toEqual({
      name: "Humans",
      deploymentModes: ["vercel", "docker"],
    });
  });
});
```

```tsx
// tests/unit/home-page.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("home page", () => {
  it("identifies the product and its purpose", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Humans" })).toBeVisible();
    expect(screen.getByText(/evidence-backed social networks/i)).toBeVisible();
  });
});
```

- [ ] **Step 3: Verify the tests fail for missing product behavior**

Run: `pnpm vitest run tests/unit/project-meta.test.ts tests/unit/home-page.test.tsx`

Expected: FAIL because `PROJECT_META` does not exist and the scaffolded page lacks the required content.

- [ ] **Step 4: Implement the product shell and scripts**

```ts
// src/lib/project-meta.ts
export const PROJECT_META = {
  name: "Humans",
  deploymentModes: ["vercel", "docker"],
} as const;
```

Replace the scaffold page with a semantic landing page containing the tested heading and purpose copy. Add scripts named `dev`, `build`, `start`, `lint`, `typecheck`, `format:check`, `test`, `test:unit`, `test:integration`, `test:e2e`, `db:generate`, `db:migrate`, `db:check`, `codegen`, and `validate`.

- [ ] **Step 5: Verify the shell**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck && pnpm build`

Expected: all commands exit 0 and both tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .npmrc .nvmrc tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs vitest.config.ts vitest.setup.ts src tests/unit
git commit -m "feat: scaffold Humans application"
```

### Task 2: Public repository contract, environment validation, and documentation

**Files:**
- Create: `.gitignore`, `.dockerignore`, `.env.example`, `LICENSE`, `README.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `TODO.md`
- Create: `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS.md`, `docs/DESIGN.md`
- Create: `src/lib/env/server.ts`, `src/lib/env/client.ts`
- Test: `tests/unit/env.test.ts`, `tests/unit/repository-contract.test.ts`

**Interfaces:**
- Produces: `getServerEnv(source?: NodeJS.ProcessEnv): ServerEnv` and numbered requirements `HUM-FR-*`, `HUM-NFR-*` used by tests and `TODO.md`.

- [ ] **Step 1: Write failing repository and environment tests**

```ts
// tests/unit/env.test.ts
import { describe, expect, it } from "vitest";
import { getServerEnv } from "@/lib/env/server";

describe("getServerEnv", () => {
  it("rejects placeholder production secrets", () => {
    expect(() => getServerEnv({ NODE_ENV: "production", AUTH_SECRET: "change-me" })).toThrow(/AUTH_SECRET/);
  });
});
```

```ts
// tests/unit/repository-contract.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public repository contract", () => {
  it("ignores secrets and agent scratch state", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    for (const entry of [".env", ".superpowers/", ".codex/", ".claude/"]) expect(ignore).toContain(entry);
  });
});
```

- [ ] **Step 2: Run tests and observe failure**

Run: `pnpm vitest run tests/unit/env.test.ts tests/unit/repository-contract.test.ts`

Expected: FAIL because environment modules and repository files do not exist.

- [ ] **Step 3: Implement typed environment and complete public docs**

Use Zod to define a discriminated deployment contract with required database, Redis, storage, auth, admin, Resend, and AI variables. `.env.example` contains safe non-secret examples only. `docs/REQUIREMENTS.md` converts every approved spec behavior into numbered, verifiable requirements; root `TODO.md` has one requirement-linked checkbox for every incomplete production item and no untracked MVP gap.

```ts
// src/lib/env/client.ts
import { z } from "zod";

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
});
```

- [ ] **Step 4: Verify docs and validation**

Run: `pnpm vitest run tests/unit/env.test.ts tests/unit/repository-contract.test.ts && pnpm typecheck && git check-ignore .env .superpowers/probe .codex/probe .claude/probe`

Expected: tests pass and every probe is reported as ignored.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .dockerignore .env.example LICENSE README.md AGENTS.md SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md TODO.md docs src/lib/env tests/unit
git commit -m "docs: define public repository contract"
```

### Task 3: Infrastructure adapters and Docker Compose parity

**Files:**
- Create: `src/lib/redis/types.ts`, `src/lib/redis/index.ts`, `src/lib/storage/types.ts`, `src/lib/storage/s3.ts`, `src/lib/email/resend.ts`
- Create: `Dockerfile`, `docker/entrypoint.sh`, `docker/minio-init.sh`, `docker-compose.yml`, `docker-compose.test.yml`, `docker-compose.ollama.yml`
- Create: `src/app/api/health/live/route.ts`, `src/app/api/health/ready/route.ts`
- Test: `tests/unit/infrastructure-config.test.ts`, `tests/integration/health.test.ts`

**Interfaces:**
- Produces: `RedisStore`, `ObjectStore`, `EmailSender`, `createRedisStore(env)`, `createObjectStore(env)`, `GET /api/health/live`, and `GET /api/health/ready`.

- [ ] **Step 1: Write failing adapter and health tests**

```ts
// tests/unit/infrastructure-config.test.ts
import { describe, expect, it } from "vitest";
import { objectStoreConfig } from "@/lib/storage/s3";

describe("objectStoreConfig", () => {
  it("uses path-style access for MinIO", () => {
    expect(objectStoreConfig({ endpoint: "http://minio:9000", provider: "minio" }).forcePathStyle).toBe(true);
  });
});
```

```ts
// tests/integration/health.test.ts
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/live/route";

describe("liveness", () => {
  it("returns a non-secret status", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ status: "ok", service: "humans" });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/infrastructure-config.test.ts tests/integration/health.test.ts`

Expected: FAIL because the adapter and health modules do not exist.

- [ ] **Step 3: Implement adapters and Compose services**

`RedisStore` exposes `get`, `set`, `delete`, `increment`, and lease methods. `ObjectStore` exposes signed upload/download, metadata, delete, and existence methods. Compose must include health checks, authenticated persistent PostgreSQL/Redis/MinIO, idempotent bucket creation, health-gated migration/application startup, a worker command, and no default host publication for PostgreSQL or Redis.

```ts
// src/lib/storage/types.ts
export interface ObjectStore {
  createUpload(input: { workspaceId: string; key: string; contentType: string; bytes: number }): Promise<{ url: string; expiresAt: Date }>;
  createDownload(input: { key: string; fileName: string }): Promise<{ url: string; expiresAt: Date }>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
```

- [ ] **Step 4: Verify configuration and focused tests**

Run: `pnpm vitest run tests/unit/infrastructure-config.test.ts tests/integration/health.test.ts && docker compose config --quiet && docker compose -f docker-compose.yml -f docker-compose.test.yml config --quiet && docker build -t humans:test .`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/redis src/lib/storage src/lib/email src/app/api/health Dockerfile docker docker-compose.yml docker-compose.test.yml docker-compose.ollama.yml tests
git commit -m "feat: add portable infrastructure adapters"
```

### Task 4: Drizzle core identity, people, and fact schema

**Files:**
- Create: `drizzle.config.ts`, `src/db/client.ts`, `src/db/schema/enums.ts`, `src/db/schema/auth.ts`, `src/db/schema/workspaces.ts`, `src/db/schema/people.ts`, `src/db/schema/facts.ts`, `src/db/schema/index.ts`
- Create: `src/db/id.ts`, `src/db/migrate.ts`, `drizzle/0000_core.sql`
- Test: `tests/unit/id.test.ts`, `tests/integration/core-schema.test.ts`

**Interfaces:**
- Produces: `newId(): string`, `db`, Better Auth tables, workspace policy tables, `people`, `personNames`, `personIdentifiers`, `personEvents`, `personFieldSelections`, `factDefinitions`, `facts`, `factRevisions`, `factRelationships`, and fact association tables.

- [ ] **Step 1: Write failing ID and schema tests**

```ts
// tests/unit/id.test.ts
import { describe, expect, it } from "vitest";
import { newId } from "@/db/id";

describe("newId", () => {
  it("creates time-sortable UUIDv7 identifiers", () => {
    const first = newId();
    const second = newId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.localeCompare(second)).toBeLessThanOrEqual(0);
  });
});
```

```ts
// tests/integration/core-schema.test.ts
import { describe, expect, it } from "vitest";
import { facts, people } from "@/db/schema";

describe("core schema", () => {
  it("requires facts to reference people and workspaces", () => {
    expect(facts.personId.notNull).toBe(true);
    expect(facts.workspaceId.notNull).toBe(true);
    expect(people.workspaceId.notNull).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/id.test.ts tests/integration/core-schema.test.ts`

Expected: FAIL because the database modules do not exist.

- [ ] **Step 3: Implement the approved schema exactly**

Use PostgreSQL UUIDs for domain tables, Better Auth-compatible strings for auth tables, composite workspace indexes, confidence checks, typed sparse fact values with a type/value check, temporal precision, optimistic versions, soft deletion, and no uniqueness constraint on `(person_id, field_key)`.

```ts
// src/db/id.ts
import { uuidv7 } from "uuidv7";

export const newId = (): string => uuidv7();
```

- [ ] **Step 4: Generate and validate migration**

Run: `pnpm db:generate && pnpm vitest run tests/unit/id.test.ts tests/integration/core-schema.test.ts && pnpm db:check`

Expected: tests pass, migration is deterministic, and schema check exits 0.

- [ ] **Step 5: Commit**

```bash
git add drizzle.config.ts drizzle src/db tests/unit/id.test.ts tests/integration/core-schema.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add people and facts schema"
```

### Task 5: Complete evidence, graph, file, AI, and operations schema

**Files:**
- Create: `src/db/schema/locations.ts`, `relationships.ts`, `evidence.ts`, `files.ts`, `search.ts`, `graph.ts`, `ai.ts`, `operations.ts`
- Modify: `src/db/schema/index.ts`, `drizzle/0000_core.sql`
- Create: `src/db/seed.ts`
- Test: `tests/integration/full-schema.test.ts`, `tests/integration/workspace-constraints.test.ts`

**Interfaces:**
- Produces every table named in design sections 6.4 through 6.10 and a deterministic development/test seed.

- [ ] **Step 1: Write failing full-schema test**

```ts
// tests/integration/full-schema.test.ts
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";

describe("approved schema surface", () => {
  it("exports every MVP aggregate root", () => {
    for (const name of ["relationships", "sources", "evidenceItems", "files", "imports", "searchDocuments", "graphViews", "aiRuns", "jobs", "auditEvents"]) {
      expect(schema).toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/integration/full-schema.test.ts tests/integration/workspace-constraints.test.ts`

Expected: FAIL for missing exports and constraints.

- [ ] **Step 3: Implement remaining approved tables and seed**

Match the design names, ownership, temporal fields, sensitivity, evidence associations, file quarantine state, durable jobs, redacted audit events, AI citations, and workspace-scoped indexes. The seed creates two workspaces with deliberately overlapping names for tenant-isolation tests.

- [ ] **Step 4: Validate schema against PostgreSQL**

Run: `docker compose up -d postgres && pnpm db:migrate && pnpm db:seed && pnpm vitest run tests/integration/full-schema.test.ts tests/integration/workspace-constraints.test.ts`

Expected: migration and seed succeed; tests prove cross-workspace foreign references are rejected by services or constraints.

- [ ] **Step 5: Commit**

```bash
git add src/db drizzle tests/integration package.json pnpm-lock.yaml
git commit -m "feat: complete research data schema"
```

### Task 6: Better Auth, workspace collaboration, and administrator bootstrap

**Files:**
- Create: `src/modules/auth/auth.ts`, `auth-client.ts`, `permissions.ts`, `bootstrap-admin.ts`, `crypto.ts`
- Create: `src/app/api/auth/[...all]/route.ts`, `src/proxy.ts`
- Create: `src/app/(auth)/sign-in/page.tsx`, `sign-up/page.tsx`, `two-factor/page.tsx`
- Create: `tests/support/auth.ts`
- Test: `tests/unit/permissions.test.ts`, `tests/integration/admin-bootstrap.test.ts`, `tests/integration/auth-security.test.ts`

**Interfaces:**
- Produces: `auth`, `authClient`, `authorize(role, resource, action)`, `bootstrapAdmin(db, env)`, and verified Better Auth routes/plugins for username, 2FA, admin, organization, and organization-owned API keys.

- [ ] **Step 1: Write failing permission and bootstrap tests**

```ts
// tests/unit/permissions.test.ts
import { describe, expect, it } from "vitest";
import { authorize } from "@/modules/auth/permissions";

describe("workspace permissions", () => {
  it("allows contributors to create facts but not manage members", () => {
    expect(authorize("contributor", "fact", "create")).toBe(true);
    expect(authorize("contributor", "member", "invite")).toBe(false);
  });
});
```

```ts
// tests/integration/admin-bootstrap.test.ts
import { describe, expect, it } from "vitest";
import { bootstrapAdmin } from "@/modules/auth/bootstrap-admin";
import { testAdminEnv, testDb } from "../support/auth";

describe("administrator bootstrap", () => {
  it("is idempotent and never returns the plaintext password", async () => {
    const first = await bootstrapAdmin(testDb, testAdminEnv);
    const second = await bootstrapAdmin(testDb, testAdminEnv);
    expect(first.userId).toBe(second.userId);
    expect(JSON.stringify(first)).not.toContain(testAdminEnv.ADMIN_PASSWORD);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/permissions.test.ts tests/integration/admin-bootstrap.test.ts tests/integration/auth-security.test.ts`

Expected: FAIL because auth modules do not exist.

- [ ] **Step 3: Implement auth plugins and flows**

Use the Better Auth Drizzle adapter and official Next.js handler. Encrypt TOTP material with `AUTH_ENCRYPTION_KEY`, use Resend for verification/reset/invitation mail, require verified invitation email, hash organization API keys, expose raw keys once, and make `nextCookies()` the last plugin. `src/proxy.ts` performs optimistic routing only; every protected page/API validates the session server-side.

- [ ] **Step 4: Verify auth behavior**

Run: `pnpm vitest run tests/unit/permissions.test.ts tests/integration/admin-bootstrap.test.ts tests/integration/auth-security.test.ts && pnpm typecheck`

Expected: all tests pass, including TOTP/backup-code redaction and organization membership checks.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth src/app/api/auth src/app/'(auth)' src/proxy.ts tests package.json pnpm-lock.yaml
git commit -m "feat: add secure workspace authentication"
```

### Task 7: GraphQL foundation, authentication context, and tenant isolation

**Files:**
- Create: `src/graphql/builder.ts`, `context.ts`, `errors.ts`, `limits.ts`, `loaders.ts`, `schema.ts`
- Create: `src/app/api/graphql/route.ts`
- Create: `codegen.ts`, `src/graphql/generated/.gitkeep`
- Create: `tests/support/graphql.ts`
- Test: `tests/integration/graphql-context.test.ts`, `tests/integration/graphql-limits.test.ts`, `tests/integration/tenant-isolation.test.ts`

**Interfaces:**
- Produces: `GraphQLContext`, `createContext(request)`, `builder`, `schema`, `requirePermission(ctx, resource, action)`, stable error codes, and generated typed documents.

- [ ] **Step 1: Write failing context and isolation tests**

```ts
// tests/integration/graphql-context.test.ts
import { describe, expect, it } from "vitest";
import { executeTestOperation } from "../support/graphql";

describe("GraphQL context", () => {
  it("rejects unauthenticated viewer queries", async () => {
    const result = await executeTestOperation({ query: "query { viewer { id } }" });
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/integration/graphql-context.test.ts tests/integration/graphql-limits.test.ts tests/integration/tenant-isolation.test.ts`

Expected: FAIL because the GraphQL route and test executor do not exist.

- [ ] **Step 3: Implement Yoga/Pothos and request defenses**

Resolve exactly one browser-session or API-key actor, require an active workspace, attach scoped loaders/services, return correlation IDs, and configure depth, aliases, complexity, request size, and pagination limits. Never accept `workspaceId` as authority without verifying membership.

```ts
// src/graphql/context.ts
export interface GraphQLContext {
  requestId: string;
  actor: { type: "user" | "apiKey"; id: string };
  workspaceId: string;
  permissions: ReadonlySet<string>;
}
```

- [ ] **Step 4: Verify GraphQL safety**

Run: `pnpm codegen && pnpm vitest run tests/integration/graphql-context.test.ts tests/integration/graphql-limits.test.ts tests/integration/tenant-isolation.test.ts`

Expected: unauthenticated, over-complex, and cross-workspace operations are rejected with stable codes.

- [ ] **Step 5: Commit**

```bash
git add src/graphql src/app/api/graphql codegen.ts tests package.json pnpm-lock.yaml
git commit -m "feat: establish tenant-safe GraphQL API"
```

### Task 8: People, facts, relationships, evidence, and audit API

**Files:**
- Create: `src/modules/people/{repository,service,graphql}.ts`
- Create: `src/modules/facts/{repository,service,validation,graphql}.ts`
- Create: `src/modules/relationships/{repository,service,graphql}.ts`
- Create: `src/modules/evidence/{repository,service,graphql}.ts`
- Create: `src/modules/audit/{service,redaction}.ts`
- Modify: `src/graphql/schema.ts`
- Create: `tests/support/research-fixture.ts`
- Test: `tests/unit/fact-validation.test.ts`, `tests/integration/research-api.test.ts`, `tests/integration/research-authorization.test.ts`

**Interfaces:**
- Produces cursor queries and mutations named in design section 7, including `createPerson`, `createFact`, `reviseFact`, `selectPersonField`, `createRelationship`, and evidence/note/tag operations.

- [ ] **Step 1: Write failing multiple-fact and authorization tests**

```ts
// tests/integration/research-api.test.ts
import { describe, expect, it } from "vitest";
import { researchFixture } from "../support/research-fixture";

describe("research API", () => {
  it("retains contradictory facts for one person", async () => {
    const result = await researchFixture.createContradictoryBirthFacts();
    expect(result.person.facts.nodes).toHaveLength(2);
    expect(result.person.facts.nodes.map((fact) => fact.status)).toEqual(expect.arrayContaining(["ASSERTED", "DISPUTED"]));
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/fact-validation.test.ts tests/integration/research-api.test.ts tests/integration/research-authorization.test.ts`

Expected: FAIL because the domain services and GraphQL fields do not exist.

- [ ] **Step 3: Implement domain services and resolvers**

Repositories require `workspaceId` in every public method. Services validate definitions/value types, temporal precision, confidence, optimistic versions, sensitivity policies, and same-workspace references. Every mutation writes a redacted audit event in the same transaction.

- [ ] **Step 4: Verify research API**

Run: `pnpm codegen && pnpm vitest run tests/unit/fact-validation.test.ts tests/integration/research-api.test.ts tests/integration/research-authorization.test.ts`

Expected: tests pass and prove multiple same-key facts, revision history, field selection, relationship evidence, and role enforcement.

- [ ] **Step 5: Commit**

```bash
git add src/modules src/graphql/schema.ts tests
git commit -m "feat: add evidence-backed research API"
```

### Task 9: Authenticated workspace and research user interface

**Files:**
- Create: `src/app/(app)/layout.tsx`, `dashboard/page.tsx`, `people/page.tsx`, `people/new/page.tsx`, `people/[personId]/page.tsx`
- Create: `src/components/app-shell.tsx`, `workspace-switcher.tsx`, `people/people-table.tsx`, `people/person-form.tsx`, `people/person-profile.tsx`, `facts/fact-form.tsx`, `relationships/relationship-form.tsx`
- Create: `src/graphql/operations/research.graphql`
- Create: `tests/fixtures/person.ts`
- Test: `tests/unit/person-profile.test.tsx`, `tests/e2e/research-core.spec.ts`

**Interfaces:**
- Consumes: generated GraphQL operations and Better Auth session/workspace APIs.
- Produces: accessible dashboard, people list/create/profile, fact history/selection, relationship, evidence, notes, tags, and activity views.

- [ ] **Step 1: Write failing profile component test**

```tsx
// tests/unit/person-profile.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PersonProfile } from "@/components/people/person-profile";
import { personWithContradictoryFacts } from "../fixtures/person";

describe("PersonProfile", () => {
  it("shows contradictory facts without collapsing them", () => {
    render(<PersonProfile person={personWithContradictoryFacts} />);
    expect(screen.getAllByText("Date of birth")).toHaveLength(2);
    expect(screen.getByText("Disputed")).toBeVisible();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/person-profile.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement accessible API-backed UI**

Use generated GraphQL documents for all application data. Validate sessions server-side for protected layouts. Provide overview, names, facts, relationships, timeline, evidence, files, notes, and activity tabs. Preserve keyboard access, focus visibility, semantic labels, reduced motion, and narrow-screen record review.

- [ ] **Step 4: Verify UI behavior**

Run: `pnpm vitest run tests/unit/person-profile.test.tsx && pnpm test:e2e --grep "research core"`

Expected: component and browser journeys pass from sign-in through creating a person, two facts, and a relationship.

- [ ] **Step 5: Commit**

```bash
git add src/app/'(app)' src/components src/graphql/operations tests
git commit -m "feat: add research workspace interface"
```

### Task 10: Social graph query and visualization

**Files:**
- Create: `src/modules/graph/{service,graphql,transform,metrics}.ts`
- Create: `src/components/graph/graph-explorer.tsx`, `graph-inspector.tsx`, `graph-table.tsx`, `relationship-editor.tsx`
- Create: `src/app/(app)/graph/page.tsx`, `src/graphql/operations/graph.graphql`
- Create: `tests/fixtures/graph.ts`
- Test: `tests/unit/graph-transform.test.ts`, `tests/unit/graph-accessibility.test.tsx`, `tests/e2e/graph.spec.ts`

**Interfaces:**
- Produces: `graph(filter): GraphResult`, saved views, snapshots, metrics, Sigma/Graphology explorer, React Flow neighborhood editor, and a tabular equivalent.

- [ ] **Step 1: Write failing transform test**

```ts
// tests/unit/graph-transform.test.ts
import { describe, expect, it } from "vitest";
import { toGraphologyData } from "@/modules/graph/transform";
import { twoPersonGraphResult } from "../fixtures/graph";

describe("toGraphologyData", () => {
  it("preserves person and relationship UUIDs", () => {
    const graph = toGraphologyData(twoPersonGraphResult);
    expect(graph.nodes.map((node) => node.key)).toEqual(["person-a", "person-b"]);
    expect(graph.edges[0]?.attributes.relationshipId).toBe("relationship-a-b");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/graph-transform.test.ts tests/unit/graph-accessibility.test.tsx`

Expected: FAIL because graph modules do not exist.

- [ ] **Step 3: Implement graph API and UI**

Add bounded workspace-safe graph queries, temporal filters, type/sensitivity filters, saved layouts, path highlighting, selection inspector, metrics, and UUID-preserving transformations. Render large graphs with Sigma/Graphology and edit a selected neighborhood with React Flow. Provide a keyboard-operable table containing the same nodes and edges.

- [ ] **Step 4: Verify graph behavior**

Run: `pnpm vitest run tests/unit/graph-transform.test.ts tests/unit/graph-accessibility.test.tsx && pnpm test:e2e --grep "graph"`

Expected: transform, accessible fallback, filtering, saved view, and editor journeys pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/graph src/components/graph src/app/'(app)'/graph src/graphql/operations tests package.json pnpm-lock.yaml
git commit -m "feat: add interactive social graph"
```

### Task 11: Evidence files, S3-compatible uploads, and imports

**Files:**
- Create: `src/modules/files/{service,graphql,validation}.ts`, `src/modules/imports/{service,parser,mapper,graphql}.ts`
- Create: `src/app/(app)/evidence/page.tsx`, `imports/page.tsx`
- Create: `src/components/files/upload-panel.tsx`, `src/components/imports/import-wizard.tsx`
- Test: `tests/unit/file-validation.test.ts`, `tests/unit/import-mapper.test.ts`, `tests/integration/minio-upload.test.ts`, `tests/e2e/import.spec.ts`

**Interfaces:**
- Produces: `createUploadSession`, `completeUpload`, signed downloads, quarantine state, CSV/JSON preview/mapping, idempotent `startImport`, and row-level errors.

- [ ] **Step 1: Write failing file and import tests**

```ts
// tests/unit/file-validation.test.ts
import { describe, expect, it } from "vitest";
import { validateUpload } from "@/modules/files/validation";

describe("validateUpload", () => {
  it("rejects executable content disguised as an image", () => {
    expect(() => validateUpload({ claimedType: "image/png", detectedType: "application/x-executable", bytes: 128 })).toThrow(/type/i);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/file-validation.test.ts tests/unit/import-mapper.test.ts tests/integration/minio-upload.test.ts`

Expected: FAIL because upload/import modules do not exist.

- [ ] **Step 3: Implement portable evidence ingestion**

Server code chooses object keys, validates size/type/checksum/workspace, leaves files quarantined until policy succeeds, and never trusts client completion metadata. Import mappings create people/facts/relationships through domain services, use deterministic row idempotency keys, and preserve validation errors without partial-row success.

- [ ] **Step 4: Verify MinIO and import journey**

Run: `docker compose up -d postgres redis minio minio-init && pnpm vitest run tests/unit/file-validation.test.ts tests/unit/import-mapper.test.ts tests/integration/minio-upload.test.ts && pnpm test:e2e --grep "import"`

Expected: signed upload/download, quarantine, mapping preview, retry, and row error tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/files src/modules/imports src/app/'(app)' src/components/files src/components/imports tests
git commit -m "feat: add evidence uploads and imports"
```

### Task 12: Search, saved queries, and reproducible graph analysis

**Files:**
- Create: `src/modules/search/{service,indexer,graphql}.ts`, `src/modules/graph/analysis.ts`
- Create: `src/app/(app)/search/page.tsx`, `src/components/search/search-workbench.tsx`
- Create: `tests/support/search-fixture.ts`
- Test: `tests/integration/search.test.ts`, `tests/unit/analysis.test.ts`, `tests/e2e/search.spec.ts`

**Interfaces:**
- Produces: structured/full-text `search`, `savedQueries`, query runs, optional embedding metadata, graph snapshots, analysis runs/results, and person metrics.

- [ ] **Step 1: Write failing search isolation test**

```ts
// tests/integration/search.test.ts
import { describe, expect, it } from "vitest";
import { searchFixture } from "../support/search-fixture";

describe("workspace search", () => {
  it("does not return another workspace's matching person", async () => {
    const result = await searchFixture.searchAsWorkspaceA("Shared Name");
    expect(result.map((item) => item.workspaceId)).toEqual([searchFixture.workspaceA]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/integration/search.test.ts tests/unit/analysis.test.ts`

Expected: FAIL because search and analysis services do not exist.

- [ ] **Step 3: Implement indexed search and reproducible analysis**

Build redacted `tsvector` documents transactionally from authorized resources. Structured filters remain typed. Embeddings are optional records keyed by source/configuration hash. Graph analyses persist the exact resource versions, algorithm, configuration, results, and ranks needed for reproduction.

- [ ] **Step 4: Verify search and saved-query UX**

Run: `pnpm vitest run tests/integration/search.test.ts tests/unit/analysis.test.ts && pnpm test:e2e --grep "search"`

Expected: full-text, structured filters, saved queries, tenant isolation, and deterministic metrics pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/search src/modules/graph src/app/'(app)'/search src/components/search tests
git commit -m "feat: add research search and analysis"
```

### Task 13: Durable jobs and cited OpenAI-compatible analysis

**Files:**
- Create: `src/modules/jobs/{repository,service,lease}.ts`, `src/worker/{run-once,run-continuous}.ts`
- Create: `src/modules/ai/{provider,tools,service,graphql}.ts`
- Create: `src/app/api/jobs/run/route.ts`, `src/app/(app)/analyst/page.tsx`, `src/components/ai/analyst.tsx`
- Create: `tests/fixtures/ai-context.ts`
- Test: `tests/unit/ai-provider.test.ts`, `tests/unit/ai-tools.test.ts`, `tests/integration/jobs.test.ts`, `tests/integration/ai-analysis.test.ts`, `tests/e2e/analyst.spec.ts`

**Interfaces:**
- Produces: `enqueueJob`, Redis-leased job execution, `startAnalysis`, `aiRun`, provider capability errors, restricted read-only tools, and cited results.

- [ ] **Step 1: Write failing AI safety test**

```ts
// tests/unit/ai-tools.test.ts
import { describe, expect, it } from "vitest";
import { createResearchTools } from "@/modules/ai/tools";
import { viewerContext } from "../fixtures/ai-context";

describe("AI research tools", () => {
  it("exports only authorized read operations", () => {
    expect(Object.keys(createResearchTools(viewerContext)).sort()).toEqual(["getEvidence", "getPerson", "searchGraph", "searchPeople"]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/ai-provider.test.ts tests/unit/ai-tools.test.ts tests/integration/jobs.test.ts tests/integration/ai-analysis.test.ts`

Expected: FAIL because job and AI modules do not exist.

- [ ] **Step 3: Implement durable execution and compatible providers**

Persist jobs before execution, lease through Redis, retry with bounded exponential backoff, and dead-letter exhausted work. Configure the Vercel AI SDK OpenAI provider or OpenAI-compatible provider from validated environment. Ollama uses its `/v1` endpoint. Models never receive SQL/GraphQL execution tools. The deterministic fake provider must produce a cited answer for tests.

- [ ] **Step 4: Verify provider, job, and analyst behavior**

Run: `pnpm vitest run tests/unit/ai-provider.test.ts tests/unit/ai-tools.test.ts tests/integration/jobs.test.ts tests/integration/ai-analysis.test.ts && pnpm test:e2e --grep "analyst"`

Expected: tests pass for OpenAI/Ollama selection, missing capabilities, lease exclusivity, retries, citations, and UI polling.

- [ ] **Step 5: Commit**

```bash
git add src/modules/jobs src/modules/ai src/worker src/app/api/jobs src/app/'(app)'/analyst src/components/ai tests package.json pnpm-lock.yaml
git commit -m "feat: add cited AI analysis"
```

### Task 14: Workspace administration, invitations, API keys, and policies UI

**Files:**
- Create: `src/app/(app)/settings/{members,api-keys,policies,audit,integrations}/page.tsx`
- Create: `src/components/settings/member-settings.tsx`, `api-key-settings.tsx`, `policy-settings.tsx`, `integration-diagnostics.tsx`
- Create: `src/graphql/operations/settings.graphql`
- Test: `tests/unit/api-key-settings.test.tsx`, `tests/integration/invitations.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Produces: email invitation/role/member flows, one-time API-key creation, revocation/expiry/scopes, record policy management, audit browsing, and non-secret integration diagnostics.

- [ ] **Step 1: Write failing one-time-key display test**

```tsx
// tests/unit/api-key-settings.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiKeyCreatedDialog } from "@/components/settings/api-key-settings";

describe("ApiKeyCreatedDialog", () => {
  it("warns that the raw key is displayed once", () => {
    render(<ApiKeyCreatedDialog rawKey="humans_test_secret" onClose={() => undefined} />);
    expect(screen.getByText(/will not be shown again/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run tests/unit/api-key-settings.test.tsx tests/integration/invitations.test.ts`

Expected: FAIL because settings UI and invitation integration do not exist.

- [ ] **Step 3: Implement settings through authenticated APIs**

Use Better Auth organization/admin/API-key server APIs and GraphQL policy/audit APIs. Never persist raw API keys in client storage. Require reauthentication for security-sensitive operations. Resend invitation messages contain opaque, expiring links and require the matching verified email.

- [ ] **Step 4: Verify collaboration flow**

Run: `pnpm vitest run tests/unit/api-key-settings.test.tsx tests/integration/invitations.test.ts && pnpm test:e2e --grep "settings"`

Expected: invitation acceptance, role enforcement, API-key lifecycle, policies, and audit browsing pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/'(app)'/settings src/components/settings src/graphql/operations tests
git commit -m "feat: add workspace administration"
```

### Task 15: End-to-end hardening, Compose smoke, CI, and requirement closeout

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/mvp.spec.ts`, `tests/smoke/compose-smoke.mjs`
- Create: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `vercel.json`
- Modify: `docker-compose.test.yml`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS.md`, `docs/DESIGN.md`, `TODO.md`, `SECURITY.md`
- Test: entire repository

**Interfaces:**
- Produces: one verified MVP acceptance matrix, public contribution workflow, container smoke check, and production-ready documentation without unverified deployment claims.

- [ ] **Step 1: Write the failing MVP journey and Compose smoke**

```ts
// tests/e2e/mvp.spec.ts
import { expect, test } from "@playwright/test";

test("owner completes the evidence-backed graph and AI journey", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email or username").fill(process.env.E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("link", { name: "People" }).click();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
});
```

`tests/smoke/compose-smoke.mjs` must wait for readiness, execute an authenticated GraphQL viewer query, upload/download a checksum-verified MinIO object through signed URLs, and exit nonzero on any mismatch.

- [ ] **Step 2: Run acceptance checks and record failures**

Run: `pnpm validate && pnpm test:e2e && docker compose -f docker-compose.yml -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from smoke`

Expected: initial failures expose any remaining integration, accessibility, migration, or Compose gaps.

- [ ] **Step 3: Close every MVP requirement with evidence**

Fix the failures without narrowing tests. Add CI jobs for formatting, lint, typecheck, unit/integration tests with real services, migration/codegen drift, production build, Docker build/smoke, dependency review, and secret scanning. Configure `vercel.json` with the bounded protected job invocation and no unsupported persistent worker assumptions. Update each `docs/REQUIREMENTS.md` item with its test or runtime evidence and check only completed MVP lines in `TODO.md`; remaining lines must be explicitly post-MVP.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm test:e2e
docker compose config --quiet
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from smoke
git diff --exit-code -- drizzle src/graphql/generated
```

Expected: every command exits 0, Compose services become healthy, the smoke container passes, and generated artifacts are clean.

- [ ] **Step 5: Commit**

```bash
git add .github playwright.config.ts vercel.json docker-compose.test.yml tests README.md docs TODO.md SECURITY.md
git commit -m "test: verify Humans MVP end to end"
```

### Task 16: Public repository, pull request, merge, and deployment evidence

**Files:**
- Modify only when required by final review findings or verified deployment configuration.

**Interfaces:**
- Consumes: the reviewed branch and complete verification report.
- Produces: public GitHub repository, merged/closed PR, updated local `main`, and explicit Vercel/self-host deployment status.

- [ ] **Step 1: Run final whole-branch review**

Generate a review package from the branch merge base through `HEAD`, dispatch the required final reviewer, fix all Critical/Important findings in one fix wave, rerun covering tests, and re-review until approved.

- [ ] **Step 2: Re-run release gates**

Run: `pnpm validate && pnpm test:e2e && docker compose -f docker-compose.yml -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from smoke`

Expected: all release gates exit 0 on the final reviewed commit.

- [ ] **Step 3: Publish and merge through GitHub**

Run the authenticated equivalents of:

```bash
gh repo create humans --public --source=. --remote=origin --push
gh pr create --base main --head feat/humans-mvp --title "feat: launch Humans MVP" --body-file .superpowers/sdd/pr-body.md
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Expected: repository visibility is public, required checks pass, the PR is merged and closed, and remote branch cleanup succeeds. If the authenticated GitHub owner requires a qualified name, use the current `gh api user --jq .login` value rather than guessing.

- [ ] **Step 4: Verify main and deployments**

Fetch `origin/main`, verify the merge SHA contains the reviewed tree, verify the Vercel project/domain only when credentials and DNS are available, and run the documented Docker self-host smoke from the merged commit. Report unavailable external credentials as an explicit outstanding production dependency rather than claiming success.

- [ ] **Step 5: Record durable completion**

Update `~/TODO.md` and `~/DIDIT.md` under their concurrency protocol with the real merge SHA, repository URL, and verified deployment handles. Do not check off Vercel/domain work unless live evidence exists.
