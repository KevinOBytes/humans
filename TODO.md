# MVP closure and production hardening backlog

## Production deployment verification (2026-09-14)

- Verified: deployed reviewed application commit `dcbb36431abec2793d66930f8b5c188705bc6517`
  to Vercel production as `dpl_BkV534V7M832BTkt1ahb3YX76btc` (`READY`).
- Verified: aliases `humans.kevinbytes.com`, `humans-dun.vercel.app`, and
  `humans-tkoresearch.vercel.app` resolve to that deployment.
- Verified: homepage, sign-in, liveness, and readiness routes all return 200.
- Verified: unauthenticated GraphQL fails closed with 401
  `UNAUTHENTICATED` and a request ID.
- Verified: GitHub Actions run `34850702071` passed all nine required jobs,
  including real PostgreSQL integration, browser acceptance, build,
  Compose, generated-drift, image-security, dependency, and secret-scan.
- Open operator evidence: run attended hosted administrator sign-in, recovery, optional 2FA, and
  first-person creation using credentials supplied through the ignored
  mode-0600 operator templates; do not print secrets.
- Open operator evidence: run the opt-in live OpenAI/Ollama, Resend, Upstash, and R2/S3 provider
  contracts with redacted output and record the provider evidence.

## Full-MVP closeout tranche verification (2026-09-14)

Merged locally into `main` after independent review:

- `4d0c810` / `c02f7ed`: relationship evidence semantics keep explicit
  documented versus analyst-hypothesis status separate from review/claim
  state; nullable relationship strength is distinct from confidence and is
  carried through the graph API and inspector.
- `5d04066`: `person.merge` and `person.unmerge` use principal-bound
  idempotency with user-only legacy replay compatibility, workspace/API-key
  fencing, strict response references, and redacted audit effects.
- `88f737a` / `20716f2`: environment/provider acceptance contracts cover
  canonical Vercel aliases, redacted environment checks, and explicit opt-in
  AI/Resend/Upstash/storage lifecycle runners. Review remediation prevents
  empty canonical Upstash values from producing false success and keeps
  `POSTGRES_URL` consistent with administrator-operation parsing.

Post-merge focused validation passed: 7 changed-surface unit files, 206 tests;
format, lint, typecheck, GraphQL codegen drift, and production build all pass.
The implementation branches were reviewed and their worktrees removed. The
full database/Compose/browser matrix, hosted admin authentication and recovery,
and live external-provider runs remain open and are not implied by this local
evidence.

## Relationship semantic contract checkpoint (2026-09-14)

Follow-up graph projection: the repository/service, canonical GraphQL enum,
generated graph and snapshot operations, browser mapper, and inspector now
carry explicit epistemic status. Legacy projections without it display an
unknown status rather than inferring documentation from corroboration.
Focused GraphQL serialization and inspector tests pass; the generated live
graph tenant-isolation test remains pending a configured disposable database.

Profile relationship cards now derive evidence status only from the stored
`epistemicStatus`; an approved analyst hypothesis is never relabelled as
documented, and missing/unknown status is not treated as documentation.
Corroboration/claim state, review state, confidence, and nullable relationship
strength remain separate. The profile create form exposes optional strength
through the existing generated, authorized `CreateRelationship` mutation,
preserving unassessed (`null`) versus zero and accessible validation feedback.
The focused semantic/form/card suite passes 23 tests. The research-core browser
journey now asserts persisted strength on both directional profile views;
execution of that extended journey and full hosted/whole-profile acceptance
remain open. No schema or policy boundary was replaced.

## Current closure tranche (2026-09-14)

Provider-acceptance harness checkpoint (2026-09-14): the production smoke now
has an explicit environment-name contract for public runtime, authentication,
administrator recovery, Redis/Upstash, R2/S3/MinIO, Resend, and the selected
OpenAI-compatible or Ollama provider. It reports variable names and provider
labels only. Vercel marketplace aliases for PostgreSQL, Redis, and OpenAI are
normalized only when their canonical runtime names are absent. External AI and
Resend lifecycle checks join the existing Upstash and isolated-storage checks,
remain gated by `RUN_EXTERNAL_PROVIDER_CONTRACTS=true`, execute in a
secret-minimized child process, and suppress provider output. Controlled local
provider-boundary coverage proves the new child runner, but no real external
provider or hosted administrator credential was used; the corresponding
production acceptance rows remain open.

Commits `a1eab94`, `142a1cb`, `a9352f4`, and `deec37d` are merged on local
`main` and cover three independently reviewed hardening tasks: exact
person-name/event replay references with a real-PostgreSQL matrix; stable
correlated direct-route failures with no-store and secret-free diagnostics;
and an explicit, redacted hosted-auth smoke path. Operator credential
templates are now mode `0600` and split into least-privilege authentication,
recovery, Upstash, and storage profiles. Node 24 local gates passed formatting,
lint, typecheck, Drizzle/schema checks, generated checks, 1,559 unit tests, and
the production build. `pnpm test:db` was run without `TEST_DATABASE_URL`, so
only its configuration-independent subset executed; no hosted credentials or
external provider calls were made. The corresponding hosted, provider,
whole-product browser/accessibility/performance, and full local integration
rows remain explicitly open below.

Post-merge evidence (2026-09-14): GitHub Actions run `34811260101` passed all
nine required jobs, including real PostgreSQL/Redis/MinIO integration and
browser acceptance. Vercel deployment
`dpl_AWPhqDz47mmcAPeHwtEDf1rivSdD` is `READY` and serves all three configured
aliases: `humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. Anonymous probes returned 200 for `/`,
`/api/health/live`, and `/api/health/ready`; unauthenticated GraphQL returned
the expected 401 `UNAUTHENTICATED` response with a request ID. This closes the
merge/CI/deployment proof for the tranche only; hosted administrator auth,
external providers, recovery, and the whole-product acceptance rows remain
open.

Current release checkpoint (2026-09-13): runtime commit `7826483` is deployed
from `main`; checkpoint documentation is being synchronized with that runtime.
GitHub Actions run `34784968632` passed all nine required jobs, and Vercel
deployment `dpl_98V3ADEfRHvTLKmdUjQrbw3kbNQf` is `READY` on Node 24 with
production aliases `humans-dun.vercel.app` and `humans-tkoresearch.vercel.app`.
The release adds governed, catalog-backed
web fact suggestions for consented AI research and fixes the authenticated
smoke harness to send the trusted same-origin headers required by GraphQL.
The local Compose stack was also started successfully with PostgreSQL, Redis,
MinIO, app, worker, migration, admin bootstrap, and synthetic seed; the
remaining hosted credential rotation/provider and whole-product acceptance
rows below are still intentionally open.

Hosted acceptance-harness checkpoint (2026-09-14): the redacted production
smoke now has an explicit `--authenticated` operator switch while accepting
credentials only through the caller environment or its dedicated mode-0600
least-privilege template (the existing `PRODUCTION_SMOKE_AUTH=1` remains
automation-compatible). Recovery, Upstash, and storage contract templates are
separate. It validates missing administrator variable names before any network
call and collapses transport exceptions to a fixed request-path diagnostic, so
values and credential-bearing URLs cannot enter smoke output. The focused
contract suite passes; no hosted credential or external-provider run was
performed, so the related release rows remain incomplete.

The expanded scope for this backlog is explicit: rich, multi-fact person
profiles; temporal and epistemically-labelled relationship graphs; source and
field-level provenance; workspace/case/investigation/team boundaries; consent,
privacy, retention, deletion, legal holds, and export governance; immutable
auditability; human-reviewed AI research; faceted search and explainable
analysis; controlled import/export; scoped API keys and 2FA; and fictional
synthetic demo data. The current release ships the collaboration pages and
linked-scope assignment queue. Remaining entries are release evidence gaps or
operator/provider acceptance work, not permission to weaken these boundaries.

Latest collaboration/runtime release evidence (2026-09-13): commits
`4b55c33`, `556ad33`, and the documentation release `d08bbcd` are pushed to
`main`. GitHub Actions runs `34767480893` and `34768072841` passed all nine
required jobs, including Node 24 quality, real
PostgreSQL integration, browser acceptance, production build, generated drift,
Compose lifecycle, image security, dependency policy, and secret scanning. The
current runtime tree was deployed as Vercel `dpl_F4MjcikAGaGnh1AEgKBgxyEyvQhk`
(`READY`) with aliases `humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. Redacted production smoke passed homepage,
liveness, readiness with PostgreSQL/Redis/storage, unauthenticated GraphQL,
and the protected jobs boundary. This release includes first-class
workspace-scoped teams, team members, explicit case-team sharing grants,
investigations, and investigation-case links with authorization, idempotency,
and audit coverage. Hosted credentialed sign-in/person creation and external
provider-contract acceptance remain open because protected Vercel secrets were
not exported for an attended administrator rotation; the remaining hosted,
privacy, accessibility, performance, recovery, and dedicated collaboration UI
matrix remains tracked below.

Rich-profile definition catalog checkpoint (2026-09-13): every newly created
workspace now receives audited fact-definition templates for pronouns,
employment, education, languages, organizations, birth dates, and workspace
custom JSON fields. The templates are definitions only; values still enter via
the existing workspace-scoped fact service and retain temporal bounds,
provenance, confidence, sensitivity, review, contradiction, and audit
controls. `tests/unit/profile-fact-definition-catalog.test.ts` verifies the
catalog and `tests/integration/workspace-profile-definitions.test.ts` verifies
the generated GraphQL fact catalog when PostgreSQL is configured. Existing
workspaces still require a controlled operator backfill before this is a
complete historical migration; aliases, biography, contacts, addresses,
identifiers, notes, and files remain on their existing dedicated boundaries.

Rich-profile entry guidance checkpoint (2026-09-13): the profile fact editor
now preserves and presents each catalog definition's category and description
(for example, “Work · Employment — An employment role, employer, or employment
period”) with an accessible description relationship. This makes the existing
audited fact path discoverable for pronouns, employment, education, languages,
organizations, birth dates, and custom JSON without adding an ungoverned write
path. `tests/unit/fact-form.test.tsx` and `tests/unit/facts-section.test.tsx`
pass for the focused behavior. The full rich-profile browser/accessibility
matrix remains open.

Identifier authoring checkpoint (2026-09-13): generated create/update/archive
operations and profile controls are implemented with live workspace-authority
revalidation, resource visibility, effective-date validation, optimistic
versions, redacted audits, and principal-bound replay. Public values use
normalized storage; all other values use protected-exact encryption and blind
indexes and fail closed without runtime keys. Editors never load protected
values and require a replacement for protected reclassification/namespace
changes.
The default new profile identifier is encrypted `internal`. Invisible
post-write results roll back with `NOT_VISIBLE` before audit/idempotency commit;
confidential/restricted access still requires explicit resource authority.
Update/archive SQL fences the authorized parent UUID against merge/unmerge
ownership changes. Focused transaction-guard regressions cover both boundaries.
Unit/schema/component tests cover storage preparation, generated
operations, permissions, retries, and conflict feedback. The new gated
`person-identifier-lifecycle.test.ts` covers generated and service lifecycles,
principal separation, cross-workspace denial, version fencing, redaction, and
audit counts, but remains unexecuted here without `TEST_DATABASE_URL`. Live
PostgreSQL, hosted, and full profile browser/accessibility acceptance remain
open; HUM-FR-010/HUM-FR-028 are not marked complete.

