# Humans MVP Design

**Date:** 2026-07-10  
**Status:** Approved direction, pending implementation-plan review  
**Product:** Humans, an open-source, workspace-scoped social-network research platform

## 1. Product outcome

Humans lets researchers create structured records about people, attach any number of evidence-backed facts to each person, connect people through temporal relationships, explore the resulting social graph, upload supporting material, query all application data through GraphQL, and ask an OpenAI-compatible language model to perform cited analysis.

The MVP is complete when a new operator can deploy the same application in either of these modes:

1. Vercel with Neon PostgreSQL, Upstash Redis, Cloudflare R2 or another S3-compatible store, and OpenAI or another compatible endpoint.
2. Docker Compose with the application, PostgreSQL, Redis, MinIO, a bucket-initialization service, and an optional Ollama profile.

The source repository is public, licensed under Apache-2.0, documented for contributors, protected by CI, and contains no committed secrets or private agent state.

## 2. Scope and delivery

The implementation is a modular monolith in one TypeScript Next.js repository. Work is divided into independently reviewable tasks and commits, but the MVP must preserve one coherent deployment contract.

### Included in the MVP

- Email and username authentication with optional TOTP two-factor authentication, QR enrollment, and one-time backup codes.
- Idempotent administrator bootstrap from validated environment variables.
- Multiple users, isolated workspaces, role-based membership, email invitations through Resend, and record-level restrictions.
- Organization-scoped, hashed, permissioned, expirable, revocable API keys.
- A GraphQL API for people, facts, relationships, evidence, files, graph queries, saved views, and AI analysis.
- Exhaustive Drizzle schema and migrations for the approved data model.
- People and fact management, including contradictory and historical facts.
- Relationship management and an interactive social-network graph.
- Evidence, notes, tags, direct uploads, and CSV/JSON imports.
- PostgreSQL full-text search and optional embedding records.
- OpenAI-compatible natural-language query and cited analysis, supporting OpenAI and Ollama.
- Vercel and Docker deployment documentation and configuration.
- Unit, integration, authorization, GraphQL, end-to-end, and container smoke tests.

### Deliberately excluded from the MVP

- Native mobile applications.
- Real-time multi-user editing.
- Automated facial recognition or biometric matching.
- Autonomous collection or scraping of personal information.
- A universal entity model for companies, devices, or non-human nodes.
- Mandatory pgvector, PostGIS, malware-scanner, or Ollama dependencies.

These exclusions keep the first release focused while leaving explicit extension seams.

## 3. Architecture

### 3.1 Application boundary

Next.js App Router serves the web interface and HTTP endpoints. GraphQL Yoga at `/api/graphql` is the canonical application-data API. Better Auth owns its authentication endpoints. The browser uses generated GraphQL operations for application data and never imports database repositories.

Pothos builds the code-first GraphQL schema. GraphQL Code Generator produces typed documents and client types. Domain services sit between resolvers and Drizzle repositories so authorization, validation, audit behavior, and workspace scoping remain reusable by GraphQL, background executors, and tests.

The source tree is organized by responsibility:

```text
src/
  app/                 Next.js routes and layouts
  components/          reusable UI and graph components
  graphql/             schema, context, plugins, loaders, operations
  modules/             auth, people, facts, relationships, evidence, files,
                       imports, search, graph, ai, audit, jobs
  db/                  Drizzle client, schema, migrations, repositories
  lib/                 environment, Redis, storage, email, security utilities
  worker/              bounded durable-job executor shared by both deployments
tests/                  unit, integration, authorization, e2e, smoke fixtures
```

### 3.2 Runtime dependencies

- PostgreSQL is authoritative durable storage.
- Redis provides rate limits, cache entries, short-lived coordination, and job leases. It is never the only copy of application data.
- One S3-compatible storage adapter supports Cloudflare R2, generic S3 services, and MinIO.
- Resend delivers verification, reset, and workspace-invitation email.
- The AI adapter uses an OpenAI-compatible interface and selects OpenAI, Ollama, or another configured base URL without exposing provider details to domain code.

### 3.3 Deployment parity

Production environment validation identifies either `vercel` or `docker` mode but keeps the same application-level variables and behavior.

The default `docker-compose.yml` starts:

