# Product and interface design

## Product principles

Humans presents research claims with their provenance and uncertainty. The interface must not silently collapse contradictory facts, imply certainty that the data does not support, or hide why a result is visible. Security state, processing state, and model/provider disclosure should be understandable without exposing secrets.

## Visual system

Use Tailwind CSS, accessible headless primitives, reusable application components, Lucide icons, and restrained motion. Typography, spacing, color, focus treatment, validation, empty states, and loading states should remain consistent across record, graph, and settings surfaces. Add visualization libraries only for a demonstrated requirement.

Sigma.js and Graphology render large social networks through WebGL. React Flow supports a smaller, focused relationship editor. Graph encodings must pair color with shape, labels, line style, or another non-color cue.

## Primary surfaces

1. Authentication: sign in, policy-controlled registration, verification, recovery, TOTP, and backup codes.
2. Workspace setup: workspace selection/creation, invitations, roles, retention, storage, and AI policy.
3. Dashboard: recent people, imports, analyses, activity, and concise graph statistics.
4. People and profile: searchable records plus names, facts, relationships, timeline, evidence, files, notes, and activity.
5. Graph explorer and relationship editor: search, filters, temporal range, layout, paths, selection inspection, saved views, and focused node/edge editing.
6. Research search and AI analyst: full-text/structured/protected-exact search, saved queries, scoped questions, run progress, cited results, count-only tool summaries, and provider disclosure. Task 12 implements search and deterministic graph analysis; Task 13 implements the permission-gated model-backed analyst workflow.
7. Evidence and imports: upload status, quarantine/processing, mapping preview, row errors, and idempotent retry.
8. Settings: members, invitations, API keys, workspace policy, audit trail, integrations, and deployment diagnostics.

## Interaction rules

- Show contradictory and historical facts together with state, confidence, time, and evidence.
- Use stable error codes and actionable field-level validation; conflicts are not generic server errors.
- Preserve resumable state for imports, uploads, AI work, and provider failures.
- Require explicit confirmation for destructive or high-impact actions.
- Reveal restricted data only after authorization; avoid sensitive values in URLs, analytics, logs, and notifications.
- Keep graph selections synchronized with an inspector and provide a tabular equivalent.

### Evidence file behavior

`/evidence` places the current user's pending uploads above the visible file
table. Each pending item shows its name, size, expiration, an exact-file resume
control, and cancellation. The browser hashes a reselected file and compares
its name, byte length, and SHA-256 digest before asking the server for a new
grant; a mismatch never uploads bytes or calls completion. Status changes use
assistive-technology alerts, provider/object details are replaced by bounded
public messages, and the initiating control retains or regains visible focus.
Cancel and archive controls include the affected filename in their accessible
names. After a successful removal, focus moves to the durable workspace-files
heading before refresh so it does not depend on a control that was removed.
Read-only viewers load only visible file metadata and do not request the
permission-gated pending-upload connection.

Only clean, available files offer download. Archival uses the file version
rendered with the row, requires explicit confirmation, announces the outcome,
restores focus, and refreshes the route after success. Pending recovery and
file archival use checked-in generated GraphQL operations rather than ad hoc
browser requests.

Authentication surfaces use identical public failure language for unavailable
registration details and password recovery. Authenticated shells and the
workspace-selection gate always expose a keyboard-accessible sign-out action.
Enrollment reveals a QR/manual key and backup codes only after password
reauthentication; leaving setup cancels the pending factor. Enabling or rotating
backup codes requires an explicit saved-codes acknowledgement. Disabling 2FA
requires the password, atomically removes every factor and trusted device,
revokes every session, and returns to sign-in. Once TOTP verification succeeds,
the QR and manual secret disappear immediately while backup codes remain for
the explicit acknowledgement. Password-reset fragments are captured once and
removed from browser history before the reset form becomes usable.
Interactive auth requests with API-key headers always fail closed, including
mixed cookie/key requests. Delegated errors show a support-safe correlation ID
that matches the response header.

Invitation acceptance atomically creates membership and consumes the pending
invitation only while the locked workspace remains active and non-deleted. All
unavailable invitation states share one public status and message. Activating
that workspace is a later convenience step: if it fails,
the durable membership remains and the workspace selector provides recovery.
Invitation links are scrubbed from browser history before the acceptance view
becomes usable and never appear in sign-in or sign-up return URLs.

