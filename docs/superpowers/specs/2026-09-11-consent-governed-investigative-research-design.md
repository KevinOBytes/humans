# Consent-Governed Investigative Research Design

**Status:** Proposed for review  
**Date:** 2026-09-11  
**Scope:** Humans research workspaces, people records, evidence, relationships, AI-assisted analysis, privacy operations, and audit controls

## Purpose

Humans should support rigorous, consent-based research about people and social networks without becoming a covert surveillance, watchlist, or autonomous decision system. The product may be used for lawful research, compliance, safeguarding, journalism, organizational investigations, or personal records, but every workspace must be able to explain why information was collected, where it came from, who can see it, how reliable it is, and when it must be deleted.

The design extends the existing modular monolith. It keeps the current workspace, GraphQL, Drizzle, facts, evidence, relationships, AI provenance, privacy, audit, and storage boundaries. It does not replace the existing schema with an intelligence-agency-specific model.

## Product principles

1. **Consent and purpose before enrichment.** A person record may exist only for a documented workspace purpose. Sensitive fields and AI enrichment require a valid consent or other explicitly recorded lawful basis.
2. **Evidence before assertion.** A fact or relationship is an assertion with provenance, confidence, temporal scope, and review state, not an unquestionable truth.
3. **Human review before acceptance.** AI may propose values, links, contradictions, summaries, and search plans. It may not silently write accepted facts, infer a relationship from proximity alone, or make an adverse decision about a person.
4. **Least privilege by default.** Workspace, case, sensitivity, field classification, role, and purpose controls all participate in visibility decisions. API keys receive explicit scopes and never bypass audit or consent gates.
5. **Subject rights are first-class.** Access, correction, restriction, consent withdrawal, export, and deletion requests have an observable lifecycle and a durable audit trail.
6. **Uncertainty is visible.** The UI must distinguish documented, corroborated, disputed, disproven, inferred, and unknown information, with source and confidence details available at the point of use.
7. **Minimize by design.** The system should store the least data necessary for the declared purpose, with configurable retention and field-level redaction.

## Non-goals and prohibited capabilities

The following are explicitly out of scope:

- covert collection, hidden telemetry, or secret administrator access;
- facial recognition, biometric identification, or biometric matching;
- location tracking without an explicit, auditable consent or legal-basis record;
- bulk acquisition of private accounts, data-broker feeds, or credentialed sources without documented authorization;
- watchlists, blacklists, predictive threat/risk scores, or automated eligibility/adverse decisions;
- automatically labeling people as associates based only on co-location, shared identifiers, or graph proximity;
- deanonymization, identity resolution, or cross-workspace correlation without an approved purpose and explicit human review;
- exports that remove provenance, sensitivity, consent, or redaction metadata;
- using AI to invent, strengthen, or merge evidence without a cited source and reviewer action.

## Current foundation

The current repository already provides most of the lower-level boundaries needed for this design:

- `workspaceId` scoping across domain tables;
- typed people names, identifiers, facts, locations, files, relationships, and temporal fields;
- evidence records and file provenance;
- `consentRecords` and deletion request primitives;
- sensitivity-aware audit visibility and immutable audit events;
- GraphQL operations with generated types and authorization at the service boundary;
- AI provider adapters, persisted research provenance, and human-facing review components;
- field-level encryption/blind indexes for protected values;
- imports, extraction, search, graph analysis, API keys, 2FA, and workspace membership.

The implementation should add missing governance and case semantics without moving database access into browser code or weakening existing authorization.

## Domain model

### Person identity and profile

Keep `people` as the stable workspace-scoped subject identifier. Expand the profile through typed records rather than adding a large unbounded column set:

- names, aliases, transliterations, and name validity intervals;
- pronouns and self-described identity labels, with subject-provided provenance and consent-aware visibility;
- biographies and notes as separately classified rich-text assertions rather than an unreviewed free-form dossier;
- employment, education, languages, organization memberships, and public contact points as repeatable temporal facts;
- identifiers with namespace, issuer, verification state, encrypted value, and blind index;
- facts for birth/death information, sex/gender fields where appropriate and consented, languages, education, employment, organization membership, public web identifiers, and other workspace-defined properties;
- addresses and contact points as temporal records with type, valid interval, verification state, sensitivity, and source;
- files and media as references with malware/scanning status and provenance;
- public identifiers and custom fields through versioned `factDefinitions`, with workspace-defined validation and export policy;
- person status, merge history, confidence, sensitivity, and deletion state.