Latest main-tree evidence (2026-09-13): commit `591c1d7` is pushed and deployed
as Vercel `dpl_HSK2gk4swq1gvyiBYawCrx3UiJaT` (`READY`) with aliases
`humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. GitHub Actions run `34760813821` passed all
nine required jobs (Node 24 quality, PostgreSQL integration, browser
acceptance, production build, generated drift, Compose lifecycle, image
security, dependency policy, and secret scanning). Public smoke passed
homepage/liveness/readiness (PostgreSQL/Redis/storage healthy), unauthenticated
GraphQL, and protected jobs. Hosted credentialed auth/person creation and
external provider acceptance remain open because protected Vercel secrets were
not exported; the remaining hosted/provider/privacy/accessibility/performance
matrix is intentionally still tracked below.

Assignment scope checkpoint (2026-09-13): research assignment items now carry
optional immutable investigation and reusable-team scopes in migration `0050`.
Creation validates workspace ownership, active lifecycle, investigation lead or
team membership, and linked case boundaries; assignee validation requires case
membership, team membership, or investigation-lead authority. Reads apply the
same scope boundary and expose investigation/team filters through generated
GraphQL. Existing workspace- and case-scoped queues remain compatible. Focused
schema and service tests cover the contract; hosted/provider and whole-role
acceptance remain tracked as incomplete.

Bounded investigation-read authorization checkpoint (2026-09-13): generated
investigation reads apply the same information-sharing boundary as the
assignment queue. Workspace owners/administrators retain workspace visibility;
other principals must lead the investigation, belong to a linked case, or
belong to a team with an active linked-case share. The predicate is applied in
both point reads and paginated lists, so unrelated readers cannot infer an
investigation from list membership. API-key principals remain non-manager
principals and therefore need an explicit linked scope. A disposable PostgreSQL
18.3 run of `tests/integration/research-assignment-lifecycle.test.ts` passed
nine tests, including owner/admin manager point-read/list, lead,
linked-case-member, linked-team-member, explicitly shared API-key,
foreign-workspace, archived-team, and unrelated reader point-read/list
boundaries across two linked cases. The matrix asserts exact manager IDs and
terminal page information, including neutral empty-list cursors for hidden
readers. Hosted and broader role/resource acceptance remain open, so the
governing requirements stay incomplete.

Identifier citation boundary checkpoint (2026-09-13): public person identifier
citations reuse `linkEvidenceAssertion` with the canonical field path
`identifiers.<uuid>.v<version>.<field>`. The service verifies the actual active
identifier, parent, workspace, current version, and visibility under parent-first
row locks. It preserves existing evidence/source linkage, purpose coverage,
redacted audit, and principal-bound idempotency; replay rechecks the current
identifier boundary. Keyed person assertion writes now deduplicate required
permissions. Public-to-protected identifier reclassification is rejected while
active plaintext identifier citations exist, even with a replacement value;
existing source quotes are not silently rewritten or left as protected-value
shadow copies. The guard includes previous parents/versions and legacy path
prefixes. Explicit confidential identifier grants use the canonical
`personIdentifier` resource kind before the protected-storage precondition.
Keyed assertion services receive the configured runtime HMAC through GraphQL.
Focused
real-PostgreSQL tests cover linkage/replay, wrong parent/workspace, protected
value rejection, stale versions, archive, source preservation, and generated
GraphQL author permissions. This is not full identifier provenance completion:
the broader rich-profile citation matrix, hosted acceptance, and citation
authoring UI remain open.

Protected citation storage checkpoint (2026-09-14): migration `0053` adds
paired sealed-envelope columns for identifier citation locators and quotes while
keeping the existing plaintext GraphQL shape for public citations. Protected
links require the configured deployment data key, persist no plaintext locator
or quote, and decrypt only after the existing workspace/person/identifier
visibility and current-version checks pass. Unauthorized readers omit the
candidate, malformed or stale storage fails closed, reclassification guards
inspect every active citation, and audit events contain changed-field metadata
only. A focused unit suite covers envelope purpose/key binding and storage-mode
guards; live PostgreSQL integration remains gated when `TEST_DATABASE_URL` is
absent, so this bounded checkpoint does not close the hosted or whole-profile
acceptance matrix.

Public identifier citation readback checkpoint (2026-09-13): generated
`PersonIdentifierCitations` backs the profile's Sources & citations panel.
The read transaction revalidates the live principal, workspace, person,
identifier, current version, source, evidence, optional case, and current
purpose coverage. It returns only bounded public citation metadata; protected,
stale, malformed, archived, or inaccessible bindings are omitted. Sealed,
workspace/person/principal-bound cursors keep skipped assertion IDs private;
bounded candidate pages may be empty while a next page remains. The panel
shows the source title/URL, identifier field/version, locator/quote, confidence,
reliability, role, and review state, with loading/error/empty states.
Local evidence: all 33 real-PostgreSQL identifier provenance tests and 1,528
unit tests pass, including the focused panel tests; formatting, lint, typecheck,
schema/migration checks, and the production build pass. Generated artifacts
were refreshed. Protected citation storage, historical-version readback,
authoring UI, hosted acceptance, and whole-profile browser/accessibility
coverage remain open; HUM-FR-010/HUM-FR-028 remain incomplete.

Field-level provenance checkpoint (2026-09-13): evidence assertions now accept
an optional normalized `fieldPath` and expose it through the generated
GraphQL assertion mutation. PostgreSQL migration `0051` bounds the stored path
to 256 bytes and rejects control characters; service validation trims the path
before the audited, workspace-scoped assertion write. This allows citations to
address profile fields and nested fields without weakening legacy resource,
review, confidence, sensitivity, or redaction behavior. Focused unit
normalization and live-when-configured PostgreSQL persistence coverage are
included; source-to-field authoring UX, live migration execution outside CI,
and the whole-product provenance matrix remain open.

The deployment was built from the current `main` tree after the latest
documentation-only commit. Vercel's manual deployment metadata does not expose
a Git SHA, so the local commit and Ready deployment ID are recorded together;
this is not treated as a replacement for authenticated/provider acceptance.

Bounded production smoke contract evidence (2026-09-13): the opt-in
authenticated smoke now requires the configured `ADMIN_EMAIL`,
`ADMIN_USERNAME`, and `ADMIN_PASSWORD`, then signs in through both email and
username endpoints and verifies a workspace viewer before creating the
synthetic record. Focused `tests/unit/production-readiness-contract.test.ts`
passes and the harness remains redacted. This strengthens local acceptance
coverage only; hosted credentials, attended rotation/recovery, and external
provider contracts remain open.

Bounded hosted-transport configuration evidence (2026-09-13): production
Vercel configuration now fails closed unless `DATABASE_URL` explicitly
requests PostgreSQL TLS (`sslmode=require`, `verify-ca`, or `verify-full`) and
`REDIS_URL` uses `rediss://`. The private Docker deployment remains allowed to
use its internal `postgres` and `redis` network without TLS. Focused
`tests/unit/env.test.ts` coverage passes without inspecting or exposing any
credential material; Neon/Upstash reachability and external provider lifecycle
acceptance still require an operator-run environment.

Hosted authentication probe (2026-09-13): the redacted smoke harness was run
with the operator-controlled ignored `.env` parsed through dotenv (not shell
evaluation) and injected without printing values. Public routes/readiness
passed, but email sign-in returned `403 AUTH_REQUEST_FAILED`. This is an
unsuccessful credentialed probe rather than a diagnosis of the password or
database; an attended rotation with the hosted `DATABASE_URL` and `ADMIN_*`
values remains required.

Bounded administrator review UI evidence (2026-09-13): owner/admin users now
have `/settings/break-glass`, backed by the generated workspace-scoped query
and versioned approve/reject/revoke mutations. The surface requires a
20-character review reason, renders explicit resource kind/UUID pairs, and
refreshes after each decision without weakening the service's independent
review, idempotency, expiry, or audit boundaries. Focused component/navigation
tests and the production build pass. Universal ordinary profile-read logging,
hosted/provider acceptance, and the complete privacy/audit matrix remain open.

Latest release evidence (2026-09-13): clean `main` commit `f74c82a` is pushed
to GitHub. GitHub Actions run `34751719602` passed all nine jobs, including
the real PostgreSQL matrix and browser acceptance. Vercel deployment
`dpl_A5jgMwiP6CqAdjZxHaLsGCZZfPsX` is `READY`, aliased to
`humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. Fresh public smoke passed homepage,
liveness, readiness with PostgreSQL/Redis/storage, and unauthenticated
GraphQL. Hosted credentialed authentication/person creation and external
provider-contract acceptance remain open because protected Vercel secrets
were not exported for an attended administrator rotation.

Bounded fact-citation strength evidence (2026-09-13): the rich-profile audit of
HUM-FR-008/009/012/013/015/016/028 found that signed fact-evidence support
strength was already constrained in PostgreSQL, validated by the authorized
workspace-scoped evidence service, and exposed through bounded generated
GraphQL, but the evidence form hardcoded `0.5` and the profile discarded the
stored value. The evidence form now accepts an explicit value from -1
(strongest contradiction) through 0 (neutral context) to 1 (strongest support),
and fact cards show the signed percentage beside the authorized citation. The
display does not change or infer the fact's state, review state, confidence, or
presentation selection. Focused form/profile and live generated-GraphQL tests
cover authoring and readback. This closes only that field-level provenance
acceptance gap; HUM-FR-028 and the broader hosted/accessibility matrix remain
incomplete.

Merged closeout tranche (2026-09-13): commits `56d276e`, `19a0a77`, and
`b062fdb` are integrated on `main`. Clean-tree Node 24 gates pass (186 unit
files/1,421 tests, format, lint, typecheck, Drizzle check/drift, generated
GraphQL drift, and production build). The tranche adds signed citation
support-strength display/authoring, stale-retention-policy fail-closed
fencing, and durable principal-bound person-file attach/archive replay.
Focused disposable-PostgreSQL suites and independent reviews pass. Deployment
`dpl_HZhpCKissKs3Ei3KuP8icFBgS3eh` is `READY`; public smoke passes homepage,
liveness, readiness, unauthenticated GraphQL, and protected jobs. Authenticated
hosted smoke remains open (`403`) because the sensitive production database URL
is not retrievable through Vercel CLI for the attended admin-password rotation.
Do not mark hosted authentication/provider rows complete until an operator
performs that rotation with the production URL kept out of logs and source.

Latest production deployment (2026-09-13): the fully verified `main` tree at
commit `d369a50` was deployed directly to Vercel as
`dpl_7sws8qdPjuQj1tuT8n7J85RzyrJo` (`READY`) with aliases
`humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. Custom-domain smoke returned homepage `200`,
liveness `200`, readiness `200` with PostgreSQL/Redis/storage healthy, and
unauthenticated GraphQL `401` with a stable request ID. The deployment's
temporary URL is Vercel-protected; the custom-domain result is the public
runtime evidence. The 24 incomplete requirement rows below remain open.

Bounded HUM-FR-028/HUM-NFR-009 local profile-editor evidence (2026-09-13):
`tests/e2e/profile-records.spec.ts` exercises authenticated creation of multiple
fictional names and a dated timeline event, keyboard update/archive, persisted
generated GraphQL reads and reloads, read-only viewer controls, and a foreign
workspace's unavailable-record page with no record content in the streamed
payload. Desktop, 390px mobile, and RTL/200% CSS-zoom axe/reflow assertions
include long unbroken names/event titles and open edit forms. The test exposed
and fixes page-wide mobile overflow in name/event rows by allowing content and
action controls to wrap. Existing facts/relationships/evidence/notes/contacts/
files suites are not replaced. This is local Chromium evidence; hosted and
whole-product accessibility acceptance remain open, as do both requirements.

Latest verified application runtime checkpoint (2026-09-13): commit `39f4728`
passed GitHub Actions run `34740356099` with all 9 required jobs successful:
PostgreSQL integration, browser acceptance (38 passed, 3 skipped), production
build, generated drift, quality, Compose lifecycle, image security, dependency
policy, and secret scanning. Vercel deployment
`dpl_GqTM1W9UR68rRfk7vAvYgPyeXpJS` is `READY`, serves
`humans.kevinbytes.com`, and Vercel metadata identifies GitHub SHA `379f177`
(`docs: record person idempotency upgrade bridge`), whose runtime parent is
`39f4728`. The redacted production smoke passed homepage, liveness,
readiness, unauthenticated GraphQL, and protected jobs. Live direct-route
method checks passed against the alias (DELETE jobs 405, OPTIONS storage 204,
PATCH GraphQL 405), each with a correlation ID and `private, no-store`.
Hosted authenticated/provider acceptance and the 24 rows below remain open.

Bounded relationship provenance evidence (2026-09-13, commit `88ecf4c`): the
generated `PersonRelationships` query and profile cards now expose an
authorized, cursor-paginated first page of relationship evidence with source
title/citation, locator/page, assertion role, and explicit redacted/empty
states. Documentation labels still depend on the relationship review state;
evidence counts are not treated as proof. Focused component and live-service
tests pass. This narrows but does not close HUM-FR-023/HUM-FR-028 or the full
hosted/provider/accessibility matrix.

Bounded rich-profile and temporal-graph contract audit (2026-09-14): aliases,
biography, contacts, dated addresses, identifiers, and notes remain on their
workspace-authorized dedicated records; pronouns, employment, education,
languages, organizations, and custom fields use the catalog-backed fact path
with temporal, review, sensitivity, revision, and evidence controls. Directed
relationships already preserve source/target direction, temporal bounds,
creation method, review state, and the documented-versus-analyst-hypothesis
distinction. The smallest concrete readback gap was relationship evidence:
generated `RelationshipEvidence` pagination now lets the profile traverse every
authorized evidence page instead of stopping after its one-item preview, while
preserving explicit hypothesis/documented labels. Focused component coverage
proves the accessible pagination and generated-operation request; the
live-when-configured PostgreSQL authorization test now also proves that a
relationship-read-only API key cannot traverse evidence or disclose source
metadata. Existing-workspace fact-catalog backfill, protected identifier
citations, relationship-evidence authoring, and the whole hosted/browser matrix
remain open.

Bounded relationship epistemic-status evidence (2026-09-14): migration
`0052_core.sql` changes only the default for future edges to
`analyst_hypothesis`; it deliberately does not rewrite historical rows. A new
edge cannot claim `documented`. Promoting a hypothesis requires explicit
confirmation and the same workspace/case/purpose/resource/version-bound,
independently reviewed supporting assertion; the promotion updates epistemic
and review state atomically with one redacted relationship audit. Focused
PostgreSQL acceptance covers omitted/default status, documented-create
rejection, missing/unreviewed/contradictory/foreign/stale evidence, concurrent
promotion, and consent withdrawal; the relationship form exposes only the
truthful hypothesis default. Full hosted/provider and whole-product acceptance
remain open.

Bounded temporal fact authoring evidence (2026-09-13, commits `afd2525`,
`ef96dbc`, `39b26aa`, `9d978a7`, `68ad246`): the fact form now captures
temporal semantics/precision, valid-from/valid-until bounds, observed-at,
confidence method and explanation, language, and a workspace/person-scoped
superseded-fact link. Client and service validation agree on interval and
YEAR_ONLY calendar boundaries, browser-local date inputs normalize
deterministically, and accepted/review transitions require an independent
owner/administrator or reviewer bound to the latest revision author. Focused
fact-form/governance tests and independent review pass; broader field-level
provenance, hosted/provider, accessibility, and whole-product matrices remain
open.

The historical `HUM-FR-035`/`HUM-NFR-018` entries below are superseded for
deployment identity by `dpl_GqTM1W9UR68rRfk7vAvYgPyeXpJS` (READY, custom-domain
aliases), whose Vercel Git metadata points to `379f177` and includes runtime
commit `39f4728` after CI run `34740356099`.
Public smoke and direct method-boundary probes passed; hosted authenticated,
provider, and full-matrix acceptance remain open.

