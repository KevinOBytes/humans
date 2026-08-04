# Architecture

## System boundary

Humans is a TypeScript modular monolith built with the Next.js App Router. The browser talks to Better Auth for identity flows and to GraphQL Yoga at `/api/graphql` for application data. Pothos defines the schema, GraphQL Code Generator produces typed operations, domain services enforce policy and orchestration, and Drizzle repositories own workspace-scoped persistence.

```text
Browser
  |-- Better Auth endpoints --> identity and sessions
  `-- generated GraphQL operations --> Yoga/Pothos resolvers
                                         |
                                  authorized domain services
                                  /      |       |       \
                           Drizzle     Redis    Storage   Resend/AI
                              |          |         |
                         PostgreSQL   leases     private S3
                                      limits     adapter
```

The browser must never import database repositories. Resolvers and background jobs share domain services so authorization, validation, workspace scoping, redaction, and audit behavior do not diverge.

## Authentication lifecycle

Better Auth remains the identity/session authority. `AUTH_REGISTRATION_MODE`
is a closed `disabled | invite_only | public` setting and defaults to
`invite_only` in validated server configuration. Invite-only signup uses an
outer application transaction and a nested Better Auth savepoint. Its
case-normalized live-invitation lookup locks the invitation/workspace and a
database create hook revalidates expiry plus active/non-deleted workspace state
immediately before insertion; rejection rolls back user and credential rows.
The request-scoped mail sender writes the exact verification message into a
dedicated authentication-email outbox in that same transaction. Recipient and
signed URL are AES-256-GCM sealed with the authentication encryption key; only
an integrity hash, an `AUTH_SECRET`-HMAC idempotency key, and bounded delivery
metadata remain queryable. Registration-allowed telemetry and provider delivery
wait until the outer commit, so no mail or success event occurs while invitation
and workspace locks are held. Resend receives the stable idempotency key;
generation-fenced PostgreSQL leases, exponential retry, the persistent Docker
worker, and the bounded Vercel jobs route provide crash-safe at-least-once
dispatch. The Resend transport passes an abort signal to `fetch`, streams a
bounded response, and cancels provider I/O after five seconds. A dedicated
indexed worker cleanup removes at most 100 expired intents per transaction;
completed intents expire after seven days and dead letters after thirty days.
Request-time exact-ID drains never perform retention work. Signup does not consume the invitation. Verification
and application-owned recipient-bound acceptance remain separate. Acceptance
locks and revalidates the invitation, active/non-deleted workspace, verified
recipient, role, expiry, and prior membership, then creates the membership and
consumes the invitation in one PostgreSQL transaction. Workspace activation follows that durable commit;
an activation failure is recoverable through workspace selection.

The Next auth catch-all continues to deny administrator/member/API-key mutation
paths before importing Better Auth. Member administration instead uses
application-owned generated GraphQL operations. Issue, resend, cancel,
role-change, and removal lock current workspace authority and the workspace
owner invariant inside the mutation transaction, then commit the domain write,
principal-bound HMAC idempotency record, and redacted audit event together.
Canceled or replaced invitations terminalize queued mail transactionally, and
the outbox claim query filters invalid invitation intents before its bounded
limit so stale work cannot starve valid mail. API-key headers are rejected for every
interactive auth route, including mixed cookie/key requests. Ordinary signup, verification, sign-in,
sign-out, recovery, and enrollment routes remain delegated. Direct Better Auth
invitation acceptance and 2FA disablement are denied before import in favor of
same-origin, cookie-session-only application endpoints; API keys cannot invoke
them. Better Auth reads only an internal client-address header created after
the deployment-specific trust classifier removes caller spoofing. Without a
verified address, signup, sign-in, and recovery receive `AUTH_SECRET`-keyed,
normalized-target fallback buckets. PostgreSQL stores those rate limits so app
instances share a budget. The application-owned 2FA password boundary adds an
atomic five-per-five-minute PostgreSQL counter bound by HMAC to trusted client,
user, and operation before hashing. Every delegated response carries a
sanitized request ID, and JSON errors carry the same value. Loader,
preparation, delegated-handler, and transaction failures are contained as the
same no-store generic `503` and emit only a redacted correlated infrastructure
event. Public lifecycle events are correlated, structured,
and omit identifiers, credentials, tokens, TOTP secrets, and backup codes.

Invitation links reach the browser as fragments and are scrubbed synchronously.
The client exchanges the identifier for a short-lived AES-GCM handoff stored in
an HTTP-only, SameSite=Strict cookie. Authentication return paths therefore
contain no invitation credential; an authenticated same-origin request reveals
the identifier only to ephemeral client state immediately before acceptance.

Password-reset links stay on the configured origin. The reset callback reaches
the Better Auth token validator, and the UI boundary moves the validated action
token from the query into a client-only fragment before rendering so it is not
serialized into initial HTML or React Server Component data. The client
captures the fragment once and immediately replaces browser history with the
token-free path before enabling the form; invalid, failed, replayed, and
abandoned flows perform the same scrub. A successful reset revokes all sessions
and requires a new sign-in.

TOTP secrets and backup codes are encrypted at rest. QR/manual secrets and
plaintext backup codes exist only in explicit client presentation state and
are wiped by finish, cancel, navigation, or component disposal. Verification
immediately removes the QR/manual secret while preserving backup codes until
acknowledgement. Disabling an enabled factor locks and verifies the credential,
clears the user flag, deletes factor and trust-device material, and revokes all
sessions in one PostgreSQL transaction, so a fresh login is mandatory. Backup-
code regeneration atomically replaces prior unused codes.

## Runtime responsibilities

- **PostgreSQL** is authoritative durable storage, including durable jobs.
- **Redis** provides rate limiting, cache entries, short coordination, and leases. It is never the only copy of application data.
- **S3-compatible storage** holds private uploaded objects through one adapter for R2, S3 services, and MinIO.
- **Resend** delivers verification, password-reset, and invitation email.
- **OpenAI-compatible endpoints** provide analysis behind a provider-neutral adapter. Models receive only approved read-only tools.
- **Worker execution** processes bounded durable job batches. Vercel invokes batches on a schedule; Docker runs the same executor continuously.

## Data flow and trust boundaries

1. A request authenticates as exactly one mode: browser session or API key.
2. Request context resolves the actor, active workspace, membership, explicit permissions, request ID, scoped loaders, and services.
3. A domain service validates input and authorization before calling a repository or external provider.
4. Every repository operation requires `workspace_id`; cross-resource references are checked against that workspace.
5. Mutations use optimistic versions and idempotency keys where retries can occur, then write a redacted audit event.
6. Files remain quarantined until checksum, size, type, and configured scan policy checks succeed.

### Private file lifecycle

Upload-session ownership is bound to a session user, not merely a workspace.
Creation persists a server-generated controlled key and schedules expiration
cleanup before returning a short-lived checksum-bound upload grant. Every
supported provider (MinIO, R2, and generic S3) returns the same opaque
application storage route; GraphQL-visible URLs never contain provider
endpoints, buckets, workspaces, or object keys. Listing,
regrant, and cancellation require `file:create`; API keys cannot invoke these
user-bound recovery operations. Regrant locks and revalidates the same pending,
unexpired session before signing its existing key. Cancellation locks the
session against completion, atomically changes only `pending` to
`cleanup_pending`, clears prior cleanup completion, advances the existing
durable cleanup job to the present, and writes a redacted audit event before a
best-effort exact-key delete.

The opaque route also defines the hosted upload envelope. In `vercel` mode,
upload-session creation rejects every purpose above 4 MiB before storage
configuration reads, rate limiting, persistence, grants, jobs, or audits. The
response remains the stable validation error and exposes no provider or hosting
detail. In `docker` mode, the purpose limits remain 50 MiB for evidence, 25 MiB
for CSV imports, and 10 MiB for JSON imports. Server-rendered upload controls use
the same deployment-aware limit function, display the active limit, and reject
oversized local selections before hashing or GraphQL execution.

Files expose only safe variant metadata through workspace- and visibility-
scoped services. Provider, bucket, and object keys remain repository/worker
details. Archival requires `file:delete`, revalidates live user or API-key
authority inside the write transaction, locks the visible file, applies its
expected version, primes the archived mutation result, and enqueues a durable
file-target cleanup. The worker locks the persisted primary and variant
locations, rejects runtime/provider location drift, deletes only those exact
keys, revalidates the location set, and then records redacted completion.

The required production-like acceptance signs in to the built Compose
application, drives create/complete/archive through `/api/graphql`, uploads
through the exact returned application grant, and observes the continuously
running worker complete primary-and-variant cleanup while a sibling sentinel
survives. Direct PostgreSQL and MinIO access in that harness is limited to
fixture arrangement and outcome assertions.

Protected exact values use purpose-separated envelope encryption for display
material and a different, workspace-bound HMAC key for equality lookup. The
v1 blind indexes are not reversible search text, and legacy version-null rows
are intentionally excluded. The authorized lookup service composes protected-
row and person visibility inside fixed SQL before keyset pagination. It is an
internal Task 12A foundation; Task 12 exposes it only as the canonical search
union's protected-exact branch, which returns authorized person identity rather
than protected material. Contact CRUD remains incomplete.

Research writes call one required transactional search-index maintainer after
their audit event. The GraphQL runtime and durable import worker inject the
concrete maintainer, which loads the authoritative source through the supplied
Drizzle transaction, derives allowlisted redacted contributions, and replaces
that source's versioned documents before commit. A maintainer failure therefore
rolls back the source mutation, audit event, and search read model together. A
disabled implementation exists only for explicitly isolated tests.

## Search read model and execution

Migration `0009_task12_search_analysis` replaces the provisional aggregate
search row with one bounded contribution per authoritative source and chunk.
Each contribution records workspace, source identity and version, public result
identity, optional subject person, sensitivity, schema version, redacted title,
safe body/display text, and a generated `simple`-configuration `tsvector`.
PostgreSQL weights the title above the body and maintains the vector; a GIN
index serves text matching while workspace-leading source, result, subject, and
pagination indexes support maintenance and policy joins.

The allowlist currently indexes non-protected person display names and names,
active/searchable fact-definition labels with only approved typed values,
labels for live relationships with live endpoints, source titles, and address
locality/region/postal/country through a live person-address association. Search
reads independently authorize both relationship endpoints. Phone numbers,
email addresses, identifiers, ciphertext, blind indexes, exact coordinates,
free-form fact text, note/excerpt/evidence-item
text, file metadata/content, quarantine data, and import payloads never enter
the full-text read model. Sources without an accepted redaction-safe field
remove any prior contribution.

Text input is a closed v1 contract: NFKC-normalized, 1–256 UTF-8 bytes, at most
16 searchable terms, and bounded phrases, `OR` operators, negative terms,
filters, temporal values, page size, and cursor. Fixed result-kind SQL branches
apply workspace, lifecycle, sensitivity, grants, relationship-endpoint, source,
and version-freshness predicates before `websearch_to_tsquery`, ranking,
deduplication, keyset pagination, and limit. Structured snippets are built from
already-redacted display text and returned as plain `{text, matched}` parts.
Protected exact PHONE and PERSON_IDENTIFIER searches use the separate
workspace-bound blind-index service and return only currently visible people;
their submitted values never enter full-text search.

Search and saved-query cursors are versioned, purpose- and workspace-bound HMAC
envelopes. Search pages are deliberately uncached. The bounded
`search:reindex` command pages one workspace and source family ordering,
supports dry-run and batches of 1–500, and applies every batch transactionally.

## Saved searches and deterministic graph records

Saved searches persist only a strict `humans.search-query` v1 AST, canonical
SHA-256 hash, owner principal, PRIVATE or WORKSPACE sharing, optimistic version,
and archive metadata. The AST excludes cursors, actor/workspace identity,
protected exact input, arbitrary GraphQL, variables, and SQL. API keys cannot
own a saved search; only the owning session user can update or archive it.
Reading and running always reapply current permissions, encoded resource scopes,
and result authorization. Query runs attribute the current USER or API_KEY
workspace principal and retain only safe timing/count/outcome metadata.

Graph snapshots are immutable reproducibility manifests for current authorized
data, not historical archives. The stored canonical material includes the
normalized graph query, actor/principal authorization vector, people,
relationship and relationship-type version vectors, algorithm/version/config,
and runtime contract. Domain-separated hashes cover the query, authorization,
configuration, and complete manifest; denormalized columns are checked against
the canonical material on read. The manifest is bounded to 10,000 people,
25,000 relationships, 25,000 relationship types, reviewed authorization-vector
caps, and 32 MiB.

Replay reauthorizes the snapshot and optional saved view, rebuilds the bounded
graph in a repeatable-read transaction, recomputes the manifest, and compares
membership, every stored version, authorization, query, algorithm/config, and
runtime contract. Any accepted drift returns only `{valid: false, snapshot:
null}` and records `graph_snapshot.invalidated`; it never reports changed IDs or
mutates the stored snapshot. A new analysis or snapshot is a separate operation.

Degree, PageRank, and seeded Louvain community analysis reuse the canonical
Task 10 graph result and fixed algorithm contracts. Analysis runs, typed hashed
results, and per-person metrics are stored coherently with a snapshot and audit
event. Reads and exports reauthorize the whole manifest in SQL before page
limits. JSON exports use a versioned envelope; CSV exports use a fixed column
set and neutralize spreadsheet-formula prefixes.

## Cited AI analyst execution

The browser analyst imports only generated `StartAiAnalysis`, `AiRun`, and
`CancelAiAnalysis` documents and sends them through the shared browser GraphQL
adapter. The `/analyst` server page is non-disclosing without `analysis:read`;
start and cancel controls are independently gated by their exact permissions.
Questions and optional person/evidence UUID scopes remain body data and are
never serialized into URLs, storage, or server-rendered HTML.

Starting a run atomically creates principal-attributed thread/message/run,
idempotency, audit, and `ai_execute` job records. Prompt and answer material is
sealed with the existing data-encryption boundary; low-entropy request and
configuration identity uses domain-separated HMACs. Jobs contain only the run
UUID. The worker uses the shared PostgreSQL claim generation and Redis lease,
reauthorizes the principal and each allowed resource boundary, and commits one
fenced terminal result.

The provider boundary supports canonical OpenAI, the configured Docker/loopback
Ollama endpoint, and a public-DNS-revalidated HTTPS compatible endpoint. It
rejects redirects and maps transport material to stable errors. The model can
request exactly `getEvidence`, `getPerson`, `searchGraph`, and `searchPeople`;
those handlers call authorized domain services and cannot expose SQL, arbitrary
GraphQL, network, filesystem, or mutation access.

Candidate citations are accepted only when returned by an allowed tool in the
same run and still visible at persistence and read time. GraphQL publishes only
validated person/evidence UUIDs, claim/locator text, provider/model disclosure,
and approved tool names/states with count-only summaries. The UI links a person
UUID to its existing first-party record route; evidence UUIDs remain non-link
labels because there is no safe standalone evidence-item route.

## Operation budgets and observability

Search reads, saved-query runs, snapshot creation/replay, deterministic analysis,
and result export consume fixed-cost Redis token buckets before expensive work.
The shared limiter uses the same server-time Lua contract with local Redis or
Upstash, applies the primary actor or workspace dimension plus a trusted
client-prefix dimension where configured, and HMACs every Redis key. Denial is
`RATE_LIMITED`; Redis failure is `PROVIDER_UNAVAILABLE`; neither condition
enters a resolver repository path.

The application and worker emit reviewed Task 12 counters and histograms through
a production structured-event sink. Names and label values are closed and
low-cardinality; workspace, actor, query, cursor, resource, request, IP, and
Redis-key values are rejected. An explicit no-op sink is reserved for tests,
and observability failures cannot change product behavior.

## Deployment parity

`DEPLOYMENT_MODE` discriminates `vercel` and `docker`, while application-level database, Redis, storage, email, auth, administrator, and AI variables stay consistent. Docker Compose includes `app`, `migrate`, `worker`, `postgres`, `redis`, `minio`, and `minio-init`; Ollama is an optional profile. The Docker worker runs continuously. Vercel uses managed equivalents and invokes the same bounded runtime through the `CRON_SECRET`-protected `/api/jobs/run` route. The committed five-minute schedule requires Vercel Pro or Enterprise; Hobby deployments must use a daily schedule under current Vercel limits.

Client-address trust is deployment-discriminated too. `none` trusts no
forwarding header. GraphQL limiters deliberately share their `unknown` client
bucket; authentication uses the target-bound fallback described above. `vercel`
is valid only for Vercel deployments and accepts the platform-owned
single-address header. Docker may opt into `hmac`, where an isolated edge proxy
must strip inbound Humans and forwarding headers, replace them with the network
peer address it directly observes, and canonicalize and sign that observed peer
rather than a client-supplied forwarding value. It must be the application's
only network path; the application port must not be directly reachable.
Missing, malformed, or unauthenticated metadata falls back to the subsystem's
documented untrusted-client behavior.
Limiter keys HMAC the operation class, workspace, dimension, and subject under
a separate key, so Redis never receives raw actor, API-key, workspace, or
client-prefix identifiers.

Production readiness depends on successful migration before application readiness. Liveness checks process health; readiness checks validated configuration and dependency reachability without exposing credentials.

## Architectural decisions

- UUIDv7 domain identifiers provide global uniqueness and insertion locality without a database extension.
- Flexible facts use governed definitions and sparse typed values, not an unbounded entity-attribute-value store.
- Multiple current, historical, or contradictory facts are valid; accepted presentation fields are explicit selections.
- PostgreSQL full-text search is the default. Embeddings and pgvector remain optional.
- Coordinates use portable numeric columns; PostGIS is not an MVP prerequisite.
- AI models cannot execute generated SQL or arbitrary GraphQL.

## Protected contacts and locations

`src/modules/locations` extends the existing `contact_points`, `places`,
`addresses`, `person_contact_points`, and `person_addresses` tables. Phone and
email display values use AES-256-GCM purpose-separated envelopes and
workspace-bound v1 blind indexes; extensible `other` contacts are encrypted but
deliberately not equality-searchable. Reads apply workspace, lifecycle,
sensitivity, policy, and grant predicates before decryption; failure is a
closed safe error.
Structured address columns remain queryable domain data, while a
workspace-bound deterministic HMAC identifies normalized duplicates without
putting full address text in audits.

Partial unique indexes enforce current-primary invariants. Writes lock the
owning person before replacing the applicable primary. Association archival is
soft; when it is the last live link, the contact or address is soft-archived in
the same transaction. Address writes maintain the redacted `person_address`
search contribution. Contact writes never index plaintext. Audit metadata is
limited to IDs, kinds, primary state, and versions.

Every contact, place, and address mutation claims a durable identity keyed by
workspace, principal, operation, and a keyed hash of the idempotency key. A
second keyed hash binds canonical request material without persisting protected
plaintext. PostgreSQL advisory transaction locks serialize first claim and
expiry takeover; the claim, domain write, audit, search maintenance, and exact
UUID/version response reference commit atomically. Replays revalidate the live
session or API key, exact permissions, resource visibility, and stored response
shape before returning or decrypting anything.

Place hierarchy writes serialize on the workspace and a recursive database
trigger rejects self, two-node, deeper, and concurrent cycles. Evidence links
are validated in the write transaction and projected only through the existing
visibility-aware evidence DataLoader. Address rows join authorized reusable
places in their bounded connection query, avoiding per-node place lookups.

Location cursors bind version, workspace, purpose, ordering, and parent under
an HMAC. Place cursors use PostgreSQL's exact `lower(name COLLATE "C")` key for
selection, comparison, ordering, indexing, and cursor serialization. The shared
permission parser recognizes `contactPoint`, `place`, and `address`. Production
image smoke exercises PostgreSQL, Redis, MinIO, migrate, app, worker, protected
storage, and tenant isolation as one private-backend deployment.