The members settings surface loads its safe directory after hydration and never
serializes invitation action identifiers into initial HTML. Owners can invite
and assign admin, analyst, contributor, or viewer; admins can invite and manage
only analyst, contributor, or viewer. Destructive actions require confirmation,
disable while pending, announce outcomes, and cannot target the current actor or
remove/demote the last owner. Lower-privilege users receive one generic
unavailable state rather than workspace or membership details.

## Search and deterministic analysis behavior

The `/search` workbench presents Text and Protected exact as explicit modes.
Text mode offers allowlisted result-kind, sensitivity, subject, definition,
relationship-type, source, state, and temporal filters plus a bounded page-size
selector. Protected mode accepts either a masked phone value or a masked person
identifier plus namespace, constrains output to people, and cannot be saved.
Neither mode writes submitted values to the URL or browser storage.

Results use semantic lists, redacted titles, kind/update metadata, and plain
snippet parts. Matching text is rendered by React as `<mark>` content rather
than server HTML. Empty, invalid/conflict, rate-limited, unavailable, and neutral
not-found outcomes use bounded status messages that do not echo the query or a
protected value. Pagination rejects missing, repeated, or non-advancing cursors.

Session users with the full saved-query permission set can create PRIVATE or
WORKSPACE searches. The interface explains that workspace sharing never grants
data authority and that only the owner can update or archive. Loading or running
a saved query visibly states that current authorization applies. The component
discards stale in-flight search and saved-query responses and clears all local
state when the workspace identity changes.

The graph explorer's Structural analysis panel discloses each deterministic
algorithm and its cap: Degree supports up to 10,000 people and 25,000
relationships; PageRank and seeded Louvain community support up to 2,000 people
and 10,000 relationships. Copy explicitly frames results as structural
calculations over the current authorized snapshot, not truth, importance,
affiliation, or trust.

Authorized users can create a reproducibility snapshot, check validity, create
a new analysis from a prior snapshot, page prior runs and results, and download
fixed-shape JSON or CSV exports. New and stored metrics render in named semantic
tables with algorithm versions, ranks, values, and explanations. Generic
invalidation says only that current authorized data is no longer reproducible;
the UI never enumerates changed or newly restricted records.

## Cited analyst behavior

`/analyst` is available only with `analysis:read`. The question form requires
both create and run permissions, while cancellation requires its separate
permission. A deliberate valid submit creates one fresh random idempotency key;
the key is reused only when retrying that same failed start. Active work blocks
duplicate submission and polls with an abort-safe bounded exponential delay
that ends on a terminal state, workspace change, or component disposal.

Queued, running, completed, failed, and cancelled states use semantic headings,
polite announcements, visible focus, and no motion dependency. A completed run
shows the protected answer, provider/model, and only citations that survived
server validation. Person UUIDs can link to the existing first-party profile;
evidence citations remain text because an evidence UUID alone cannot form a
safe resource route. Tool activity shows only approved names, state, and fixed
count/truncation fields—never arguments, result bodies, or upstream text.

The surface does not persist a question or place it in navigation state. Stable
client copy does not echo prompts, provider transport errors, credentials, or
base URLs. Layouts use wrapping, fluid grids, reduced-motion-safe transitions,
and touch-sized controls for mobile and 200% zoom reflow.

## Accessibility and responsive behavior

Desktop layouts prioritize graph exploration; mobile layouts prioritize record review. Every workflow must support keyboard navigation, visible focus, semantic headings and landmarks, sufficient contrast, reduced motion, and screen-reader labels. The graph requires an accessible tabular fallback with equivalent discovery and navigation. Touch targets and reflow must remain usable at mobile widths.

## Contacts and places

The person profile includes a `Contacts & places` view. It requests protected
contact values only through an authorized server GraphQL response and never
places them in links, query parameters, hidden markup, analytics, or browser
logs. Empty states say that no _authorized_ records are available so absence
does not imply that a protected record does not exist.

Task 18 provides labelled create and edit forms for phone, email, and other
protected contacts, reusable places, and structured addresses, plus explicit
archive confirmation. Primary badges are scoped by contact usage or address
kind. Stale optimistic versions produce a visible reload-and-retry message;
archive failures remain in an assistive-technology alert. The browser contract
covers desktop and mobile reflow, keyboard controls, an axe scan, protected
input exclusion from URLs, and absence of console errors.