Bounded HUM-FR-032 direct-route evidence (2026-09-13): all 10 API route modules are inventoried by a 43-case method-boundary suite. Unsupported standard methods now return stable correlated 405 responses with explicit `Allow` and `private, no-store`; HEAD denials and OPTIONS remain bodyless, GraphQL retains its own error shape and origin-aware preflight, and the other OPTIONS responses do not grant CORS or initialize providers. Jobs now return a JSON method-denial code, health and jobs responses use the private cache policy, and readiness failures add `PROVIDER_UNAVAILABLE` without dependency details. Twelve direct-account input/authentication-boundary cases prove malformed JSON, schema rejection, origin denial, and API-key denial before mutation; existing route-specific failure codes are preserved. The auth delegate boundary additionally normalizes an unexpected delegated 503 into the stable `AUTH_REQUEST_FAILED` envelope with validated body/header correlation and `private, no-store`. The focused route suite passes 122 tests in this checkout. This is local handler evidence, not hosted/provider or whole-product failure-matrix closure; HUM-FR-032 remains incomplete.

Local production-build route verification for this tranche: Next.js 16.3.4 built successfully with Node 24; a loopback-only standalone server (`node .next/standalone/server.js`) returned the expected status, request header/body correlation, and private cache policy for all 42 applicable method-denial/OPTIONS responses across the 10 routes. HEAD and OPTIONS bodies were empty. This does not verify hosted dependencies or authenticated user journeys.

Latest application runtime checkpoint (2026-09-13): commit `ae1c5fd`
passed GitHub Actions run `34726668384` across all 9 checks, including the live
PostgreSQL, browser, Compose, generated-drift, security, and production-build
gates. Vercel deployment `dpl_2FFei2EMHYQMdyoZCHpAXGxqWAfh` reached `READY`
and serves `humans.kevinbytes.com`. The redacted production smoke passed the
homepage, liveness, readiness, unauthenticated GraphQL, and protected jobs
boundaries. Hosted authenticated/provider acceptance and the 24 rows below
remain open.

The reviewed research-assignment queue browser tranche is included in `ae1c5fd`:
the protected case workspace has a generated-GraphQL-only, 25-row queue panel
with status/kind filters, create/assign/transition/escalate controls, optimistic
versions, idempotency keys, stale-case response fencing, and explicit null
unassignment. Focused component coverage and the CI browser gate pass; the
broader authenticated hosted/provider acceptance remains open.

Latest verified release checkpoint (2026-09-12): commit `a813d97` passed GitHub
Actions run `34715018651` across all 9 checks. The exact tree was rebuilt and
started with the local PostgreSQL/Redis/MinIO Compose stack; `/api/health/ready`
returned `status: ready` with all four dependencies healthy. Vercel deployment
`dpl_DL5DrysnSWdiXDU6usswr9SqFaoH` reached `READY` and is the deployment served
by `humans.kevinbytes.com`. The redacted public smoke passed `/`, liveness,
readiness, unauthenticated GraphQL, and the protected jobs boundary. This
supersedes the older deployment IDs below for release evidence; authenticated
hosted sign-in/create-person and external-provider acceptance remain open.

Current repository gate (2026-09-12): commit `32124fb` passed GitHub Actions
run `34713181339` across all 9 checks, including the Node 24 PostgreSQL/Redis/
MinIO integration seam, browser acceptance, production build, generated drift,
Compose lifecycle, quality, image security, dependency policy, and secret
scanning. The gate includes privacy-request, retention/legal-hold,
relationship-provenance, AI-review, and guarded rich synthetic-seed contracts.
Hosted authenticated/provider/runtime proof and the remaining incomplete rows
below remain open.

Current production-closeout checkpoint (2026-09-12): application commit
`32124fb`; GitHub Actions run `34713181339` is green across all 9 checks,
including PostgreSQL/Redis/MinIO integration, browser acceptance, production
build, generated drift, Compose lifecycle, quality, image security, dependency
policy, and secret scanning. The graph accessibility, retention candidate queue,
case idempotency, provider-boundary, evidence-assertion replay, and storage
failure-boundary changes are included in this verified tree. Vercel
production deployment `dpl_6dHVPJX5k44mG2mdPGecnoKtjHaj` is Ready with the
`humans.kevinbytes.com` alias. Fresh public smoke confirms homepage, liveness,
readiness, PostgreSQL, Redis, storage, unauthenticated GraphQL, and invalid-
bearer jobs boundaries. Local Compose migrations, isolated administrator
bootstrap from the documented `.env`, and app readiness through PostgreSQL,
Redis, and MinIO were also exercised. Keep the remaining hosted authenticated/provider,
external-erasure-adapter, and measured whole-product rows open until their
stated evidence exists.

Integrated hardening in `e91e70e`, `be9dbd9`, and `d64a495` adds provider-safe
endpoint validation, durable evidence-assertion replay protection, and
correlated redacted storage initialization failure recovery. These changes are
covered by the green CI run above; they narrow the remaining gaps but do not
close hosted provider/authentication or whole-product matrix rows.

Production-completion privacy artifact checkpoint (2026-09-12): commits `bf00b35`,
`8e3e10e`, `fe71a43`, and `b7c9e6f` now cover person-scoped AI/web-research
artifact discovery, child/run/thread legal-hold fencing, private-thread and
parent-person visibility, assistant-response lineage, and fail-closed handling
for ambiguous legacy assistant messages. Focused unit/schema/type/lint/drift
checks pass; live PostgreSQL migration and worker/deletion execution remain a
release gate because `TEST_DATABASE_URL` is not configured. External provider
propagation and hosted/browser evidence remain open. Do not remove the privacy
backlog rows or mark HUM-FR-005/HUM-FR-023 complete until that live evidence is
captured.

Production-completion Task 1 local checkpoint (2026-09-11): durable export
approval records bind one requester to the exact workspace, purpose, optional case,
redaction profile, deterministic preview hash, and expiry. Independent owner/admin
or assigned case review is versioned and replay-safe, and governed commit now
requires the matching non-expired approved record after validating its signed
preview token. Current reviewer authority is checked before state/version/expiry
disclosure and rechecked on idempotent replay. The evidence workspace consumes the
generated preview/request/review/commit operations and exposes a current-role-scoped
pending queue; its UI carries the exact preview fingerprint and renders metadata,
not exported values. Focused unit/component/schema tests pass, including removed,
inactive, and demoted reviewer scope plus fail-closed commit. The expanded
PostgreSQL/GraphQL replay and rollback lifecycle suite is present but gated because
`TEST_DATABASE_URL` is absent. No requirement row is closed. Live migration,
object-store, browser, and provider proof, stale-artifact reconciliation, retention
cleanup, administrator review UI, and the remaining whole-product matrix remain
open.

Bounded bulk-export alert checkpoint (2026-09-13): a fixed 100-row threshold
now appends one immutable `export.bulk_alert` in the same transaction that first
commits a governed export artifact to `ready`. Its allowlisted metadata contains
only row count, threshold, redaction profile, and a case-scoped boolean. Focused
redaction and disposable PostgreSQL/object-store lifecycle tests cover exact and
below-threshold exports, interrupted recovery, ready replay deduplication,
restricted case exports, workspace fencing, immutability, and absence of query,
identity, source, object-key, and byte leakage. Bulk-query alerts, break-glass
access, administrator review, hosted-provider evidence, and the full audit and
privacy matrices remain open, so `HUM-NFR-007` stays incomplete.

Whole-query bulk-query alert checkpoint (2026-09-13): authorized text search
now computes the complete visible, deduplicated result count in a SQL CTE
before cursor filtering, while protected exact lookup counts distinct visible
people in a counted subquery before pagination. The fixed 100-row threshold
therefore alerts on the whole authorized query, including when a later cursor
page is requested, rather than on a single page. A transaction advisory lock
makes the check-and-insert deterministic across concurrent identical requests,
retries, and pagination. The event stores only an opaque deterministic UUID,
the whole-query count, threshold, query mode, count scope, and page indicator;
query text, protected exact values, filters, identities, and source identifiers
are not retained. Focused unit/redaction tests and the disposable PostgreSQL
GraphQL lifecycle suite cover count-before-cursor behavior, threshold crossing,
replay deduplication, workspace isolation, protected exact lookup, and
redaction. Administrator review, hosted-provider proof, and the complete
audit/privacy matrix remain open.

Bounded break-glass access checkpoint (2026-09-13): workspace-scoped,
principal-bound exceptional-access requests now require a purpose, a 20–4,000
character justification, an enumerated resource kind/UUID list, and an expiry
of no more than seven days. Only a different owner/administrator can approve
or revoke a request; API-key actors cannot use the path. Optimistic versions,
idempotent request/review/revoke mutations, approved-grant visibility, expiry,
revocation, and redacted request/review/revoke/use audits are covered by the
focused validation and disposable PostgreSQL GraphQL lifecycle tests. The
workflow is intentionally time-limited and does not bypass ordinary workspace,
case, purpose, consent, sensitivity, or redaction checks. Universal read-access
audit coverage, hosted/provider acceptance, and the
complete audit/privacy matrix remain open.

Task 6 bounded analysis/import/export checkpoint (2026-09-11): governed timeline,
source-comparison, duplicate, contradiction and descriptive graph analysis now
apply workspace, sensitivity, temporal, reliability, review and relationship
facets with redaction explanations. The GraphQL analysis projection now reads real
authorized metadata, membership-scoped case links and source reliability; directed
degree counts unique relationship edges. Facets operate on a bounded search sample,
not workspace-wide totals. Purpose-specific consent-status facets, fact-to-source
comparison joins and live PostgreSQL proof remain open. Non-public fact values and
context remain withheld. CSV/JSON/document import previews
validate mappings, flag duplicates without merging, preserve provenance defaults and
issue expiring scope-bound commit tokens. Export previews redact by sensitivity and
preserve provenance manifests. API-key scope, tenant, expiry, revocation and rate
decisions are covered by focused tests. No requirement row is closed: durable
import/export execution, database-backed facet aggregation, bulk/break-glass audit
records, key last-used/rotation/session integration, and live provider/database/
object-storage/browser evidence remain open.

Task 6 security/export hardening checkpoint (2026-09-11): import commit tokens now
use an explicit non-secret payload allow-list and reject unexpected claims. Export
previews preserve effective search-row sensitivity, evaluate every relationship
endpoint and fact field definition, require case resource links for case-scoped
exports, and retain subject coverage metadata with the generated artifact. Export
downloads re-check artifact state/expiry, case membership, legal holds and current
purpose coverage; governed files are excluded from ordinary file listings. Search
withholds non-public typed fact values when no purpose-bound approval is available,
and high-sensitivity export commits now fail closed against an independent,
non-expired approval for the exact deterministic preview. Governed export artifacts
retain a durable writing/failed state and
the same idempotency-bound commit can safely replay the deterministic
object-store write after a process crash or provider timeout; concurrent retries
reconcile to the single ready artifact. These are hardening changes, not closed
requirement rows: automated stale-artifact reconciliation, retention cleanup, live
PostgreSQL/object-store/browser proof and the remaining
whole-product matrix remain open.

Import staging recovery checkpoint (2026-09-12): a storage read failure during
preparation now atomically removes staged rows, records a redacted
`import.staging_failed` audit event with a stable failure code, and returns the
existing provider-unavailable error without persisting provider details. The
same principal/workspace-bound preparation key can reclaim that failed staging
record after storage recovers; the recovery is auditable as
`import.staging_recovered`. Focused live PostgreSQL coverage passes in
`tests/integration/imports-api.test.ts`; external object-store, browser, and
whole import/export acceptance remain open.

Task 5 follow-up: non-public fact values/provenance/temporal context and selection
actions are withheld until request-bound field disclosure is implemented. The Privacy
Requests panel shows person retention/hold metadata and authorized request-ID lookup,
and now provides person-scoped request creation with an explicit type, purpose, due
date, generated idempotency key, and safe success/error states through the existing
authorized GraphQL mutation. Full CRUD, person-filtered request listing, and
request-bound field disclosure remain pending.
The remaining HUM-FR-005/HUM-NFR-011/HUM-NFR-012 work still requires a complete audit
of overview/contact/file/graph and other surfaces, field-scoped disclosure tests,
and authenticated backend/hosted evidence. No acceptance row is closed.

Task 5 person-request UI checkpoint (2026-09-12):
`tests/unit/person-privacy-panel.test.tsx` passes four focused tests covering
person-scoped variables, purpose/deadline capture, opaque idempotency-key generation,
and secret-free creation failure handling alongside the existing posture and lookup
tests. The UI does not approve, fulfill, lift holds, or claim processor completion;
the server remains authoritative for workspace scope, deadlines, purpose coverage,
and audited lifecycle transitions. No privacy requirement row is closed.

Task 5 bounded UI checkpoint (2026-09-11): explicit-purpose person consent checks,
authorized case timelines, fact sensitivity/review context and graph evidence-state
presentation have focused component tests. No existing requirement row is closed.
Remaining HUM-FR-005/HUM-NFR-011/HUM-NFR-012 work includes full consent/privacy/hold
and case CRUD UI, per-field coverage, graph source/case metadata, export previews,
legacy backfill, target-environment migrations and hosted authenticated acceptance.
The targeted consent/AI browser run could not collect tests because
`TEST_DATABASE_URL` was absent; this is not browser acceptance evidence.
See `docs/operations/consent-governance.md`.