- `app`: the production application image.
- `migrate`: a one-shot migration command that must complete successfully before `app` becomes ready.
- `postgres`: a pinned PostgreSQL image, authenticated connection, persistent volume, and health check.
- `redis`: a pinned Redis image with password authentication, append-only persistence, persistent volume, and health check.
- `minio`: an authenticated MinIO server with persistent volume and health check.
- `minio-init`: an idempotent one-shot service that creates the configured private bucket and CORS policy.
- `worker`: the same application image running the durable-job executor.

Compose services communicate over an internal network. Only the application port and optional MinIO console are published by default. PostgreSQL and Redis may be exposed through an opt-in development override, not the production-like base file.

An `ollama` Compose profile adds Ollama and model initialization. The ordinary local stack does not require downloading a model. A test Compose configuration uses isolated ephemeral volumes and health-gated services.

On Vercel, bounded scheduled invocations execute durable job batches. Self-hosting runs the same executor continuously in the `worker` container. PostgreSQL job rows remain the source of truth; Redis leases prevent concurrent execution.

## 4. Identity, authorization, and security

Better Auth supplies users, password accounts, sessions, verification, username, two-factor, backup-code, organization, invitation, admin, and API-key behavior through its Drizzle adapter and plugins.

The environment defines the initial administrator email, username, display name, and password. Bootstrap is idempotent and production startup rejects absent, placeholder, or weak credentials. The password is not retained after it is used to create or reconcile the account.

TOTP enrollment generates a temporary `otpauth` URI and QR code. The image is never stored. TOTP secrets use application-level encryption. Backup codes are protected, shown only at creation or regeneration, invalidated after use, and never written to logs.

Every GraphQL request resolves exactly one authentication mode: browser session or API key. API-key authentication cannot inherit a browser session. The context contains the actor, active workspace, membership, explicit permissions, request ID, scoped loaders, and service handles.

Workspace roles are owner, admin, analyst, contributor, and viewer. Permissions are expressed as resource/action pairs. `access_policies` and `resource_grants` may narrow access to confidential or restricted records. Domain services authorize every operation, and repositories require `workspace_id` so missing resolver checks cannot become cross-workspace reads.

Security controls include:

- Origin and CSRF validation for cookie-authenticated mutations.
- Secure, HTTP-only, same-site cookies and trusted-host validation.
- GraphQL depth, alias, complexity, pagination, request-size, and batch limits.
- Redis-backed rate limits by actor, API key, IP prefix, and operation class.
- Parameterized Drizzle queries and schema validation for all inputs.
- Content Security Policy, clickjacking protection, strict MIME handling, and safe download disposition.
- Redacted structured logging; passwords, tokens, 2FA material, private file contents, fact values marked restricted, and AI prompts are excluded by default.
- Short-lived signed upload/download operations and server-controlled object keys.
- Upload quarantine, checksum verification, file-type validation, size limits, and a pluggable malware-scan policy.
- Optimistic version checks and idempotency keys for retryable mutations.
- Immutable, redacted audit events for security-relevant activity.

## 5. Identifier and tenancy conventions

Domain identifiers are application-generated UUIDv7 values stored in PostgreSQL `uuid` columns. UUIDv7 gives stable globally unique identifiers with useful insertion locality without requiring a specific PostgreSQL extension. Better Auth identifiers retain the adapter's supported string representation.

Every domain table contains `workspace_id`. Unique indexes begin with `workspace_id` unless the value is intentionally global. Cross-table repository operations verify that referenced rows belong to the same workspace. All timestamps are UTC `timestamptz`; user-facing timezone conversion uses workspace or user preferences.

Mutable records include `version`, `created_at`, `updated_at`, `created_by`, and `updated_by`. User-visible records support `deleted_at` and `deleted_by` where recovery or auditability matters. Immutable revisions are append-only.

## 6. Data model

### 6.1 Authentication and workspaces

Better Auth-managed tables cover users, accounts, sessions, verifications, two-factor secrets, backup codes, organizations, members, invitations, and API keys. Generated schemas are committed and reviewed like application migrations.

Application tables:

- `workspace_settings`: locale, timezone, retention, privacy defaults, graph defaults, enabled AI/storage features, and version.
- `workspace_usage`: cached operational totals by day, never an authorization source.
- `access_policies`: workspace-defined policy name, sensitivity ceiling, resource kinds, role bindings, and state.
- `resource_grants`: policy/member/role access to a specific resource UUID and resource kind.
- `retention_policies`: resource kind, retention period, deletion behavior, and legal basis.
- `legal_holds`: resource reference, reason, authority, creator, and release metadata.
- `deletion_requests`: requester, scope, workflow state, review, export reference, and completion metadata.
- `consent_records`: person reference, purpose, status, source, effective interval, and evidence reference.

### 6.2 People

`people` is the stable identity and presentation record:

- UUIDv7 `id`, `workspace_id`, `display_name`, `sort_name`, `preferred_name`, and `biography`.
- `primary_name_id` and `primary_photo_file_id` selections.
- Lifecycle `status`: active, deceased, missing, unknown, archived, or merged.
- `sensitivity`: public, internal, confidential, or restricted.
- `confidence` constrained from 0 through 1 and an optional explanation.
- `merged_into_person_id` for a tombstoned duplicate.
- Optimistic version, actor timestamps, and soft deletion.

Birth date, death date, sex, gender identity, pronouns, occupation, nationality, and other research claims are facts rather than duplicated `people` columns. `person_field_selections` maps a presentation field to the accepted fact UUID and records the selecting actor and reason.

Supporting tables:

- `person_names`: person, kind, full name, structured components, script, language, normalized form, temporal bounds, confidence, sensitivity, and state.
- `person_identifiers`: person, namespace, type, protected raw value, normalized/blind-index value, issuer, temporal bounds, verification state, and sensitivity.
- `person_events`: person, event kind, title, description, place, temporal bounds, confidence, and state.
- `external_records`: source system, external type/ID, person, import, source hash, and last-seen time; unique per workspace/source/type/ID.
- `identity_candidates`: two person UUIDs, match signals, score, workflow state, and reviewer.
- `merge_decisions`: winner, loser, field choices, actor, reason, reversible snapshot, and timestamp.

### 6.3 Fact catalog and facts

`fact_definitions` controls flexible fields without allowing an ungoverned entity-attribute-value model:

- Workspace or system namespace, stable field key, label, description, and category.
- Allowed value type and cardinality.
- JSON Schema validation rules and optional enumeration metadata.
- Searchable, filterable, graphable, and user-definable flags.
- Default sensitivity and lifecycle state.
- Unique `(workspace_id, namespace, field_key)` constraint for workspace definitions.

Each `facts` row is one assertion attached to exactly one person through required `person_id`:

- UUIDv7 `id`, `workspace_id`, `person_id`, and `fact_definition_id`.
- Snapshot `namespace`, `field_key`, and label for durable exports.
- `value_type`: text, rich text, integer, decimal, boolean, date, date range, timestamp, duration, quantity, URI, JSON, person reference, place reference, or file reference.
- Sparse typed values: text, decimal, boolean, date start/end, timestamp, JSON, referenced person, place, or file. A database check enforces the type/value combination.
- Unit, language, normalized search value, and optional encrypted value plus keyed blind index for protected exact-match fields.
- State: asserted, corroborated, disputed, disproven, superseded, or unknown.
- Confidence from 0 through 1, confidence method, explanation, sensitivity, and review state.
- Temporal semantics: exact, approximate, before, after, between, year-only, or unknown; earliest/latest validity, observation time, assertion time, and precision.
- Optional `supersedes_fact_id`, optimistic version, actor timestamps, and soft deletion.

There is deliberately no uniqueness constraint on `(person_id, field_key)`. A person may have multiple current, historical, or contradictory facts of the same definition.

Supporting tables:

- `fact_revisions`: immutable before/after fact snapshots and actor metadata.
- `fact_relationships`: directed supports, contradicts, duplicates, supersedes, or derived-from edges between facts.
- `fact_evidence`: many-to-many fact/evidence association with excerpt, page/locator, and support strength.
- `fact_tags`: fact/tag association.

### 6.4 Contact and location

- `contact_points`: kind, protected display value, normalized/blind-index value, label, verification, sensitivity, and metadata.
- `person_contact_points`: person/contact association, usage kind, primary flag, temporal bounds, confidence, and evidence.
- `places`: reusable named place, kind, parent place, country/region/locality, coordinates, geocode metadata, and sensitivity.
- `addresses`: place reference, structured components, unstructured text, postal metadata, normalized hash, coordinates, and sensitivity.
- `person_addresses`: person/address association, address kind, temporal bounds/precision, primary flag, confidence, state, and evidence.

