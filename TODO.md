# MVP closure and production hardening backlog

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
cleanup, bulk alerts, and the remaining whole-product matrix remain open.

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

Task 5 follow-up: non-public fact values/provenance/temporal context and selection
actions are withheld until request-bound field disclosure is implemented. The new
read-only Privacy Requests panel shows person retention/hold metadata and authorized
request-ID lookup; full CRUD and a person-filtered request API remain pending.
The remaining HUM-FR-005/HUM-NFR-011/HUM-NFR-012 work still requires a complete audit
of overview/contact/file/graph and other surfaces, field-scoped disclosure tests,
and authenticated backend/hosted evidence. No acceptance row is closed.

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

Task 3 local checkpoint (2026-09-11): the AI review ledger preserves typed proposals, evidence or validated web-source snapshots, confidence/uncertainty, run/provider/model/prompt-policy attribution, and explicit accept/reject/defer decisions. The person research panel uses generated review mutations instead of direct AI-driven profile updates. Acceptance requires current AI/write purpose coverage, case/resource visibility, human confirmation, and an owned completed source run; fact/relationship acceptance uses domain services and evidence assertions in one transaction. Batch acceptance is explicitly approved and atomic; AI-created relationships remain inferred until the existing independent assertion review permits promotion. Local unit/build/schema gates are required before commit. Live PostgreSQL lifecycle, browser and provider verification remain pending when the test database/provider is unavailable; this does not close HUM-FR-023 or the overall MVP.

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
- [ ] `HUM-FR-023` Complete workspace-policy-controlled restricted-prompt omission and the full retention-policy matrix beyond implemented AI-thread retention inheritance/purge, read-only tool allowlist, authorization checks, citation validation, and provider/model disclosure. Bounded person web research now provides explicit consent, safe bounded Brave/OpenAI-compatible provider handling, source-backed auto-filled editable drafts, per-field and accept-all review controls, an immutable workspace/person-scoped provenance snapshot with a generated run ID, and a Chromium acceptance journey for selective persistence. Live provider credentials, source-to-evidence-item linkage, retention deletion/expiry coverage for research snapshots, and the remaining policy/provider matrix are still open.
- [ ] `HUM-FR-024` Complete live webhook lifecycle, signed delivery, retry, destination-rebinding, and upgrade-migration acceptance beyond the implemented durable jobs and immutable audit records.
- Bounded HUM-FR-024 redirect-fence evidence (2026-09-08): webhook delivery now uses `redirect: "error"` after validating the public HTTPS target, and the live delivery contract asserts the request cannot follow a redirect into an unvalidated destination. DNS rebinding, external provider failure, and upgrade-migration acceptance remain open.
- [ ] `HUM-FR-028` Complete names/reconciliation, timeline, person-file, and contradictory-fact profile workflows plus full accessibility acceptance beyond the implemented people search/create, overview edit, facts, relationships, evidence, notes, contacts, activity, and files surfaces. Bounded names/timeline pagination and truthful temporal-precision rendering, audited name/event CRUD with idempotent GraphQL mutations and profile edit/archive controls, contradictory-state rendering, workspace-scoped `Person.files` roles/pagination, verified primary-photo upload/attachment, audited/idempotent arbitrary file-to-person attach/detach, workspace-scoped person-reference fact picking, profile RTL/200% keyboard/axe evidence, confidence-aware person entry, reviewed AI-enrichment drafts, owner/viewer reconciliation browser coverage, and an accessible Evidence workspace extraction-history/request/cancel/retry control with permission-gated actions now exist; `tests/unit/file-extraction-controls.test.tsx` covers the generated-operation routing and read-only action boundary. The whole-product visual matrix remains open.
- [ ] `HUM-FR-029` Complete graph editing and performance acceptance beyond the existing explorer, accessible table fallback, and Task 12 snapshot/analysis/result/export controls. The React Flow neighborhood editor now routes relationship creation through an explicit review/`Confirm create` step, matching update/archive safety; focused unit and Chromium coverage prove no create write occurs before confirmation. Full editor breadth, performance, and provider/browser matrix remain open.
- [ ] `HUM-FR-031` Complete mutable/provider administration beyond the Task 14A responsive read-only account, security, members, keys, policies, audit, and integrations settings routes. A focused live policy-settings matrix now covers owner access-policy success, administrator workspace-default success, viewer/foreign denial, optimistic retries, validation rollback, redacted audit output, and durable `UpdateAccessPolicy` plus `UpdateWorkspaceDefaults` replay/concurrency boundaries; provider and whole-settings coverage remain open.
- [ ] `HUM-FR-032` Complete stable errors and request-correlation coverage across the whole MVP beyond the implemented Task 12 search/graph envelopes, centralized browser/server GraphQL error contract (including malformed-payload handling, header-authoritative IDs, and known-code secret-message normalization), and representative all-code/redaction matrix. Direct route codes are inventoried in `docs/ARCHITECTURE.md`; the scheduled `/api/jobs/run` route now emits stable `UNAUTHENTICATED`/`INTERNAL` codes with an `x-request-id`, the storage proxy now emits redacted stable upload/download/unmatched-path envelopes with correlated headers, health probes now echo correlation IDs on success, and a typed direct-route client covers invitation handoff/acceptance and two-factor state changes, while adoption across every remaining direct route and the whole-product failure matrix remain open.
- [ ] `HUM-FR-033` Complete whole-application failure evidence beyond the implemented dependency readiness, durable retries, worker heartbeat, bounded signal drain, live client/lease checks, and Compose-backed PostgreSQL/Redis outage checks; provider, browser, and interruption coverage remain open.
- [ ] `HUM-FR-035` Complete the parity Vercel deployment path. Production deployment `dpl_8rbBgB8mKSzupo8c15ADuYTN3LxD` is Ready and serves `humans.kevinbytes.com` from the fully green main release; production/preview R2 variables, Neon/Redis variables, and the configured AI/email variables are present. A fresh bounded hosted smoke passed homepage, liveness, readiness with PostgreSQL/Redis/storage, unauthenticated GraphQL, and the protected jobs route after this deployment. The protected route invokes configured administrator bootstrap before jobs, and sign-in requests bootstrap the configured account before credential validation. The repository now includes a redacted `pnpm production:smoke -- --base-url <selected-deployment>` harness with explicit authenticated/provider opt-ins; authenticated sign-in/create-person acceptance and the full hosted provider matrix remain release work. The protected Vercel CLI cannot export secret values for a local bootstrap command, so no plaintext hosted credentials were retrieved.