Sensitive fields must be classified individually. A person’s general profile visibility must never imply visibility of protected identifiers, precise addresses, phone numbers, or other restricted facts.

### Facts and field definitions

Continue using `factDefinitions` and `facts` as the extensible field system. Each definition should additionally support:

- a stable namespace and version;
- purpose tags and permitted workspace/case uses;
- sensitivity default and maximum permitted sensitivity;
- whether consent is required, which consent scopes satisfy it, and whether a lawful-basis record is also required;
- retention class and deletion behavior;
- source and reviewer requirements;
- whether the field is searchable, exportable, graphable, or AI-enrichable.

Every fact carries a state, review state, confidence, temporal semantics, source references, creator/updater attribution, and supersession chain. Multiple facts for the same field are expected; conflicting values remain visible as competing assertions until a reviewer resolves them.

### Temporal relationships

Relationships remain explicit, typed, directional where appropriate, and workspace-scoped. Add or standardize:

- relationship type and inverse label;
- source and target people;
- state: asserted, corroborated, disputed, disproven, inferred, or inactive;
- explicit assertion kind: `documented` when supported by a cited source or subject-provided record, or `analyst_hypothesis` when it is an interpretation awaiting corroboration;
- valid-from/valid-until and observation interval;
- confidence and confidence explanation;
- relationship sensitivity and field classification;
- evidence references and corroboration count;
- review state and reviewer decision;
- creation method: manual, imported, extracted, or AI-suggested;
- a human-readable explanation that distinguishes evidence from analyst interpretation.

Graph metrics may summarize the documented graph, but the UI must label metrics as analytical views rather than facts about a person. Inferred edges must never be promoted to asserted edges automatically.

### Sources, evidence, and provenance

Evidence should support source-level and field-level citation:

- source record, URI or file reference, title, publisher/author, publication date, collection time, and permitted collection method;
- source reliability and information credibility ratings with explanations;
- content hash, capture metadata, parser/extractor version, and chain-of-custody events for uploaded material;
- assertion-to-evidence links with quoted/extracted location, page/line/region, and redaction state;
- contradictions, duplicates, supersession, and corroboration links;
- whether a source was supplied by the subject, workspace member, public source, import, or AI retrieval provider;
- field-level citations preserve the exact source locator and extraction context used to support each value.

The existing person web-research provenance ledger should become the durable parent for AI retrieval references. An accepted AI suggestion must link to a research run, provider/model, prompt policy version, source references, reviewer identity, review timestamp, and the exact accepted/rejected field delta.

### Consent, lawful basis, and purpose

Extend `consentRecords` into a consent and purpose ledger rather than treating consent as a single boolean:

- subject/person, purpose, scope, status, effective interval, expiration, and withdrawal timestamp;
- consent notice/version and language presented to the subject;
- collection method and collector;
- evidence of consent, including signed document/file reference where applicable;
- lawful-basis category selected by the workspace policy, with free-text rationale and policy reference;
- permitted field classifications, cases, exports, AI processing, and sharing destinations;
- processor/provider disclosure for email, storage, search, and AI services;
- withdrawal effect: restrict, redact, delete, or review;
- reviewer and approval metadata for non-consent lawful bases.

Writes to a consent-required field must fail closed when no active consent/purpose record covers the field. A valid consent record does not bypass workspace authorization or retention rules.

### Cases and investigations

Add a case layer above people, facts, relationships, and evidence:

- case identifier, title, description, purpose, status, sensitivity, retention class, owner, and review schedule;
- case membership with role and expiration;
- explicit links between a case and people, facts, relationships, evidence, saved searches, AI runs, and exports;
- case-level consent/purpose scope, data minimization policy, and sharing policy;
- assignment queues for review, verification, consent follow-up, source reconciliation, and privacy requests, with assignee, priority, due date, status, and escalation history;
- explicit information-sharing boundaries for teams, roles, external collaborators, and export destinations;
- an activity timeline assembled from audit and evidence events without copying sensitive payloads into a denormalized feed.

People may exist in a workspace without belonging to a case. Case visibility must narrow access, never broaden it.

### Privacy requests and retention

Generalize deletion requests into a privacy request workflow supporting access, correction, portability/export, restriction, consent withdrawal, and deletion:

- requester identity and verification state;
- request type, scope, requested fields/cases, and deadline;
- review, approval, fulfillment, rejection, and cancellation states;
- generated export reference with redaction and provenance metadata;
- legal hold conflicts and documented exceptions;
- processor propagation status for files, email, search indexes, caches, and AI provider records;
- field-level redaction preview and encryption status for every generated export;
- completion evidence and audit event references.