Task 4 local checkpoint (2026-09-11): generalized access/correction/export/restriction/consent-withdrawal/deletion requests have bounded scope, deadlines, material-bound creation replay, independent approval with verification evidence, optimistic transitions, and evidence-required completion. Generated GraphQL operations expose requests, processor outcomes, deterministic retention evaluation, and governed legal holds. Existing deletion records remain readable; new deletion fulfillment only queues the legal-hold-fenced worker. A bounded propagation worker records retryable failures when provider adapters are unavailable and checks actual file-cleanup completion. Live database lifecycle/migration execution, external search/cache/email/AI-provider propagation adapters, the complete retention-policy worker matrix, legacy-settings-path convergence, and browser acceptance remain open. No overall privacy requirement is newly checked.

Task 1 retention-worker checkpoint (2026-09-12): the shared worker now scans active soft-delete policies for expired, workspace-scoped people and files and queues deterministic, HMAC-bound privacy deletion requests in `requested` state. Candidate planning is exact at the retention boundary, skips active legal holds under the same workspace advisory lock used by hold/deletion mutations, and records a redacted queue audit; independent review and the existing deletion worker remain required before mutation. Focused unit coverage passes; the complete retention matrix, external propagation, and hosted evidence remain open.

Task 3 retention queue follow-up (2026-09-12): active legal holds are excluded
before the people/file candidate page limit, preventing held oldest rows from
starving later expired resources. Disposable PostgreSQL 17 integration tests
prove bounded one-record batches for both resource kinds, deterministic retry
deduplication, pending-review-only requests, unchanged resource versions and
deletion timestamps, redacted queue audits, and queue eligibility after an
independent hold release. This closes only the local candidate-selection
execution gap; no overall privacy requirement is checked. The complete
retention-policy matrix, concurrent policy-update revalidation, external
processor erasure, and hosted/browser acceptance remain open.

Task 1 retention-policy revalidation checkpoint (2026-09-13): after taking the
same workspace advisory lock used by policy mutations, the retention worker
re-reads and row-locks the policy and compares its version, resource kind,
interval, deletion behavior, and active state with the initial snapshot. A
stale, changed, or deleted policy is skipped so it cannot enqueue a request
under obsolete semantics. Focused unit coverage proves unchanged snapshots are
accepted and version/configuration/deletion changes fail closed. This is a
local race hardening measure, not live PostgreSQL/worker, external processor,
hosted, or browser evidence; HUM-FR-005 and the complete retention matrix
remain open.

Retention capability-matrix checkpoint (2026-09-14): retention evaluation and
candidate planning now share an explicit capability matrix. Only the implemented
workspace-scoped, legal-hold-fenced person/file `soft_delete` path can become an
`eligible_for_deletion` candidate; unsupported resource kinds, including AI
artifacts, remain `review_required` and are excluded from worker queue scans.
The exact expiry boundary, legal-hold precedence, supported person/file paths,
and unsupported policy-kind fail-closed behavior have focused unit coverage and
a gated PostgreSQL integration check. Hard-delete, anonymization, durable
review disposition, external propagation, and hosted/browser acceptance remain
intentionally open; this bounded checkpoint does not close `HUM-FR-005` or the
complete retention-policy matrix.

Governed retention-action checkpoint (2026-09-14): approved deletion requests
now re-read the workspace policy under the existing advisory lock before any
resource mutation. `hard_delete` and `anonymize` actions are accepted into the
durable review/fulfillment boundary only far enough to be explicitly rejected
with a redacted immutable audit event because no current resource kind has a
safe, provenance-preserving executor. Active legal holds, unavailable scopes,
stale worker policy snapshots, workspace boundaries, and repeat execution remain
fenced; soft-delete behavior and processor propagation are unchanged. Focused
coverage includes hard-delete/anonymize rejection and unchanged person state.
No hard-delete or anonymization requirement is marked complete.

Task 3 local checkpoint (2026-09-11): the AI review ledger preserves typed proposals, evidence or validated web-source snapshots, confidence/uncertainty, run/provider/model/prompt-policy attribution, and explicit accept/reject/defer decisions. The person research panel uses generated review mutations instead of direct AI-driven profile updates. Acceptance requires current AI/write purpose coverage, case/resource visibility, human confirmation, and an owned completed source run; fact/relationship acceptance uses domain services and evidence assertions in one transaction. Batch acceptance is explicitly approved and atomic; AI-created relationships remain inferred until the existing independent assertion review permits promotion. Local unit/build/schema gates are required before commit. Live PostgreSQL lifecycle, browser and provider verification remain pending when the test database/provider is unavailable; this does not close HUM-FR-023 or the overall MVP.

Catalog-backed web-fact checkpoint (2026-09-13): consented person web research may now propose active workspace text fact definitions (for example employment, education, language, organization, or a workspace custom text field) in addition to profile fields. The provider receives only bounded catalog metadata and validated public sources; a proposal is rejected unless its definition UUID came from that catalog and its cited URLs are immutable run snapshots. Fact proposals remain pending in the same independent human accept/reject/defer queue, and acceptance creates a regular `human_reviewed_ai` fact while retaining the originating run and source snapshots. Date, JSON, sensitive/contact/address/identifier fields and web-derived relationships remain excluded. Focused unit coverage is present; live provider, browser, retention, and source-to-evidence-assertion matrix evidence remains open, so HUM-FR-023 stays incomplete.

Accepted-history checkpoint (2026-09-13): reviewed AI suggestions are now discoverable from the person research panel through a generated, permission-gated GraphQL connection scoped to the active workspace, person, governed purpose, and optional case. The bounded newest-first page exposes only immutable acceptance metadata, accepted resource references, and access-checked evidence projections; inaccessible workspace evidence is represented explicitly as redacted, while pending and deferred suggestions remain confined to the review queue. Focused live PostgreSQL service and generated-GraphQL tests plus component tests cover status/purpose separation, tenant denial, cursor pagination, evidence redaction, and empty/redacted UI states. Hosted-provider and whole-product accessibility evidence remain open, so HUM-FR-023 is still incomplete.

Pre-provider person-research reauthorization checkpoint (2026-09-13): after
the asynchronous search/catalog boundary, person web research reloads the
workspace-scoped person, reruns purpose/consent authorization, and builds the
provider projection from that current row. Missing, foreign, deleted, and
restricted rows or withdrawn `ai_operation` authority stop before provider or
persistence; a public-to-internal change omits stale biography and alternate
names. Deterministic unit cases and a disposable PostgreSQL GraphQL race test
that changes sensitivity in the injected search callback prove closed
non-disclosure and no run/source provenance rows. This does not make the
network send atomic with a revocation after that final check, and it does not
close HUM-FR-023, HUM-NFR-004, hosted provider, or broader browser evidence.

Source provenance checkpoint (2026-09-12): source records now expose first-class
publication timestamp, collector, and extraction method fields, plus an
append-only workspace-scoped custody ledger with collected/verified/transferred/
accessed/redacted events. GraphQL exposes authorized custody reads and writes;
source creation records the initial collection event. Focused migration/schema,
service, GraphQL, seed, and immutability contract tests pass. Live migration,
provider, and hosted evidence remain open; this checkpoint does not close the
whole evidence/provenance requirement.

The usable self-hosted alpha and MVP release-candidate boundary is documented in
`docs/releases/SELF_HOSTED_ALPHA.md`. Every incomplete requirement is listed
exactly once below. Full MVP completion still requires the full current matrix
and the release evidence required by `HUM-NFR-018`; the alpha label does not
reclassify any design requirement as post-MVP. Remove an item only in the same
change that updates `docs/REQUIREMENTS.md` to **Complete** and records passing
test or runtime evidence.

Release evidence (2026-09-07): GitHub Actions run `34175736114` for commit
`6986c6e` passed the complete repository gate, including quality, generated
artifacts, production build, PostgreSQL/Redis/MinIO integration, Compose
lifecycle, image security, secret scan, dependency policy, and the 22-test
Chromium browser acceptance suite. This closes the recent CI/browser
regression tranche but does not close the broader incomplete requirements
below, which still require hosted/provider and whole-product evidence.

Latest repository gate (2026-09-08): GitHub Actions run `34241537402` for
commit `f795ede` passed all 9 checks, including the invitation Chromium flow,
real PostgreSQL integration, Compose lifecycle, production build, quality,
generated-artifact drift, dependency policy, image security, and secret
scanning.

Current repository gate (2026-09-08): GitHub Actions run `34244546526` for
commit `30403a7` passed all 9 checks, including the Redis-restart readiness
recovery regression, invitation Chromium flow, real PostgreSQL integration,
Compose lifecycle, production build, quality, generated-artifact drift,
dependency policy, image security, and secret scanning.

Latest repository gate (2026-09-08): GitHub Actions run `34247133041` for
commit `c23ce86` passed all 9 checks, including the new reconciliation browser
review journey, real PostgreSQL integration, Compose lifecycle, production
build, quality, generated-artifact drift, dependency policy, image security,
and secret scanning.

Current repository gate (2026-09-08): GitHub Actions run `34251787033` for
commit `996d774` passed all 9 checks, including configured administrator email
and username sign-in through the first-workspace gate, real PostgreSQL
integration, Compose lifecycle, production build, quality, generated-artifact
drift, dependency policy, image security, and secret scanning.

Latest repository gate (2026-09-08): GitHub Actions run `34253602490` for
commit `c3fcc3f` passed all 9 checks, including pending-invitation resend and
cancellation plus non-owner member removal in the Chromium browser suite, real
PostgreSQL integration, Compose lifecycle, production build, quality,
generated-artifact drift, dependency policy, image security, and secret
scanning.

Latest repository gate (2026-09-08): GitHub Actions run `34255295116` for
commit `adf1c56` passed all 9 checks, including the webhook redirect-fence
integration contract, real PostgreSQL integration, Compose lifecycle,
production build, quality, generated-artifact drift, dependency policy, image
security, and secret scanning.

Latest repository gate (2026-09-08): GitHub Actions run `34257740775` for
commit `cd4723d` passed all 9 checks, including live identity-candidate
generation, the Chromium browser suite, real PostgreSQL integration, Compose
lifecycle, production build, quality, generated-artifact drift, dependency
policy, image security, and secret scanning.

Latest repository gate (2026-09-08): GitHub Actions run `34259980544` for
commit `4916f10` passed after the failed browser job was rerun; all 9 checks
are green, including the protected identifier/contact/birth-date candidate
fixtures in the PostgreSQL seam and the full Chromium suite.

Latest repository gate (2026-09-08): GitHub Actions run `34270619540` passed
for commit `6ea16d6` with all 9 checks green, including the browser
review/merge/undo journey, timestamp-normalized reversible snapshots, real
PostgreSQL integration, Compose lifecycle, production build, generated drift,
dependency policy, image security, and secret scanning.

Current repository gate (2026-09-08): GitHub Actions run `34275425591` passed
for commit `70730b4` with all 9 checks green, including the local Compose
authentication/SSR fix, browser acceptance, real PostgreSQL integration,
Compose lifecycle, production build, generated drift, dependency policy,
image security, and secret scanning.

Current repository gate (2026-09-09): GitHub Actions run `34298190513` passed
for commit `f1ada49` with all 9 checks green, including the storage-proxy
correlation/stable-error contract, PostgreSQL/Redis integration, Compose
lifecycle, production build, browser acceptance, quality, generated drift,
dependency policy, image security, and secret scanning. Dependabot PR #120 was
closed after its Better Auth 1.7.2 branch failed the real Compose signup smoke
because the upgraded runtime requires an `accounts.issuer` field absent from
the current auth schema.

Current repository gate (2026-09-12): GitHub Actions run `34692740239` passed
all 9 checks for commit `eff1fe0`, including Node 24 quality, real PostgreSQL
integration (including the 7-test research-assignment lifecycle), browser
acceptance, Compose lifecycle, production build, generated drift, dependency
policy, image security, and secret scanning. The same commit is deployed to
Vercel production as Ready deployment `dpl_FNrJZUp8JaLCc2vcBA7zHAX2r5yR` with
the `humans.kevinbytes.com` alias. Current hosted authenticated/provider smoke
and the remaining incomplete requirements below are still open.

Latest hosted evidence (2026-09-08): the sign-in bootstrap, reconciliation
workspace, local-compose authentication fix, and member-table accessibility fix
are deployed to Vercel production as
`dpl_8rbBgB8mKSzupo8c15ADuYTN3LxD`; the custom hostname,
liveness, readiness, PostgreSQL/Redis/storage probes, unauthenticated GraphQL
boundary, and protected jobs boundary all passed the bounded smoke. A prior
Vercel production request log records repeated scheduled `/api/jobs/run`
requests as `200`; the new deployment's scheduled request is not yet
observed. That protected route now runs the configured `ADMIN_*` bootstrap
before the job batch. Authenticated sign-in/person creation and
external-provider acceptance remain open.

Latest local Compose evidence (2026-09-08): server-rendered GraphQL now uses an
internal `http://app:3000` target while preserving the public browser origin,
and loopback HTTP uses ordinary cookies by explicit Docker-only policy. After
rebuilding the current image, the live local stack passed sign-in, workspace
activation, person creation, and cleanup with PostgreSQL, Redis, and MinIO
healthy. Hosted authentication and the broader provider matrix remain open.

`HUM-FR-017` remains complete and intentionally absent: PostgreSQL integration
coverage includes the short-transaction upload-attempt fence, non-blocking
cancellation, late-object cleanup, successful completion, and lease-expiry
recovery.

## Functional