## Non-functional

- [ ] `HUM-NFR-002` Verify authoritative storage and provider adapter contracts, including external R2/generic-S3/Upstash acceptance. The bounded provider contract suite now exercises every RedisStore operation through local and Upstash-shaped adapters and signed S3-compatible lifecycle/isolation against CI MinIO; external Upstash REST and R2/generic-S3 runs require `RUN_EXTERNAL_PROVIDER_CONTRACTS=true` in addition to their provider credentials, preventing accidental use of production secrets. Adapter configuration now rejects non-HTTP(S)/credential-bearing storage endpoints, forces provider-safe R2 path-style behavior, and rejects non-Redis URLs before Upstash endpoint derivation. The Cloudflare R2 `humans-private` bucket and Vercel credentials are configured and a direct put/head/delete lifecycle passed, while generic S3 and externally hosted Upstash/R2 acceptance remain required.
- [ ] `HUM-NFR-004` Complete the whole-MVP actor/tenant bypass suite beyond Task 12 authorization-before-ranking and current-authority saved-query/graph reads. `tests/integration/graphql-product-files-imports.test.ts` now adds bounded active-workspace non-disclosure coverage for extraction runs and import-mapping options, including authorization-before-resolver foreign extraction lookup; the whole-MVP settings/files/imports and remaining domain bypass matrix remains open.
- [ ] `HUM-NFR-005` Complete cookie and whole-MVP GraphQL security controls beyond the Task 12A limiter foundation and Task 12 argument-costed search/snapshot/analysis operation budgets. A bounded live matrix now covers malformed origins/session cookies/API-key headers/JSON and a Redis-backed `graph.read` denial before resolver work; both Yoga execution errors and early authenticated-context HTTP errors now use a closed response shape; the whole-MVP browser/provider/operation matrix remains open.
- [ ] `HUM-NFR-006` Complete input, browser-header, and upload security controls beyond the representative unit/live-PostgreSQL matrix. `tests/unit/nfr006-security-contract.test.ts` now dynamically exercises the security envelope for every discovered API route and requires every concrete object-store adapter to retain upload and filename validation; early GraphQL auth-boundary upstream errors are normalized to a closed code/message/requestId shape before response serialization; whole-browser, every upload path, live malware-provider, external-provider, and whole-product input evidence remain open.
- [ ] `HUM-NFR-007` Complete log/audit redaction and protected 2FA handling beyond Task 12 protected-search leakage tests, safe audits, HMAC material controls, and closed production metrics. The bounded NFR-007 tranche now also closes the auth-boundary upstream JSON spread and webhook transport `Error.name` persistence, projects only allowlisted/static values, and marks every Better Auth response `private, no-store` so successful TOTP enrollment cannot be cached; unit/live auth-security and webhook tests prove token/password/prompt/stack/endpoint fields are dropped. The full producer/provider/browser/storage sweep remains required.
- [ ] `HUM-NFR-008` Extend Task 18's durable response-reference replay, expiry takeover, malformed-reference rejection, and concurrent current-primary coverage across every remaining retryable mutation domain. Import `startImport` and the fact-create service transaction seam now have live PostgreSQL replay/concurrency evidence, including malformed and expired opaque references plus tenant fencing. Generated GraphQL `createPerson`, `CreateFact`, and `CreateEvidenceItem` now add the same bounded evidence: concurrent callers converge without duplicate effects, malformed references fail closed before UUID lookup, expired claims take over, and raw-key reuse is tenant-isolated. Generated GraphQL `createUploadSession` and `completeUpload` now retain durable response references, true overlapping verification convergence, one file/audit/storage-usage effect, malformed-reference rejection, expiry takeover, and workspace fencing. Generated GraphQL `sendWebhookTestEvent`, `UpdateAccessPolicy`, and `UpdateWorkspaceDefaults` also retain their bounded evidence. The policy/grant tranche now adds durable HMAC replay to generated access-policy and resource-grant create/update/archive mutations; its live test covers concurrent create convergence, update malformed-reference rejection and expiry takeover, archive replay, optimistic versions, redacted audits, and a foreign-workspace create claim. Evidence creation preserves source/file authorization, checksum validation, audit/search writes, and legacy callers. Direct GraphQL idempotency for the remaining people mutations and the retryable job/settings matrix remain open.

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