Coordinates use portable numeric latitude/longitude columns in the MVP. PostGIS is an optional later enhancement, not a deployment prerequisite.

### 6.5 Social relationships

- `relationship_types`: workspace/system definition, forward and inverse labels, directed flag, allowed multiplicity, metadata schema, and lifecycle state.
- `relationships`: source person, target person, type, label override, strength, confidence, state, sensitivity, temporal semantics/bounds, arbitrary validated metadata, actor timestamps, version, and soft deletion.
- `relationship_evidence`: many-to-many relationship/evidence association with locator and support strength.
- `relationship_tags`: relationship/tag association.

Self-relationships are rejected unless a relationship type explicitly allows them. Duplicate edges are allowed when they represent different intervals, sources, or states.

### 6.6 Evidence, notes, and organization

- `sources`: kind, title, publisher/author, canonical URL, citation, collection method, collected time, reliability, sensitivity, metadata, and content hash.
- `evidence_items`: source, file, external locator, extracted text, captured time, checksum, review state, and sensitivity.
- `evidence_excerpts`: evidence item, page/offset/time locator, excerpt, language, checksum, and redaction state.
- `notes`: optional person/fact/relationship/evidence subject, plain text or sanitized Markdown, sensitivity, version, and actor timestamps.
- `tags`: workspace-scoped name, normalized name, color, description, and unique normalized constraint.
- `person_tags`: person/tag association with creator and timestamp.

### 6.7 Files and ingestion

- `files`: workspace, storage provider/bucket/key, original name, media type, detected type, bytes, checksum, encryption metadata, quarantine/scan state, OCR/extraction state, sensitivity, uploader, and deletion metadata.
- `file_variants`: parent file, kind, storage location, media metadata, checksum, and generator version.
- `upload_sessions`: actor, intended purpose, limits, expected checksum/type, object key, expiry, completion, and failure state.
- `imports`: file, format, workflow state, mapping, idempotency key, totals, actor, and timestamps.
- `import_mappings`: named reusable source-column to domain-field mapping and validation configuration.
- `import_rows`: import, row number, source hash, normalized payload, resulting resource references, validation errors, and state.
- `extraction_runs`: file, extractor/version, configuration, state, structured output, error summary, and timestamps.

### 6.8 Search, saved views, and graph analysis

- `search_documents`: resource kind/UUID, redacted searchable text, PostgreSQL `tsvector`, source version, and update time.
- `embeddings`: resource kind/UUID, provider, model, dimensions, vector or portable JSON representation, source hash, configuration, and generation time. The vector column is enabled only when configured and supported.
- `saved_queries`: owner, name, GraphQL document or structured filter, variables, sharing, and version.
- `query_runs`: saved query, actor, normalized input hash, timing, result count, and redacted error metadata.
- `graph_views`: owner, name, filters, layout, appearance, sharing, and version.
- `graph_view_nodes`: view, person, pinned position, style override, and visibility.
- `graph_snapshots`: view/query input, included person/relationship versions, algorithm configuration, and generated time.
- `analysis_runs`: algorithm, graph snapshot, configuration, state, timing, and error summary.
- `analysis_results`: run, result kind, subject person/relationship, numeric/text/JSON value, rank, and explanation.
- `person_metrics`: snapshot, person, metric key/value, rank, and algorithm version.

### 6.9 AI analysis

- `ai_threads`: workspace, owner, title, sharing, retention, and timestamps.
- `ai_messages`: thread, role, protected content, content hash, citation count, and timestamps.
- `ai_runs`: thread/message, provider, base-URL fingerprint, model, capability profile, prompt/configuration hashes, state, token/cost metadata, timing, and error code.
- `ai_tool_calls`: run, approved tool name, redacted arguments/result summary, resource references, timing, and state.
- `ai_citations`: run/message, resource kind/UUID, evidence UUID, locator, and claim text.

Models never execute generated SQL or arbitrary GraphQL. They receive a small read-only tool set backed by the same authorized domain services. AI answers must cite returned UUIDs. Prompt retention is configurable and disabled for restricted values unless policy explicitly permits it.

### 6.10 Operations