Retention policies should be evaluated by scheduled jobs and at read/export time. Expired records are quarantined before deletion when review is required. Legal holds prevent destructive actions and are themselves auditable.

## Authorization and audit model

Authorization must evaluate, in order:

1. authenticated principal and active workspace membership;
2. API-key scope or user permission;
3. workspace and case membership;
4. resource sensitivity and field classification;
5. active purpose/consent/lawful-basis coverage;
6. retention and legal-hold state;
7. operation-specific approval requirements.

All reads of restricted data, bulk searches, exports, AI retrievals, consent changes, privacy-request actions, and break-glass actions produce audit events. Audit records include actor attribution, request ID, resource/case, purpose, outcome, redacted parameters, and rate/bulk indicators. Raw secrets and protected field values never appear in audit payloads.

Bulk-query and bulk-export thresholds are configurable per workspace and emit reviewable alerts before or during execution. Administrator activity is visible in the same audit surface as member activity. Break-glass access requires a reason, an expiration, a reviewer or post-hoc reviewer assignment, and an explicit list of resources; it is never a hidden bypass.

Introduce explicit approval records for:

- restricted-field access;
- bulk export or cross-case export;
- consent withdrawal with destructive effect;
- identity merge or relationship promotion from inferred to asserted;
- AI acceptance of multiple fields or relationships;
- legal-hold release and hard deletion.

Break-glass access, if retained for operational recovery, is time-bound, requires a reason, is visible to workspace administrators, and cannot be used by ordinary API keys.

## GraphQL/API surface

All operations remain GraphQL-backed and generated. Add bounded operations such as:

- `personConsentRecords`, `createConsentRecord`, `withdrawConsent`, and `consentCoverage`;
- `cases`, `caseById`, `createCase`, `linkCaseResource`, and `caseTimeline`;
- `sourceRecords`, `evidenceAssertions`, `factProvenance`, and `relationshipProvenance`;
- `privacyRequests`, `createPrivacyRequest`, `approvePrivacyRequest`, and `fulfillPrivacyRequest`;
- `pendingAiSuggestions`, `acceptAiSuggestion`, `rejectAiSuggestion`, and `reviewAiBatch`;
- `accessApprovals`, `requestRestrictedAccess`, and `reviewAccessApproval`;
- `retentionPolicies`, `legalHolds`, and administrative policy mutations;
- export mutations that require purpose, scope, approval, redaction profile, and an expiring download reference.
- faceted people/fact/source search with bounded filters for case, sensitivity, consent coverage, source reliability, temporal range, review state, and relationship state;
- timeline queries, source-comparison queries, duplicate/identity-candidate review, contradiction reports, and explainable graph-metric queries with bounded limits.

Mutations use the existing idempotency, optimistic-version, audit, and GraphQL error conventions. List operations use bounded pagination and never permit an unbounded “all people” query through a browser or API key.

## User experience

### Person workspace

The person page should have tabs or panels for Profile, Facts, Relationships, Evidence, Sources, Timeline, Consent & Purpose, Privacy Requests, and Audit. Every sensitive field displays its classification, source, confidence, consent coverage, and last review status. Missing consent is a blocking state with a clear explanation, not a silent omission.

### Evidence-backed graph

Graph nodes and edges display state, confidence, time range, source count, sensitivity, and case membership. Selecting an edge opens evidence and reviewer history. Inferred or disputed links use distinct visual treatments and are never styled as equivalent to corroborated relationships.

### AI review queue

AI suggestions appear as proposed field cards with checkboxes, evidence snippets, confidence, uncertainty, provider/model, and source links. The reviewer can accept individual fields, reject them with a reason, or defer. Batch acceptance requires an explicit scope summary and approval. Accepted values retain the original suggestion and reviewer decision forever unless privacy deletion rules remove them.

### Consent and privacy center

Workspace administrators can view purpose coverage, expiring consents, withdrawal impact, pending privacy requests, legal holds, retention warnings, and provider propagation status. Subjects or authorized representatives receive only the access, export, correction, or withdrawal flows permitted by workspace policy.

### Search, imports, and exports

Search results disclose which facets and fields were considered and omit fields outside the actor's purpose and sensitivity ceiling. Source comparison and contradiction views show competing assertions side by side with their citations rather than collapsing them into a single value. CSV, JSON, and document imports require a schema-mapping preview, validation report, provenance defaults, duplicate handling policy, and an explicit commit step. Exports show a redaction preview, scope, purpose, approval, expiration, and provenance manifest before the download reference is issued.

## AI and external search safety