- [ ] `HUM-FR-003` Complete hosted release evidence and recovery acceptance for the implemented explicit, idempotent administrator bootstrap and separate operator password rotation.
- Bounded HUM-FR-003 local Compose evidence (2026-09-07): the isolated production-image smoke now runs administrator bootstrap three times across create, idempotent repeat, and deliberate credential deletion/recovery, then verifies exactly one credential before app startup. The protected Vercel cron now invokes the same validated bootstrap when all `ADMIN_*` values are configured; hosted authenticated sign-in and repeat/recovery proof remain open.
- Bounded HUM-FR-003 sign-in bootstrap evidence (2026-09-08): email and username sign-in requests now invoke the same idempotent configured-administrator bootstrap before Better Auth delegates, so a fresh hosted database does not require waiting for the first scheduled job. The route remains no-op when `ADMIN_*` is incomplete, blocks API-key interactive requests before bootstrap, and has ordering/correlation unit coverage; hosted credential acceptance and repeat/recovery proof remain open.
- Bounded HUM-FR-003 administrator browser evidence (2026-09-08): `tests/e2e/admin-bootstrap.spec.ts` proves the configured email and username credentials authenticate after a fresh database reset, and that the administrator can create/select the first workspace before reaching the dashboard. Hosted Vercel credential acceptance and repeat/recovery proof remain open.
- Bounded HUM-FR-003 operator recovery evidence (2026-09-09): `pnpm admin:rotate-password` is now a separate attended command that acquires the bootstrap advisory lock and replaces only the configured administrator's Better Auth credential hash; the default idempotent bootstrap and request-time bootstrap never rotate existing passwords. The attended entrypoints now require only `DATABASE_URL` and `ADMIN_*`, so a temporary 0600 recovery file can be sourced from Neon/secret management without exporting unrelated Vercel provider variables; plaintext protected/hidden Vercel values are never retrieved. Live hosted execution and mailbox/recovery acceptance remain open.
- [ ] `HUM-FR-004` Complete the recipient acceptance, administrator-role, resend/removal, responsive/RTL/zoom, provider-failure, and cancel/acceptance race matrix for the implemented workspace invitation and member-management boundary.
- Bounded HUM-FR-004 invitation lock-order evidence: acceptance now takes the same workspace advisory lock as administrative cancellation before invitation row locking; live PostgreSQL coverage proves cancellation-first completion without deadlock, `UNAVAILABLE` acceptance, and no membership side effect. External provider/browser and exhaustive role/recipient coverage remain open.
- Bounded HUM-FR-004 expired-invitation recovery evidence: the owner/admin settings control now offers `Re-invite` for expired invitations, reusing the audited issue flow so the expired row is replaced with a fresh, idempotent invitation; focused component coverage verifies the email/role handoff. External provider/browser and exhaustive role/recipient coverage remain open.
- Bounded HUM-FR-004 Chromium invitation evidence (2026-09-08): `tests/e2e/invitations.spec.ts` now drives verified recipients through the fragment-to-HTTP-only handoff and acceptance page for analyst and administrator roles, and drives the owner settings UI through expired-invitation reissue, pending resend/cancel, member removal, and responsive mobile, RTL, and 200% zoom checks without overflow. Provider-failure and cancellation/acceptance race coverage remain open.
- Bounded HUM-FR-004 administrator-role Chromium evidence (2026-09-08): the same invitation browser suite now accepts an owner-issued administrator invitation and verifies the recipient's workspace-scoped administrator membership. Provider-failure, removal/resend, responsive/RTL/zoom, and cancellation/acceptance race coverage remain open.
- Bounded HUM-FR-004 invitation lifecycle Chromium evidence (2026-09-08): the same suite now exercises owner resend and cancellation of a pending invitation plus removal of a non-owner member, then verifies the canceled invitation and removed membership in PostgreSQL. Provider failure, responsive/RTL/zoom, and cancellation/acceptance race coverage remain open.
- [ ] `HUM-FR-005` Complete live policy/grant/hold/deletion/consent acceptance, retention-worker enforcement, and the full role/resource matrix for the now-implemented audited mutation boundary.
- Bounded HUM-FR-005 deletion evidence: approved workspace-scoped person deletion requests now execute once in the worker with active legal-hold fencing, soft-delete/audit effects, search-index removal, and durable file-cleanup scheduling; retention-policy enforcement, hard-delete/anonymization behavior, and the full role/resource matrix remain open.
- [ ] `HUM-FR-010` Complete live identity-candidate, merge/unmerge, and conflict-matrix acceptance for the bounded reversible reconciliation workflow (live acceptance now covers colliding-tag preservation, loser-only tag and external-record movement, and reversible candidate fencing).
- Bounded HUM-FR-010 reconciliation UI evidence (2026-09-08): the protected `/reconciliation` workspace now loads workspace-scoped candidates with both person projections, exposes match signals and score, and supports permission-aware reviewing/rejecting/cancelling with bounded reasons, optimistic rollback, version checks, durable idempotency keys, and focused unit coverage. Accepted candidates now require an explicit canonical winner, bounded merge reason, and confirmation before invoking the audited GraphQL merge; the same UI exposes a version-fenced Undo merge action.
- Bounded HUM-FR-010 reconciliation browser evidence (2026-09-08): `tests/e2e/reconciliation.spec.ts` now proves an owner can inspect a seeded workspace candidate, review it as `ACCEPTED`, merge the selected people with explicit confirmation, verify the loser status/merge decision in PostgreSQL, undo the merge, and verify the candidate/loser restoration; the same journey proves a viewer can inspect but cannot change it. Broader conflict-matrix and hosted acceptance remain open.
- The same browser suite now includes a stale-view review case: two authorized pages load one candidate, the first commits an acceptance, and the second must surface `CONFLICT` without replacing the accepted database state. CI execution remains required before treating this as release evidence; the broader merge/unmerge and hosted conflict matrix remains open.
- Bounded HUM-FR-010 candidate-generation evidence (2026-09-08): `generateIdentityCandidates` now derives workspace-scoped candidates from normalized exact display, sort, and preferred-name matches plus protected identifier/contact blind-index and non-disproven birth-date agreement, without persisting raw protected values. It caps work at 100 pairs, serializes concurrent runs with a workspace advisory lock, fences duplicate pairs, supports principal-bound durable idempotency/replay, and records redacted creation audits. Broader fuzzy/weighted identity signals, merge/unmerge browser acceptance, and the full conflict matrix remain open.
- Bounded HUM-FR-010/HUM-FR-028 public-identifier profile evidence (2026-09-12): generated `PersonIdentifiers` exposes a paginated, workspace-scoped identifier projection on the person profile. The service applies person and `personIdentifier` visibility policies, returns issuer/type/validity/verification metadata, and only returns normalized values for records classified `public`. Protected storage internals never enter the projection. The 2026-09-13 authoring checkpoint above adds create/update/archive controls with local unit evidence; live database acceptance, source-level citations, and the broader reconciliation/conflict and whole-profile matrices remain open.
- Bounded HUM-FR-028 effective-dated address profile evidence (2026-09-12): generated `PersonAddresses` now carries stored address-association validity bounds and temporal precision into the existing workspace- and sensitivity-scoped profile projection. Address cards identify the association type and render a UTC-stable effective period without inventing day precision for year-only records. Focused component coverage and the live-when-configured generated GraphQL location matrix cover presentation, authorized readback, and foreign-workspace non-disclosure. Address-source presentation, the exhaustive location authorization/browser matrix, and whole-profile acceptance remain open.
- [ ] `HUM-FR-023` Complete workspace-policy-controlled restricted-prompt omission and the full retention-policy matrix beyond implemented AI-thread retention inheritance/purge, read-only tool allowlist, authorization checks, citation validation, and provider/model disclosure. Bounded person web research now provides explicit consent, safe bounded Brave/OpenAI-compatible provider handling, source-backed auto-filled editable drafts, per-field and accept-all review controls, an immutable workspace/person-scoped provenance snapshot with a generated run ID, and a Chromium acceptance journey for selective persistence. Accepted web citations now promote their persisted snapshots transactionally into source/custody/evidence/excerpt/field-level assertion chains, retain bounded run/provider/model/hash/time/purpose/reviewer provenance, and replay without duplicate chains. Live provider credentials, retention deletion/expiry coverage for research snapshots, and the remaining policy/provider matrix are still open.
- Bounded HUM-FR-023 person-hold retention evidence (2026-09-13): an active workspace-scoped legal hold on any `aiRuns.reviewPersonIds` member now fences AI-thread retention both in bounded candidate selection and in the authoritative recheck immediately before deletion. That recheck takes the workspace advisory lock shared by hold mutations, so a queued person hold wins the hold-versus-purge race. The live PostgreSQL matrix proves no deletion or purge audit while held, one redacted purge after independent release, and preservation of the existing direct child-artifact hold behavior. Provider, web-research snapshot, and complete retention-policy matrices remain open.
- [ ] `HUM-FR-024` Complete live webhook lifecycle, signed delivery, retry, destination-rebinding, and upgrade-migration acceptance beyond the implemented durable jobs and immutable audit records.
- Bounded HUM-FR-024 redirect-fence evidence (2026-09-08): webhook delivery now uses `redirect: "error"` after validating the public HTTPS target, and the live delivery contract asserts the request cannot follow a redirect into an unvalidated destination. DNS rebinding, external provider failure, and upgrade-migration acceptance remain open.
- Bounded HUM-FR-024 provider-boundary evidence (2026-09-12): Resend endpoint construction now fails closed for non-HTTP(S), credential-bearing, query, and fragment-bearing base URLs before any request; focused tests also preserve generic failure redaction and cancellation behavior. External delivery, signed webhook provider, and migration acceptance remain open.
- Bounded HUM-FR-024 lifecycle evidence: when a queued or retryable delivery's webhook is disabled, the worker now atomically terminalizes the delivery with a static redacted cancellation reason and clears its retry timestamp; the transition emits one immutable delivery-level audit event and duplicate jobs are side-effect free. Destination-rebinding, external provider failure, and upgrade-migration acceptance remain open.
- Bounded HUM-FR-024/HUM-NFR-008 webhook-administration evidence (2026-09-13): generated `createWebhook`, `rotateWebhookSecret`, and `disableWebhook` now accept optional principal-bound durable HMAC idempotency keys. Create and rotate return the webhook secret only to the transaction executor; replays are explicitly secretless. Rotate and disable require optimistic `expectedVersion` for keyed calls, and all replays recheck workspace, lifecycle, version, and actor-bound audit references. A 12-case live PostgreSQL integration matrix covers concurrent convergence, one-time secret presentation, malformed/changed material, stale version and replay fencing, tenant/principal isolation, encrypted secret storage, and redacted audit deduplication. The first executor uses its transaction-produced reference directly to avoid stranding a newly issued secret if a concurrent lifecycle mutation follows commit. External delivery/provider, DNS rebinding, migration, browser, and whole-domain retry matrices remain open; these rows stay incomplete.
- [ ] `HUM-FR-028` Complete names/reconciliation, timeline, person-file, and contradictory-fact profile workflows plus full accessibility acceptance beyond the implemented people search/create, overview edit, facts, relationships, evidence, notes, contacts, activity, and files surfaces. Bounded names/timeline pagination and truthful temporal-precision rendering, audited name/event CRUD with idempotent GraphQL mutations and profile edit/archive controls, contradictory-state rendering, workspace-scoped `Person.files` roles/pagination, verified primary-photo upload/attachment, audited/idempotent arbitrary file-to-person attach/detach, workspace-scoped person-reference fact picking, profile RTL/200% keyboard/axe evidence, confidence-aware person entry, reviewed AI-enrichment drafts, owner/viewer reconciliation browser coverage, and an accessible Evidence workspace extraction-history/request/cancel/retry control with permission-gated actions now exist; `tests/unit/file-extraction-controls.test.tsx` covers the generated-operation routing and read-only action boundary. The graph inspector now gives every returned relationship, including asserted/documented records, a keyboard-accessible path into the source profile's Relationships view without adding browser-side data access; focused unit and Chromium coverage exercise that transition. The whole-product visual matrix remains open.
- Bounded HUM-FR-028/HUM-NFR-009 focus evidence (2026-09-12): person-profile section links and the graph relationship/time filter disclosure now expose the same visible `:focus-visible` ring used by primary controls, while retaining semantic links and native disclosure keyboard activation. Focused Chromium assertions verify keyboard focus, the rendered focus ring, accessible checkbox labels after Enter activation, and the existing profile/graph RTL and 200%/400% no-overflow journey. Whole-product responsive and primary-journey acceptance remains open.
- [ ] `HUM-FR-029` Complete graph editing and performance acceptance beyond the existing explorer, accessible table fallback, and Task 12 snapshot/analysis/result/export controls. The React Flow neighborhood editor now routes relationship creation through an explicit review/`Confirm create` step, matching update/archive safety; focused unit and Chromium coverage prove no create write occurs before confirmation. Full editor breadth, performance, and provider/browser matrix remain open.
- Bounded HUM-FR-029 temporal-editor evidence (2026-09-13): the generated-GraphQL React Flow neighborhood editor now exposes temporal semantics, precision, and valid-from/valid-until fields for explicit create/update review. Unit coverage proves temporal create/update values are held without a write until confirmation, preserves exact untouched ISO instants, verifies browser-local datetime editing with seconds and milliseconds retained through ISO normalization, and covers confirmed clear/reset. `tests/e2e/graph.spec.ts` was authored to capture the authenticated browser create request carrying selected temporal fields, but the local invocation could not run because `TEST_DATABASE_URL` is not configured; database-backed CI or hosted execution remains required. Existing neighborhood caps, server-side authorization, consent/governance, optimistic versions, audit, and idempotency boundaries remain in force. Full editor breadth, mutation latency, render/FPS, hosted performance, and provider/browser matrices remain open.
- [ ] `HUM-FR-031` Complete mutable/provider administration beyond the Task 14A responsive read-only account, security, members, keys, policies, audit, and integrations settings routes. A focused live policy-settings matrix now covers owner access-policy success, administrator workspace-default success, viewer/foreign denial, optimistic retries, validation rollback, redacted audit output, and durable `UpdateAccessPolicy` plus `UpdateWorkspaceDefaults` replay/concurrency boundaries; provider and whole-settings coverage remain open.
- Bounded HUM-FR-031 integrations-settings evidence (2026-09-12): the administrator-only integrations read model now identifies local Redis versus Upstash REST and OpenAI/Ollama/OpenAI-compatible backends using static labels only; endpoints, credentials, and provider responses remain absent, and focused tests prove the page-level projection performs no network probes. Mutable provider settings and whole-settings acceptance remain open.
- [ ] `HUM-FR-032` Complete stable errors and request-correlation coverage across the whole MVP beyond the implemented Task 12 search/graph envelopes, centralized browser/server GraphQL error contract (including malformed-payload handling, header-authoritative IDs, and known-code secret-message normalization), and representative all-code/redaction matrix. Direct route codes are inventoried in `docs/ARCHITECTURE.md`; the scheduled `/api/jobs/run` route now emits stable `UNAUTHENTICATED`/`INTERNAL` codes with an `x-request-id`, the storage proxy now emits redacted stable upload/download/unmatched-path envelopes with correlated headers, storage route initialization/provider failures now use the same correlated redacted `INTERNAL` response and allowlisted `storage.infrastructure.failure` event, health probes now echo correlation IDs on success, and a typed direct-route client covers invitation handoff/acceptance and two-factor state changes. `tests/unit/storage-route-boundary.test.ts` proves secret-free initialization failure and retry recovery; adoption across every remaining direct route and the whole-product failure matrix remain open.
- Bounded HUM-FR-032/HUM-NFR-009 invitation failure evidence (2026-09-12): the invitation acceptance page now carries the typed direct-route `requestId` into its assertive `AuthStatus` alert for acceptance and workspace-activation failures, rendering a non-sensitive request reference that support can correlate without exposing provider or session details. Focused React coverage proves a 503 response's header/body correlation ID is announced in the accessible alert; whole-product direct-route and interruption coverage remains open.
- [ ] `HUM-FR-033` Complete whole-application failure evidence beyond the implemented dependency readiness, durable retries, worker heartbeat, bounded signal drain, live client/lease checks, and Compose-backed PostgreSQL/Redis outage checks. Storage route initialization/provider failures now fail closed with a correlated redacted response and retryable loader recovery (`tests/unit/storage-route-boundary.test.ts`); provider, browser, and interruption coverage remain open.
- Bounded HUM-FR-033 production-loader recovery evidence (2026-09-13): rejected application-initialization promises are evicted for GraphQL and Better Auth, and storage no longer retains a redundant rejected inner promise. The actual exported-route tests in `tests/unit/production-loader-recovery.test.ts` verify concurrent failed-attempt sharing, recovery on a later request, successful caching, retained unauthenticated/unsigned-request denials, and correlated redacted private/no-store errors. Requests and mutations are never replayed. Native ESM evaluation failures may still require a process restart or redeployment; hosted/provider outage and whole-application failure acceptance remain open.
- [ ] `HUM-FR-035` Complete the parity Vercel deployment path. The latest verified production deployment `dpl_FND3s4vZ9tLEoHBY5SNegNCG6HM8` is Ready and serves `humans.kevinbytes.com` from runtime commit `c739f4d`; production/preview R2 variables, Neon/Redis variables, and the configured AI/email variables remain managed by Vercel. A fresh public smoke against this deployment passed homepage, liveness, readiness with PostgreSQL/Redis/storage, unauthenticated GraphQL, and the protected jobs route; direct-route method probes also returned the expected 405/204 boundaries with correlation IDs and private cache policy. Authenticated sign-in/create-person acceptance and the full hosted provider matrix remain release work. The protected route invokes configured administrator bootstrap before jobs; ordinary request-time sign-in and jobs bootstrap are deliberately non-rotating, with password rotation available only through the attended operator command. The repository includes a redacted `pnpm production:smoke -- --base-url <selected-deployment>` harness with explicit authenticated/provider opt-ins; the protected Vercel CLI cannot export secret values for a local bootstrap command, so no plaintext hosted credentials were retrieved.
- Current bounded release evidence superseding the older deployment IDs: `dpl_HZhpCKissKs3Ei3KuP8icFBgS3eh` is `READY` with aliases `humans.kevinbytes.com`, `humans-dun.vercel.app`, and `humans-tkoresearch.vercel.app`; public smoke passed homepage/liveness/readiness/unauthenticated GraphQL/protected jobs. Authenticated smoke still returns `403 AUTH_REQUEST_FAILED` because Vercel's production `DATABASE_URL` is sensitive and unavailable to the CLI; hosted sign-in/provider acceptance remains open.
- Updated hosted parity evidence (2026-09-14): the reviewed `main` checkout was manually deployed as `dpl_4CRY2FAyMWF5ecengRVaE3qUYcuy` (`READY`) and aliased to `humans.kevinbytes.com`, `humans-dun.vercel.app`, and `humans-tkoresearch.vercel.app`. Public probes passed homepage/sign-in (200 with deployment marker), liveness (200), and readiness (200 with PostgreSQL/Redis/storage); all probes returned private/no-store and correlation headers. Vercel CLI did not expose a Git commit SHA for this manual deployment, but it was built from clean local `main` at `340df21`. Hosted authenticated sign-in, administrator bootstrap, and provider contract acceptance remain unverified because secrets are intentionally not exported.