- `jobs`: kind, workspace, protected payload, idempotency key, priority, state, attempt count, schedule/lease timestamps, error code, and result references.
- `audit_events`: actor/session/API-key reference, workspace, action, resource kind/UUID, request ID, IP hash, user-agent summary, redacted diff, outcome, and timestamp.
- `idempotency_keys`: workspace, actor, operation, key hash, request hash, response reference, status, and expiry.
- `webhooks`: workspace, URL, protected secret, subscribed events, state, and timestamps.
- `webhook_deliveries`: webhook/event, attempt, signature metadata, response status, timing, next retry, and redacted error.

## 7. GraphQL design

The schema exposes typed objects, cursor connections, filters, and mutations for the MVP resources. UUIDs use a strict scalar. Date and JSON scalars are explicit. Polymorphic resource references use constrained unions rather than untyped strings.

Representative queries include `viewer`, `workspace`, `people`, `person`, `facts`, `relationships`, `search`, `graph`, `savedQueries`, `graphViews`, `files`, `imports`, and `aiRun`.

Representative mutations include authentication-independent Better Auth calls plus `createPerson`, `updatePerson`, `archivePerson`, `mergePeople`, `createFact`, `reviseFact`, `selectPersonField`, `createRelationship`, `createUploadSession`, `completeUpload`, `startImport`, `createApiKey`, `revokeApiKey`, `inviteMember`, `startAnalysis`, and saved-view operations.

Mutations return typed payloads with a resource, validation issues, and stable error codes. Expected validation and conflict outcomes are not hidden as generic server errors. Cursor pagination is mandatory for collections. Resolvers batch related rows and enforce maximum page sizes.

GraphQL introspection and the developer IDE are available in development. Production introspection is authenticated and permission-controlled. Persisted-operation support is an optimization seam rather than an MVP requirement.

## 8. User experience

The interface uses Tailwind CSS, accessible headless primitives, a reusable component system, Lucide icons, and restrained motion. Sigma.js and Graphology render large social networks through WebGL. React Flow supports the smaller direct relationship editor. Graphology layout and metrics packages supply graph algorithms; additional visualization libraries are added only for a demonstrated requirement.

Primary surfaces:

1. **Authentication:** sign in, register according to deployment policy, verify email, recover password, enroll/verify/disable 2FA, and regenerate backup codes.
2. **Workspace setup:** create or select a workspace, invite by email, manage roles, and configure retention, storage, and AI policies.
3. **Dashboard:** recent people, imports, analyses, workspace activity, and concise graph statistics.
4. **People:** searchable/filterable table and create/edit flow.
5. **Person profile:** overview, names, facts, relationships, timeline, evidence, files, notes, and activity. Contradictory facts are visible rather than silently collapsed.
6. **Graph explorer:** WebGL graph, search, filters, temporal range, layout controls, path/highlight tools, selection inspector, saved views, and accessible tabular fallback.
7. **Relationship editor:** focused node/edge editing for a selected neighborhood.
8. **Research search:** full-text and structured filters with saved GraphQL-backed queries.
9. **AI analyst:** natural-language question, selected scope, run progress, cited answer, tool trace summary, and model/provider disclosure.
10. **Evidence and imports:** upload, quarantine/processing status, mapping preview, row errors, and idempotent retry.
11. **Settings:** members, invitations, API keys, workspace policy, audit trail, integrations, and deployment diagnostics.

The responsive design supports desktop graph work and mobile record review. Keyboard navigation, focus visibility, semantic structure, reduced motion, color contrast, non-color graph encodings, and the tabular graph alternative are acceptance criteria.

## 9. Error handling and observability