External research is an explicit, user-started operation tied to a person, case, purpose, and approved source policy. The system records provider, query, time, returned references, and redaction rules. It must not scrape private accounts, evade access controls, or silently collect location/biometric data. Ollama and OpenAI-compatible providers use the same provenance and human-review contract. If no source can be cited, the result remains an unaccepted hypothesis and cannot be written as a fact.

## Security and identity controls

API keys have explicit scopes, expiration, revocation, last-used metadata, workspace binding, rate limits, and mandatory audit attribution. They cannot use browser-only session capabilities, bypass case/purpose checks, or retrieve secrets. User sessions retain the existing 2FA, backup-code, session-revocation, password-attempt, and CSRF protections; new governance operations must use the same request boundary. Secrets are encrypted at rest or held by the configured provider, and tenant isolation is tested at the database, service, GraphQL, search, import, export, and object-storage layers.

## Implementation sequencing

The implementation will be split into independently testable tranches:

1. **Governance primitives:** consent scope/lawful-basis extensions, field policy metadata, purpose coverage service, approval records, and privacy request state machine.
2. **Case and evidence links:** cases, memberships, resource links, provenance assertions, temporal relationship metadata, and case-scoped GraphQL operations.
3. **AI review hardening:** suggestion records, accept/reject/revise mutations, provider provenance, batch-approval safeguards, and review queue UI.
4. **Retention and privacy operations:** retention evaluation, legal holds, export/redaction workflow, provider propagation, and scheduled jobs.
5. **Research UI and analysis:** rich profile panels, graph evidence states, consent-aware faceted search, timeline/source comparison, contradiction/duplicate review, explainable metrics, and synthetic fixtures.
6. **Controlled data movement and security:** import schema mapping/validation, provenance-preserving CSV/JSON/document ingestion, export previews, API-key scope/revocation/rate-limit evidence, session/2FA regression coverage, bulk-query alerts, and administrator/break-glass review.

Each tranche must include schema metadata/migrations, generated GraphQL artifacts, focused unit/integration tests, authorization tests, audit assertions, and documentation updates. Tranches should be merged only after the full existing quality, build, database, Compose, browser, security, and generated-drift gates pass.

## Verification and acceptance

The release is not complete until the repository proves:

- a consent-required fact cannot be created or accepted without active purpose coverage;
- withdrawal prevents new reads/writes according to the configured effect and creates audit evidence;
- restricted fields remain hidden from unauthorized users and API keys;
- every accepted AI suggestion has source, model/run, confidence, reviewer, and exact delta provenance;
- inferred relationships cannot be promoted without explicit review;
- case membership narrows visibility and cannot cross workspace boundaries;
- exports are scoped, redacted, expiring, auditable, and provenance-preserving;
- retention and legal holds prevent unauthorized destructive actions;
- privacy requests are idempotent, versioned, auditable, and tested through completion;
- GraphQL pagination, complexity, rate, and export limits remain enforced;
- faceted search, timeline analysis, source comparison, duplicate detection, contradiction detection, and explainable graph metrics are backed by bounded GraphQL operations and authorization tests;
- CSV/JSON/document import previews preserve mapping, validation, provenance, and redaction decisions; exports are scoped and provenance-preserving;
- API keys enforce scopes, revocation, rate limits, tenant isolation, encrypted secret handling, and mandatory audit logging; session, 2FA, backup-code, and revocation behavior remains covered;
- bulk-query/export alerts and break-glass access create approval/audit records visible to administrators;
- synthetic fixtures cover rich profiles with names, aliases, pronouns, biographies, employment, education, public contacts, temporal addresses, languages, organizations, public identifiers, notes, custom fields, phones, competing facts, relationships, disputes, consent withdrawal, AI suggestions, and legal holds;
- no test or fixture contains real personal data or secrets.

## Operational and migration constraints

Existing records must remain readable. New governance fields should be nullable during migration, with a controlled backfill state that marks legacy records as `legacy_unreviewed` rather than fabricating consent. The application must fail closed only for new sensitive writes and acceptance operations until coverage is established; read behavior for legacy data follows current sensitivity grants and an administrator-visible remediation queue.

Every migration must be generated by Drizzle, checked for metadata drift, and accompanied by an explicit migration-count test update. Production migration application remains an operator action and must be verified against the hosted database before claiming production readiness.

## Decision

Use the additive governance-and-case approach. It provides the depth requested—detailed people, facts, relationships, source analysis, timelines, AI assistance, and operational controls—while preserving consent, explainability, minimization, and human accountability as enforceable product behavior rather than documentation-only promises.