- [ ] `HUM-NFR-009` Complete responsive and whole-product accessibility acceptance beyond the tested Task 12 search and graph-analysis controls/results. Profile semantic sections, keyboard tab activation, and RTL/200% zoom no-overflow/axe evidence are bounded additions; full responsive primary-journey coverage remains open.
- [ ] `HUM-NFR-011` Complete the remaining whole-product PostgreSQL, Redis, storage, GraphQL, browser, and CI matrix beyond the Task 12 foundation and Task 18 live upgrade/concurrency/browser/Compose suite. Consent-governed research Task 2 adds case/assertion/relationship-review backend tests and migration 0033; its live PostgreSQL cases/provenance/GraphQL tests remain unverified without disposable `TEST_DATABASE_URL`, and browser/runtime acceptance remains open.
- [ ] `HUM-NFR-012` Complete tenant, auth, security, and deterministic-AI primary journeys beyond the Task 12 search/saved-query/graph browser coverage.
- [ ] `HUM-NFR-018` Produce current full-matrix MVP release evidence. The current tree now has a fully green Node 24 repository gate (`34298190513`, commit `f1ada49`), 216 test files with 1,349 tests passed and 572 intentional skips locally, lint, typecheck, formatting, generated drift, focused graph/performance checks, and an isolated PostgreSQL/Redis/MinIO Compose smoke with administrator recovery; the full current matrix, hosted authenticated/provider/runtime proof, and all remaining TODO rows are still outstanding.
- [ ] `HUM-NFR-020` Meet and continuously verify the production latency, concurrency, graph-frame-rate, Web Vitals, and bundle budgets beyond Task 12 bounds and indexed-plan evidence. The disposable Node 24 performance harness now passes the representative 10,000-person/25,000-edge GraphQL read, graph render/FPS/WebGL recovery, and public/dashboard/entities/editor bundle checks; mutation, upload, hosted Web Vitals, and hosted-performance evidence remain open.
- Bounded synthetic demo dataset evidence (2026-09-11): the guarded seed now
  creates the fictional Northstar Atlas/Sandbox tenants with four fictional
  people, rich profile/name/fact records, temporal documented/hypothesis edges,
  source/evidence contradiction, case reviewer, withdrawn consent, pending AI
  suggestion, and legal hold. `tests/unit/synthetic-seed-contract.test.ts`
  proves the source contract and rejects the prior real-person fixture; live
  Compose seed/GraphQL verification remains required.

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
      contract are present; a local disposable PostgreSQL 18.3 run passed all 7
      lifecycle tests, but Node 24 CI and hosted/browser evidence remain open.