Stable GraphQL extension codes include `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `PRECONDITION_FAILED`, `RATE_LIMITED`, `UPLOAD_REJECTED`, `PROVIDER_UNAVAILABLE`, and `INTERNAL`.

Every request receives a correlation ID returned in error extensions and response headers. Logs are structured and redacted. Health endpoints separately report liveness and readiness; readiness verifies required configuration and dependency reachability without exposing credentials.

Jobs use bounded retries with exponential backoff and dead-letter state. Imports preserve row-level errors. AI and storage provider failures remain resumable and never cause a partially written fact or relationship to appear successful.

## 10. Testing strategy

- Unit tests cover validation, permissions, temporal semantics, confidence checks, normalization, graph transformations, provider selection, and redaction.
- Repository integration tests run against real PostgreSQL and verify constraints, migrations, workspace scoping, transactions, and concurrency.
- Redis and object-storage integration tests exercise rate limits, leases, signed operations, bucket isolation, and upload completion.
- GraphQL tests execute operations through the real request context for session and API-key actors.
- Dedicated tenant-isolation tests attempt cross-workspace reads and mutations for every repository and high-value GraphQL surface.
- Authentication tests cover admin bootstrap, username/email flows, invitations, role changes, TOTP enrollment/verification, backup-code consumption, and API-key lifecycle.
- Security tests cover depth/complexity rejection, CSRF/origin enforcement, upload validation, logging redaction, and authorization bypass attempts.
- End-to-end browser tests cover the primary user journey from sign-in through creating people/facts/relationships, viewing the graph, uploading evidence, and receiving a cited AI result through a deterministic fake provider.
- Docker smoke tests build the production image, start the required Compose services, run migrations, verify health, execute a GraphQL operation, and confirm MinIO upload access.
- Optional Ollama smoke tests run only when the profile and a suitable local model are explicitly enabled.

CI gates formatting, linting, type checking, unit/integration tests, migration drift, schema generation drift, production build, Docker build, dependency review, and secret scanning.

## 11. Environment and secret policy

`.env.example` documents every variable with safe placeholders. `.env`, `.env.*`, exported data, local object-storage contents, database volumes/dumps, coverage, logs, generated secrets, IDE state, Codex/Claude/Hermes agent files, Superpowers scratch state, and other private development artifacts are ignored. Explicit safe examples and repository instructions are force-included where needed.

Server-only configuration is parsed once through a typed schema. Client-exposed variables use an explicit public prefix and separate schema. Production mode rejects insecure cookie settings, placeholder secrets, default service passwords, public object buckets, absent administrator credentials, and incompatible provider combinations.

## 12. Documentation and open-source operation

The repository contains:

- `README.md`: purpose, screenshots when available, quick starts, deployment choices, security posture, contribution links, and license.
- `docs/ARCHITECTURE.md`: runtime boundaries, data flow, deployment diagrams, and architectural decisions.
- `docs/REQUIREMENTS.md`: numbered functional and non-functional acceptance requirements.
- `docs/DESIGN.md`: UI, interaction, accessibility, and visual-system guidance.
- `TODO.md`: requirement-linked production backlog with checked items backed by commits/tests.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and Apache-2.0 `LICENSE`.
- Agent instructions that contain no secrets and are safe for a public repository.

GitHub branch protection and repository settings are documented even when account-level configuration cannot be automated. Pull requests use a template that requires tests, migrations, security impact, documentation, and deployment notes.

## 13. MVP milestone sequence

1. **Foundation:** repository, Next.js, TypeScript, Tailwind, quality tooling, environment validation, documentation, CI, Docker image, Compose dependencies, and health checks.
2. **Persistence and API:** exhaustive Drizzle schema, migrations, seed fixtures, GraphQL Yoga/Pothos, typed operations, repositories, and workspace-isolation tests.
3. **Identity and collaboration:** Better Auth, admin bootstrap, 2FA, backup codes, workspaces, roles, invitations through Resend, and API keys.
4. **Research core:** people, fact catalog, multiple facts per person, accepted selections, relationships, evidence, notes, tags, search, and audit UX/API.
5. **Graph experience:** Sigma/Graphology explorer, React Flow neighborhood editor, saved views, temporal filters, metrics, and accessible fallback.
6. **Files and imports:** S3 adapter, R2/S3/MinIO configuration, quarantine, upload UI, CSV/JSON mapping, validation, and durable jobs.
7. **AI analyst:** OpenAI-compatible adapter, OpenAI/Ollama configuration, restricted tools, durable analysis runs, citations, deterministic tests, and UI.
8. **Production hardening:** full test matrix, Docker smoke, Vercel configuration, security review, dependency/secret scans, performance budgets, release documentation, public GitHub PR, merge, and deployment verification where credentials are available.

## 14. Acceptance rule

No milestone is complete because files merely exist. Completion requires its numbered requirements, migrations, tests, builds, and relevant runtime checks to pass. The application is MVP-ready only when the complete requirement matrix is verified in the current repository state, the local Compose stack works with PostgreSQL, Redis, and MinIO, and remaining `TODO.md` items are explicitly post-MVP rather than missing MVP behavior.