- Production closeout refresh (2026-09-14): clean `main` commit `3247646` passed the complete GitHub Actions workflow `34860080141` ([run](https://github.com/KevinOBytes/humans/actions/runs/34860080141)), including the real PostgreSQL seam, required security/governance integration gate, privacy search propagation suite, browser acceptance, Compose lifecycle, production build, generated drift, dependency policy, secret scan, and pinned Trivy image scan. Vercel production deployment `dpl_FEbhCRY5vGYCqyEuCP7XSSTKZK8b` is `READY`, built with Node 24 and aliased to `humans.kevinbytes.com`, `humans-dun.vercel.app`, and `humans-tkoresearch.vercel.app`. Hosted authenticated sign-in/bootstrap, provider credential acceptance, and the whole-product privacy/accessibility/performance matrix still require attended operator evidence; no secret values are recorded here.
- Current CI evidence (2026-09-14): GitHub Actions run `34797630687` for pushed commit `340df21` passed all 9 jobs: PostgreSQL integration, browser acceptance, Compose lifecycle, production build, generated drift, quality, image security, dependency policy, and secret scanning. The aggregate local test command still has 26 stateful failures when every integration file shares one database in parallel; the required CI database matrix and all bounded acceptance suites pass, so hosted authenticated/provider proof and the remaining incomplete requirements stay open.

## Non-functional

- [ ] `HUM-NFR-002` Verify authoritative storage and provider adapter contracts, including external R2/generic-S3/Upstash acceptance. The bounded provider contract suite now exercises every RedisStore operation through local and Upstash-shaped adapters and signed S3-compatible lifecycle/isolation against CI MinIO; external Upstash REST and R2/generic-S3 runs require `RUN_EXTERNAL_PROVIDER_CONTRACTS=true` in addition to their provider credentials, preventing accidental use of production secrets. Adapter configuration now rejects non-HTTP(S)/credential-bearing storage endpoints, forces provider-safe R2 path-style behavior, and rejects non-Redis URLs before Upstash endpoint derivation. External R2/S3 lifecycle runs additionally fail closed before spawning their child suite or constructing a client unless a distinct application bucket and a dedicated `humans-contract-...` test bucket are supplied; stable errors do not disclose bucket, endpoint, or credential values, while local MinIO keeps its isolated default. The Cloudflare R2 `humans-private` bucket and Vercel credentials are configured and a direct put/head/delete lifecycle passed, while generic S3 and externally hosted Upstash/R2 acceptance remain required.
- Bounded HUM-NFR-002 configuration evidence (2026-09-12): token-bearing Redis configuration now requires `rediss:` and rejects path/query/fragment material before deriving the credential-free Upstash REST endpoint; focused provider tests cover local Redis, Upstash-shaped, MinIO, R2, generic S3, and redacted settings labels. External Upstash REST/R2/generic-S3 acceptance still requires explicit test credentials and remains unverified here.
- [ ] `HUM-NFR-004` Complete the whole-MVP actor/tenant bypass suite beyond Task 12 authorization-before-ranking and current-authority saved-query/graph reads. `tests/integration/graphql-product-files-imports.test.ts` now adds bounded active-workspace non-disclosure coverage for extraction runs and import-mapping options, including authorization-before-resolver foreign extraction lookup; the whole-MVP settings/files/imports and remaining domain bypass matrix remains open.
- Bounded Better Auth admin-route evidence (2026-09-12): the public auth catch-all now denies every method under `/api/auth/admin` before the Better Auth adapter is initialized. This closes the unused plugin endpoints for global user listing, role changes, impersonation, session revocation, and user deletion so they cannot bypass Humans' workspace-scoped authorization, audit, redaction, and idempotency boundaries. `tests/unit/auth-route-boundary.test.ts` covers GET/POST/PATCH/PUT/DELETE and proves neither the loader nor delegate runs; application-owned administration remains the supported path.
- [ ] `HUM-NFR-005` Complete cookie and whole-MVP GraphQL security controls beyond the Task 12A limiter foundation and Task 12 argument-costed search/snapshot/analysis operation budgets. A bounded live matrix now covers malformed origins/session cookies/API-key headers/JSON and a Redis-backed `graph.read` denial before resolver work; both Yoga execution errors and early authenticated-context HTTP errors now use a closed response shape; the whole-MVP browser/provider/operation matrix remains open.
- [ ] `HUM-NFR-006` Complete input, browser-header, and upload security controls beyond the representative unit/live-PostgreSQL matrix. `tests/unit/nfr006-security-contract.test.ts` now dynamically exercises the security envelope for every discovered API route and requires every concrete object-store adapter to retain upload and filename validation; early GraphQL auth-boundary upstream errors are normalized to a closed code/message/requestId shape before response serialization; whole-browser, every upload path, live malware-provider, external-provider, and whole-product input evidence remain open.
- Bounded direct-route acceptance evidence (2026-09-13): `tests/unit/nfr006-security-contract.test.ts` now proves each discovered API route preserves a valid correlation ID and replaces malformed values at the shared proxy response boundary. The smallest correction adds that validated/generated `x-request-id` to the proxy alongside existing browser-security headers. Direct account-route tests cover unauthenticated browser requests and invitation-handoff cookie non-disclosure; GraphQL security tests add malformed API-key redaction, correlated private-cache denials, and a foreign-workspace header denial. The live GraphQL cases remain skipped unless `TEST_DATABASE_URL` is configured, so this is local bounded evidence only.
- [ ] `HUM-NFR-007` Complete log/audit redaction and protected 2FA handling beyond Task 12 protected-search leakage tests, safe audits, HMAC material controls, and closed production metrics. The bounded NFR-007 tranche now also closes the auth-boundary upstream JSON spread and webhook transport `Error.name` persistence, projects only allowlisted/static values, contains storage initialization errors behind the allowlisted `storage.infrastructure.failure` event, and marks every Better Auth response `private, no-store` so successful TOTP enrollment cannot be cached; unit/live auth-security, storage-boundary, and webhook tests prove token/password/prompt/stack/endpoint fields are dropped. The full producer/provider/browser/storage sweep remains required.
- [ ] `HUM-NFR-008` Extend Task 18's durable response-reference replay, expiry takeover, malformed-reference rejection, and concurrent current-primary coverage across every remaining retryable mutation domain. Import `startImport` and the fact-create service transaction seam now have live PostgreSQL replay/concurrency evidence, including malformed and expired opaque references plus tenant fencing. Generated GraphQL `createPerson`, `CreateFact`, and `CreateEvidenceItem` now add the same bounded evidence: concurrent callers converge without duplicate effects, malformed references fail closed before UUID lookup, expired claims take over, and raw-key reuse is tenant-isolated. Generated GraphQL `createUploadSession` and `completeUpload` now retain durable response references, true overlapping verification convergence, one file/audit/storage-usage effect, malformed-reference rejection, expiry takeover, and workspace fencing. Generated GraphQL `sendWebhookTestEvent`, `UpdateAccessPolicy`, and `UpdateWorkspaceDefaults` also retain their bounded evidence. The policy/grant tranche now adds durable HMAC replay to generated access-policy and resource-grant create/update/archive mutations; its live test covers concurrent create convergence, update malformed-reference rejection and expiry takeover, archive replay, optimistic versions, redacted audits, and a foreign-workspace create claim. Evidence creation preserves source/file authorization, checksum validation, audit/search writes, and legacy callers. Direct GraphQL idempotency for the remaining people mutations and the retryable job/settings matrix remain open.

  - Bounded contact/location retry evidence (2026-09-13): generated contact (including phone aliases), address, and place create/update/archive operations now have disposable PostgreSQL acceptance in the required database CI command. The 20-case matrix proves concurrent lifecycle convergence, one durable claim and audit per operation, changed-material conflicts, malformed references across the lifecycle, concurrent expired-create/update takeover, expired archive rejection without duplicate effects, and workspace/principal raw-key fencing. Existing required-key GraphQL and legacy service contracts are unchanged. Remaining retryable mutation domains remain open; this does not close HUM-NFR-008.

  - Bounded core-person retry evidence (2026-09-13): generated `CreatePerson`, `UpdatePerson`, and `ArchivePerson` now use the shared durable principal-bound HMAC ledger with versioned opaque person references, preserving optional-key legacy callers. Disposable PostgreSQL acceptance in the required database CI command proves concurrent lifecycle replay, one principal claim and redacted audit per mutation, changed-material conflict rejection, malformed-reference failure, serialized expiry takeover, and workspace/principal raw-key fencing. Every replay rechecks current workspace visibility and optimistic version. Remaining people and retryable job/settings mutation families remain open; this does not close HUM-NFR-008.

  - Bounded person-file attachment retry evidence (2026-09-13): generated `AttachPersonFile` and `ArchivePersonFile` now consult the shared principal-bound ledger before current-row shortcuts and replay only an exact opaque attachment/version reference. Four live disposable-PostgreSQL cases in the required database CI command prove concurrent attach/archive convergence, one current attachment and redacted audit effect per operation, changed-material and stale-version conflicts, malformed create/archive references, serialized expiry takeover after archival, and raw-key workspace/principal fencing. Replays recheck current person/file visibility, committed archived detach responses remain replayable, and optional unkeyed callers are unchanged. Remaining retryable mutation families stay open; this does not close HUM-NFR-008.

  - Bounded core-person upgrade compatibility (2026-09-13): a guarded user-only bridge replays matching, unexpired legacy actor-ledger claims for core create/update/archive before the principal-ledger path. Independent PostgreSQL review proves base-to-current replay for all three without duplicate effects, supports the historical versionless create reference, and preserves `NOT_FOUND` after legacy-created people are archived. This migration bridge does not close HUM-NFR-008 or the remaining retryable mutation families.

  - Bounded HUM-NFR-008 reconciliation evidence: generated `reviewIdentityCandidate` now accepts a principal-bound durable idempotency key with canonical decision/reason material, opaque response-reference replay, changed-material conflict handling, optimistic version fencing, and one redacted audit effect; full live/browser reconciliation acceptance remains open.
  - Bounded HUM-NFR-008 privacy-settings evidence: generated retention-policy, legal-hold, consent, and deletion-request mutations now use the same durable principal-bound response-reference ledger. Focused live PostgreSQL coverage proves replay without duplicate effects, malformed response-reference rejection, optimistic release/review behavior, concurrent consent convergence, and workspace-fenced raw-key reuse; retention enforcement, deletion execution, and the broader settings/provider matrix remain open.
  - Bounded HUM-NFR-008 person-mutation evidence: generated `UpdatePerson` and `ArchivePerson` now accept principal-bound durable idempotency keys. Live PostgreSQL coverage proves replay without duplicate person or audit effects and workspace fencing; generated `selectPersonPresentation` now has user-bound durable replay with concurrent and omitted-vs-explicit selection coverage. Merge/unmerge, tags, contacts, locations, and the remaining retryable mutation matrix remain open.
  - Bounded HUM-NFR-008 name/timeline evidence: generated `createPersonName`, `updatePersonName`, `archivePersonName`, `createPersonEvent`, `updatePersonEvent`, and `archivePersonEvent` now accept principal-bound durable idempotency keys with canonical request hashes and opaque response references. The generated acceptance workflow covers replay of each create/update/archive without duplicate rows or audit effects; concurrent, malformed-reference, expiry-takeover, changed-material, and cross-workspace fencing coverage remains release evidence to add.
  - Bounded HUM-NFR-008 merge evidence: generated `mergePerson` and `unmergePerson` now accept durable idempotency keys. Live PostgreSQL coverage proves concurrent replay converges to one merge and one unmerge audit/effect; relationship, name/event idempotency, and remaining retryable mutation coverage remain open.
  - Bounded HUM-NFR-008 relationship-edge evidence: generated `createRelationship`, `updateRelationship`, and `archiveRelationship` now accept principal-bound durable idempotency keys. Live PostgreSQL coverage proves concurrent create/update/archive replay, one claim and audit per operation, malformed-reference rejection, changed-material conflicts, foreign-workspace fencing, and archived-response replay; the remaining retryable mutation matrix remains open.
  - Bounded HUM-NFR-008 relationship-type evidence: generated `createRelationshipType` and `updateRelationshipType` now accept principal-bound durable idempotency keys. Focused live PostgreSQL coverage proves concurrent create/update replay, one claim and audit per operation, malformed-reference rejection, changed-material conflicts, and workspace fencing; remaining retryable mutation domains remain open.
  - Bounded HUM-NFR-008 tag-domain evidence: generated `createTag`, `updateTag`, `archiveTag`, `tagPerson`, `untagPerson`, `tagFact`, `untagFact`, `tagRelationship`, and `untagRelationship` now accept optional principal-bound durable idempotency keys. Focused live PostgreSQL coverage proves concurrent convergence, one durable claim and audit effect per operation, archived/deleted association response replay, malformed-reference rejection, expiry takeover, changed-material conflicts, and workspace fencing; the remaining retryable mutation matrix remains open.
  - Bounded HUM-NFR-008 fact evidence: generated `selectPersonField`, `reviseFact`, `createFactRelationship`, and `archiveFactRelationship` now accept principal-bound durable idempotency keys. Focused live PostgreSQL coverage proves concurrent selection/revision/relationship convergence, one durable claim and audit effect per actual mutation, changed-material conflicts, optimistic relationship archive versions, and workspace fencing; names, contacts, locations, and the remaining retryable mutation matrix remain open.
  - Bounded HUM-NFR-008 note-domain evidence: generated `createNote`, `updateNote`, and `archiveNote` now accept optional principal-bound durable idempotency keys. Focused live PostgreSQL coverage proves concurrent create/update/archive replay, one audit effect per operation, and changed-material conflict handling; the remaining retryable mutation matrix remains open.
  - Bounded HUM-NFR-008 graph-view evidence: generated `createGraphView`, `updateGraphView`, and `archiveGraphView` now accept optional principal-bound durable idempotency keys. Focused live PostgreSQL coverage proves concurrent replay, one audit effect and claim per operation, changed-material conflicts, and archived-response replay; the remaining retryable mutation matrix remains open.
  - Bounded HUM-NFR-008 graph-analysis evidence (2026-09-13): generated `runGraphAnalysis`, `createGraphSnapshot`, `rerunGraphAnalysis`, and `replayGraphSnapshot` now accept optional principal-bound durable HMAC idempotency keys. Live PostgreSQL coverage proves concurrent snapshot/run convergence, deterministic run/rerun/replay responses, changed-material conflict rejection, actor/workspace fencing, opaque raw-key storage, and one snapshot/run/result/metric/audit effect per actual mutation. Replays recheck current graph authorization and the complete snapshot manifest before returning stored resources; malformed-reference, expiry-takeover, browser retry, performance, and the remaining job/settings mutation matrix remain open, so HUM-NFR-008 stays incomplete.
  - Bounded HUM-NFR-008 API-key lifecycle evidence (2026-09-12): generated `createOrganizationApiKey`, `rotateOrganizationApiKey`, and `revokeOrganizationApiKey` accept optional principal-bound durable idempotency keys while preserving unkeyed callers. Create/rotate persist only opaque action/result references, return plaintext only to the first executor, and mark a secretless replay explicitly; keyed rotation atomically commits one replacement, original disable, and redacted audit. Focused live PostgreSQL coverage proves concurrent create/rotate convergence, one transient secret, no plaintext in the stored key or replay ledger, changed-material conflicts, workspace-principal fencing, and the prior revoke controls. Expiry takeover, malformed create/rotate response references, and the remaining retryable job/settings matrix remain open.
  - Bounded HUM-FR-031/HUM-NFR-008 settings evidence (2026-09-12): the API-key administration control supplies a UUID idempotency key to create, rotate, and revoke. A same-material create/rotate transport retry reuses its key, while an applied replay without recoverable plaintext produces explicit rotate/revoke guidance. `tests/unit/api-key-administration.test.tsx` covers transient first presentation, retry reuse, create/rotate/revoke inputs, and secretless-replay handling; whole-settings acceptance remains open.
  - Bounded HUM-NFR-008 case-lifecycle evidence (2026-09-12): generated `createResearchCase`, `addCaseMember`, and `linkCaseResource` now accept optional principal-bound durable idempotency keys while preserving unkeyed callers. Focused live PostgreSQL coverage proves concurrent convergence, one case/member/link row and one redacted audit effect per operation, changed-material conflicts, malformed opaque response-reference rejection, expiry takeover, and raw-key workspace fencing. Case-owner, resource authorization, purpose coverage, and current workspace identity are rechecked on replay; broader case close/reopen, assignment, assertion, and remaining retryable job/settings coverage remain open.
  - Bounded HUM-NFR-008 assertion evidence (2026-09-12): generated `linkEvidenceAssertion` and `reviewEvidenceAssertion` now accept optional principal-bound durable idempotency keys. The service retains only HMAC-bound opaque assertion/audit references, replays through current workspace/purpose/resource authorization, preserves the independent-reviewer requirement, and leaves unkeyed callers unchanged. Focused assertion coverage proves concurrent replay, changed-material conflicts, and one audit effect per link/review; disposable PostgreSQL malformed-reference, expiry-takeover, and cross-workspace evidence remains open.
  - Bounded HUM-NFR-008 source evidence (2026-09-12): generated `createSource`, `updateSource`, `archiveSource`, and `recordSourceCustodyEvent` now accept optional principal-bound durable idempotency keys. Source replay rechecks current workspace visibility and version (including archived responses), while custody replay fences both source and event references. Disposable PostgreSQL coverage proves concurrent create/update/archive/custody convergence, one source/custody/audit effect per operation, and changed-material conflicts; malformed-reference, expiry-takeover, and cross-workspace source evidence remain open.

- [ ] `HUM-NFR-009` Complete responsive and whole-product accessibility acceptance beyond the tested Task 12 search and graph-analysis controls/results. Profile semantic sections, keyboard tab activation, RTL/200% zoom no-overflow/axe evidence, and the keyboard-tested graph-relationship-to-profile transition are bounded additions; full responsive primary-journey coverage remains open.
  - Bounded queue-browser evidence (2026-09-13): one disposable authenticated Chromium owner/reviewer/viewer journey selects a fictional case, filters the 25-row generated-GraphQL assignment queue, creates/assigns/transitions/keyboard-escalates a row with reasons, and verifies native focus, mobile no-horizontal-overflow, and an axe scan. The test also proves a foreign viewer receives no case selector entry. This is local evidence included in the required CI browser command, not a fresh CI, hosted, or whole-product accessibility claim.
- [ ] `HUM-NFR-011` Complete the remaining whole-product PostgreSQL, Redis, storage, GraphQL, browser, and CI matrix beyond the Task 12 foundation and Task 18 live upgrade/concurrency/browser/Compose suite. Consent-governed research Task 2 adds case/assertion/relationship-review backend tests and migration 0033; its live PostgreSQL cases/provenance/GraphQL tests remain unverified without disposable `TEST_DATABASE_URL`, and browser/runtime acceptance remains open.
- [ ] `HUM-NFR-012` Complete tenant, auth, security, and deterministic-AI primary journeys beyond the Task 12 search/saved-query/graph browser coverage. The graph-to-profile relationship transition reuses only the already-authorized generated graph result and the profile's existing authorized generated GraphQL reads; cross-workspace and redaction behavior remain owned by those server boundaries.
- [ ] `HUM-NFR-018` Produce current full-matrix MVP release evidence. GitHub Actions run `34749135777` for runtime commit `1102a67` completed successfully across all 9 jobs: Node 24 PostgreSQL integration, browser acceptance, production build, Compose lifecycle, generated drift, quality, image security, dependency policy, and secret scanning. Vercel deployment `dpl_FND3s4vZ9tLEoHBY5SNegNCG6HM8` is Ready and serves the custom domain, with public smoke and direct-route probes passing. Hosted authenticated/provider/runtime proof and the remaining TODO rows are still outstanding.
- Current full-matrix release evidence (2026-09-13): GitHub Actions run `34747186521` for pushed `e524f12` passed all 9 jobs, including database integration, browser integration, production build, Compose lifecycle, generated drift, quality, image security, dependency policy, and secret scanning. The exact runtime tree was deployed as `dpl_HZhpCKissKs3Ei3KuP8icFBgS3eh` and public smoke passed; hosted authenticated/provider proof and the remaining TODO rows are still outstanding.
- [ ] `HUM-NFR-020` Meet and continuously verify the production latency, concurrency, graph-frame-rate, Web Vitals, and bundle budgets beyond Task 12 bounds and indexed-plan evidence. The disposable Node 24 performance harness exercises the representative 10,000-person/25,000-edge GraphQL read, graph render/FPS/WebGL recovery, and public/dashboard/entities/editor bundle checks, but mutation/upload latency, hosted Web Vitals, hosted-performance, and reference-machine evidence remain open.
  - Performance-gap/remediation evidence (2026-09-12): the initial disposable run seeded 10,000 people and 25,000 relationships but measured authenticated concurrent graph-read p95 at 699.10 ms against the required <=500 ms because the visible-person sort lacked a matching index. Migration `0044_core.sql` adds the workspace-leading partial expression index used by that sort; a subsequent isolated run measured graph-read p95 at 129.96 ms and passed all three graph performance tests. Thresholds were not relaxed. Mutation/upload latency, public Web Vitals, hosted performance, and a passing documented reference-machine run remain required.
- Bounded synthetic demo dataset evidence (2026-09-13): the guarded seed now
  creates the fictional Northstar Atlas/Sandbox tenants with four fictional
  people, rich profile/name/fact records, temporal documented/hypothesis edges,
  source/evidence contradiction, case reviewer, withdrawn consent, pending AI
  suggestion, and legal hold. The isolated production-image Compose lifecycle
  now proves an absent-guard rejection, two successful guarded seed runs,
  deterministic record counts, an authenticated four-person Atlas GraphQL
  result, and denial of the Sandbox person. That production-image check runs in
  the existing Compose lifecycle CI job. The matching generated-operation test
  is also part of the PostgreSQL/Redis/MinIO database job through
  `tests/integration/synthetic-seed-lifecycle.test.ts`. Hosted seeding remains
  intentionally unsupported and no external-provider claim is made.

- Release evidence (2026-09-12): GitHub Actions run `34688755202` passed all
  nine required checks for `6bb3f11`, including database, browser, Compose,
  build, image, generated-artifact, quality, dependency, and secret gates.
  Vercel deployment `dpl_9JRzgRDo9RQaaZvzrF2TX8PXaNhf` is `READY` with the
  `humans.kevinbytes.com` alias. The release is not treated as full MVP
  closure: hosted authenticated credentials, external provider contracts,
  and the remaining rows below still require operator/runtime evidence.

Release-candidate gate evidence (2026-09-12): under the required Node
24.19.0 runtime, the production-completion branch passes the full local
Vitest suite with bounded local worker pressure (`vitest run --pool=forks
--maxWorkers=4`) (181 files, 1,529 passed, 74 skipped), formatting, lint,
typecheck, Drizzle check/drift, GraphQL codegen drift, production build,
Compose configuration contracts, and diff checks. Disposable database
lifecycle, hosted authenticated smoke, provider contracts, and full
browser/performance evidence remain release work.

Current GitHub Actions gate (2026-09-12): run `34686415372` for commit
`7b7f2d1` passed all nine checks, including the real PostgreSQL integration
seam, browser acceptance, isolated Compose lifecycle, production build,
generated-artifact drift, quality, image security, dependency policy, and
secret scanning. The commit corrects the cross-workspace relationship fixture
to use the sandbox tenant's fictional person; it changes no runtime code.

Live unauthenticated smoke evidence (2026-09-11): the merged `main` passed
`pnpm production:smoke -- --base-url https://humans.kevinbytes.com` with
homepage/liveness/readiness 200, unauthenticated GraphQL 401, and invalid jobs
authorization 401. Authenticated admin/person creation, provider contracts,
and deployment-identity verification remain open.

Updated production deployment evidence (2026-09-12): commit `d1652fb` is
deployed as Vercel `dpl_G1pdWAst4uvVkxmeXTnf3ufutjjC` (`READY`, Node 24,
aliases include `humans.kevinbytes.com`), and the public smoke passes against
the custom hostname. The four administrator values from the operator-
restricted local `.env` were synchronized to Vercel Preview and Production
without printing them. The authenticated smoke still returns a generic 403;
because bootstrap is intentionally idempotent and does not rotate an existing
credential, hosted sign-in/person creation remains open until an operator runs
the explicit `pnpm admin:rotate-password` procedure against the hosted
database. No hidden values were retrieved.

Original product-contract closeout (2026-09-12): the requirements document
now explicitly tracks rich person profiles, temporal documented/hypothesis
edges, field-level provenance, case/workspace governance, privacy and legal
holds, immutable auditability, human-reviewed AI suggestions, GraphQL search
and controlled import/export, scoped API keys/2FA/session controls, and a
fictional synthetic demo dataset. The implementation has local schema,
generated-operation, service, and test seams for each; remaining TODO rows
continue to cover hosted credentials, provider contracts, browser/accessibility
coverage, external storage/email/AI acceptance, and live Compose evidence.

- [ ] `HUM-FR-038` Run the research-assignment queue lifecycle against disposable
      PostgreSQL: prove workspace/case isolation, reviewer/owner mutation
      authority, valid and invalid transitions, deleted/foreign assignee
      fencing, optimistic conflicts, append-only event update/delete protection,
      strict bounded event cursors, escalation before/after counts, soft-delete
      visibility with event preservation, principal-bound idempotent replay
      (including material, principal, and concurrency cases), no case-resource
      grant side effects, and redacted audit output. The queue schema,
      repository, service, GraphQL operations, migration, and generated-document
      contract are present. The Node 24 disposable PostgreSQL matrix now passes
      all 7 assignment lifecycle tests as part of `pnpm test:db` (35 files,
      490 passed, 2 skipped in CI). The protected case workspace also has a
      bounded 25-row generated-GraphQL queue panel with focused component
      coverage for listing, creation, and valid transition inputs. A 2026-09-13
      local disposable authenticated Chromium journey now selects a fictional
      seeded case, filters, creates, assigns a valid reviewer, transitions,
      keyboard-escalates, and verifies generated GraphQL/database state, event
      provenance, unchanged case-resource links, foreign-viewer denial, mobile
      no-overflow, and queue-region axe results. It is included in the required
      browser CI command, but fresh CI, hosted acceptance, and the full
      role/resource matrix remain open.

Bounded workspace assignment surface evidence (2026-09-13): the protected
`/assignments` route now exposes the existing authorized GraphQL queue without
requiring a case selection. The browser surface omits the case filter for
workspace-scoped reads, sends an explicit `null` case ID for workspace-level
creation, and hides creation/transition/assignment controls from members
without `workspace:update`; the server remains authoritative for workspace and
case mutation authorization. Desktop navigation, mobile navigation, and the
command menu expose the route only to viewers with `workspace:read`. Nine
focused component tests pass for workspace listing, null-scoped creation,
read-only controls, case behavior, optimistic transitions, and stale-response
fencing. This closes the missing workspace queue surface but does not close the
FR-038 hosted, full role/resource, or fresh browser/provider acceptance matrix.

Bounded extraction security evidence (2026-09-13, HUM-NFR-004/HUM-NFR-007):
the service now independently requires `file:read` before database work, and
request/retry GraphQL mutations require it before enqueueing their work.
Cancellation also requires read/update authority at GraphQL and service
boundaries before database access or returning structured extraction content.
GraphQL extraction errors project only an allowlisted worker code. Focused
unit tests cover user/API-key denial and malformed/secret-bearing diagnostic
JSON; the existing live files/imports test covers stored diagnostic redaction,
authorized structured output, foreign-workspace denial, correlation, and
private caching. The whole-product actor/tenant and producer/provider redaction
matrices remain open; this evidence does not close either requirement.
Collaboration hierarchy checkpoint (2026-09-13): migrations `0048_core.sql`
and `0049_core.sql` add workspace-scoped teams, team members, explicit
case–team sharing links, investigations, and investigation–case links. The
GraphQL/service boundary enforces workspace and membership checks, owner or
manager approval for sharing, principal-bound idempotency, and redacted audit
events. Focused schema, GraphQL, typecheck, lint, Drizzle drift, and generated
operation tests pass locally. Remaining work is intentionally open: dedicated
team/investigation UI, disposable PostgreSQL lifecycle coverage, assignment
scope integration, hosted/provider acceptance, and the full role/redaction/
accessibility matrix.

Bounded HUM-NFR-008 privacy-request transition evidence (2026-09-13):
`reviewPrivacyRequest`, `fulfillPrivacyRequest`, and `cancelPrivacyRequest`
accept optional principal-bound durable idempotency keys. Their shared outer
transaction commits the transition, redacted audit, and any deletion enqueue
or processor propagation once. Exact opaque request/version/state references
are validated before lookup and replay rechecks live identity, scoped access,
and current state. The 23-case disposable PostgreSQL suite covers overlapping
retries, changed material, malformed/redirected references, expired pending
claim takeover, stale-version rejection after expiry, workspace/principal
fencing, session revocation, independent approval, legal holds, and generated
GraphQL lifecycle replay. It is included in `test:db`; the existing lifecycle
and retention legal-hold suites also pass. This does not close HUM-NFR-008:
other mutation families, browser retry, and hosted/provider acceptance remain
open.

Bounded HUM-FR-005/HUM-NFR-008 privacy search propagation evidence
(2026-09-14): the privacy worker now wires a transactional, workspace-scoped
search adapter that removes direct person documents and dependent indexed
contributions for the request's person scope. Repeated execution is safe and
returns the same opaque request-scoped evidence reference; same-workspace
non-targets and foreign-workspace documents remain untouched. Redis is marked
explicitly `not_applicable` because this deployment uses it for operational
state only, while Resend and AI-provider processors remain failed-closed until
provider-specific erasure contracts exist. The focused PostgreSQL suite is
`tests/integration/privacy-search-propagation.test.ts`; local runs skip without
`TEST_DATABASE_URL`, and the suite is now required by `test:db` plus its CI
contract. This bounded implementation does not close the hosted,
external-provider, or whole-product privacy matrix.

Reviewer hardening for the same tranche: correction requests now fail closed
with `search_reindex_required` rather than deleting stale search rows without a
transactional reindex contract. File-only scopes delete only workspace-owned
`evidence_item` and `evidence_excerpt` documents reached through
`evidence_items.file_id`; relationship documents are removed when either the
source or target endpoint is in the person scope. The index contribution still
stores one source-side `subjectPersonId`, so endpoint-complete privacy cleanup
is implemented in the adapter query and guarded by a target-endpoint
regression case; richer dual-endpoint index attribution remains future work.

High-risk governance closeout follow-up (2026-09-13): the AI retention
candidate lock now targets only `ai_threads`, acquires the workspace advisory
lock before authoritative revalidation, and re-reads current workspace
retention settings before deletion. This prevents the settings-mutation lock
inversion and preserves a thread when a concurrent policy update removes its
eligibility. The two person-hold cases plus the deterministic settings-versus-
purge race pass on disposable PostgreSQL; the focused cases are run as a
separate invocation in `test:db` so the aggregate database matrix is not
filtered by a test-name selector. The broad retention, hosted, and whole-
product governance rows remain open.

High-risk tranche CI evidence (2026-09-14): GitHub Actions run `34801651438`
for pushed `main` commit `018dad6` passed all nine required jobs, including
the real PostgreSQL integration matrix (with the separate AI-retention
selector), browser acceptance, production build, generated drift, quality,
Compose lifecycle, image security, dependency policy, and secret scanning.
This validates the merged tranche only; hosted authenticated/provider,
external storage/email/AI, performance, and the remaining incomplete
requirements are still open.

Bounded AI-review retry evidence (2026-09-14): optional principal-bound keys
now cover individual accept/reject/defer decisions and whole approved batches.
Live PostgreSQL tests cover concurrent convergence, changed/normalized material,
opaque-reference rejection, expiry takeover, principal/workspace/session fences,
current purpose/person/provenance/evidence reauthorization, and atomic batch
rollback. Browser-component tests preserve keys after uncertain transport and
replace them when decision material or batch membership changes. The ledger
stores only suggestion identifiers, versions and statuses. This is bounded
evidence for HUM-NFR-008; other mutation families and hosted/provider acceptance
remain open.

Merged provenance/provider hardening verification (2026-09-14): `main` now
contains the reviewed AI retry, relationship evidence-gate, external bucket
isolation, and migration-count contract changes. Local Node 24.19.0 gates pass:
1,556 unit tests, formatting, lint, TypeScript, Drizzle check/drift, and the
production build. The supported PostgreSQL 18.3/Redis matrix passes 46 files
and 651 tests with five documented skips, followed by the three focused AI
retention tests. Temporary synthetic containers and all obsolete local
worktrees/branches were removed. GitHub CI, hosted authenticated acceptance,
and live external-provider contracts still require their normal remote runs.

Browser acceptance repair (2026-09-14): the authenticated GraphQL context now
passes the configured AI retry HMAC into the AI review service. The prior
browser failure was proven by the Playwright trace to be the API returning
`PRECONDITION_FAILED` (`Retry protection is unavailable`) when accepting a
proposal with its browser-generated idempotency key; the queue therefore
correctly retained the pending row. The generated GraphQL acceptance test now
covers a keyed AI accept, and the focused local Chromium journey passes. A
fresh GitHub browser run is still required before marking the hosted/browser
acceptance row complete.

Production verification update (2026-09-14): GitHub Actions run
`34808092914` passed all nine required jobs for `2d98844`, including browser
acceptance and the real PostgreSQL/Redis integration matrix. That verified
commit was deployed with Vercel deployment `dpl_EXaYm1EtkHrLNBDhxohU62hcHxe3`
(`READY`) and aliases `humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`. The deployment build completed with Next.js
16.3.4. Hosted authenticated sign-in, administrator bootstrap, and live
external-provider acceptance remain intentionally open because provider
secrets are not exported or printed by this closeout.

Acceptance-closure tranche verification (2026-09-14): pushed `main` commit
`e54555c` passes GitHub Actions run `34844791102` with all nine required jobs:
quality (1,561 unit tests), browser acceptance, PostgreSQL/Redis/MinIO
integration, isolated Compose lifecycle, production build, generated drift,
image security, dependency policy, and secret scanning. The tranche adds
principal-bound presentation replay fencing, DNS-pinned and non-redirecting
webhook delivery with response draining, a complete webhook failure/retry
matrix, governed profile provenance/confidence/updater presentation, and
reviewed synthetic Gitleaks history suppressions. It was deployed manually as
Vercel `dpl_GgUYyHMw6SNwKHV67aK2DwkeLYEu` (`READY`) with aliases for
`humans.kevinbytes.com`, `humans-dun.vercel.app`, and
`humans-tkoresearch.vercel.app`; the Vercel build used Next.js 16.3.4.
Fresh public probes returned 200 for `/`, `/sign-in`, `/api/health/live`, and
`/api/health/ready`, with private/no-store and correlation headers; an
unauthenticated POST to `/api/graphql` returned the expected `UNAUTHENTICATED`
contract. This is verified release evidence for the merged tranche, not full
MVP closure: hosted administrator sign-in/bootstrap, external Resend/R2/S3/
Upstash/OpenAI/Ollama contracts, full role/resource/redaction/performance
matrices, and the other incomplete rows above remain open.
