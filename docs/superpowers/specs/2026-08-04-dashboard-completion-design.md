# Dashboard Completion Design

**Status:** Approved under the standing instruction to adopt the recommended design as needed.

**Requirement:** `HUM-FR-027`

## Outcome

The workspace dashboard becomes a bounded, role-aware research summary rather than a recent-people-only page. It shows genuinely recent visible people and imports, recent deterministic graph and owned AI analyses, exact visibility-aware graph counts, a safe workspace policy summary, and owner/admin activity. The implementation closes `HUM-FR-027` only after owner and lower-privilege PostgreSQL, GraphQL, browser, responsive, and accessibility evidence passes.

## Current-state corrections

- The existing “Recently updated visible people” panel is incorrect because the generic people connection sorts by name. A dedicated recent-person read sorts by `updated_at DESC, id DESC`.
- Existing imports already sort newest first and retain backing-file visibility checks; the dashboard reuses that contract.
- Existing graph analysis history sorts oldest first. A separate recent-analysis read preserves the existing connection while adding a newest-first cursor contract for the dashboard.
- Existing AI analysis supports point reads but no history. A current-principal-only newest-first history query exposes the same public projection as the authorized point read.
- Existing graph result limits describe only returned/truncated records. A dedicated statistics read performs exact counts without transferring graph records.
- Existing audit and full policy posture are deliberately administrative. The dashboard conditionally requests audit only for `audit:read`; it never weakens that boundary. All members receive only a new safe workspace-default summary under `workspace:read`.

## Architecture

The browser and server component use one generated GraphQL document named `DashboardOverview`. It composes domain-owned root fields rather than introducing a monolithic dashboard repository:

- People owns recent-person ordering, person visibility, pagination, and its public projection.
- Imports reuses the existing authorized `imports(first: 5)` connection.
- Graph owns newest-first recent graph-analysis history and exact visible graph counts.
- AI owns current-principal analysis history and the existing safe public run projection.
- Settings owns the safe workspace defaults projection and keeps full policy administration separate.
- Audit reuses the existing newest-first connection and remains conditionally omitted for callers without `audit:read`.

This preserves the modular-monolith rule: generated operations call GraphQL, resolvers call domain services, and browser code never imports repositories.

## GraphQL contract

`src/graphql/operations/dashboard.graphql` defines one bounded operation:

```graphql
query DashboardOverview($includeActivity: Boolean!) {
  dashboardRecentPeople(first: 8) {
    nodes {
      ...PersonSummary
    }
  }
  imports(first: 5) {
    nodes {
      ...ImportWorkspaceItem
    }
  }
  dashboardRecentGraphAnalyses(first: 5) {
    nodes {
      id
      algorithm
      state
      startedAt
      completedAt
      createdAt
    }
  }
  dashboardRecentAiAnalyses(first: 5) {
    nodes {
      id
      provider
      model
      state
      startedAt
      completedAt
      createdAt
    }
  }
  graphStatistics {
    visiblePeople
    visibleRelationships
  }
  workspacePolicySummary {
    defaultRetentionDays
    aiEnabled
    storageEnabled
  }
  auditEvents(first: 6) @include(if: $includeActivity) {
    nodes {
      action
      resourceKind
      outcome
      occurredAt
      actor {
        kind
        label
      }
    }
  }
}
```

The generated operation never selects audit diffs, resource IDs, provider credentials, prompts, answers, object-storage coordinates, or restricted values.

### Bounds and cursors

- Recent people: maximum 10, default 8, cursor over `(updatedAt, id)` descending.
- Recent graph analyses: maximum 10, default 5, cursor over `(createdAt, id)` descending.
- Recent AI analyses: maximum 10, default 5, cursor over `(createdAt, id)` descending and bound to the current actor principal.
- Imports and audit retain their existing maximums; the dashboard requests 5 and 6 respectively.
- Invalid counts or cursors return the existing stable validation envelope.

## Authorization and privacy

Every query is workspace-scoped and authorization remains inside its domain service.

- Recent people apply current person visibility, grants, sensitivity ceilings, active lifecycle, and soft-delete predicates.
- Recent imports retain current backing-file and initiating-authority checks.
- Recent graph analyses retain current snapshot, graph-view, person, relationship, sensitivity, and grant authorization.
- Recent AI analyses require `analysis:read` and return only runs whose `actorPrincipalId` equals the current principal. They expose the existing safe provider/model/state/timing projection, never prompts, responses, upstream errors, or tool material.
- Graph statistics require `graph:read`, `person:read`, and `relationship:read`. A relationship counts only if it and both endpoint people are currently visible and live.
- Workspace policy summary requires `workspace:read` and contains only `defaultRetentionDays`, `storageEnabled`, and `aiEnabled`. Full policy names, resource kinds, ceilings, and deletion behavior remain owner/admin-only.
- Activity is requested only when the authenticated viewer already has `audit:read`. Lower roles receive an explicit “Activity is managed by workspace administrators” presentation rather than an authorization error.

API-key GraphQL callers may use domain fields according to their explicit scopes, but the application dashboard remains session-only through the existing app route/session boundary.

## Statistics execution

Graph counts run in a read-only transaction with the established short statement timeout. The repository issues count queries rather than loading nodes or edges. Person and relationship visibility predicates reuse `resourceVisibilitySql`; relationship counts join both endpoint people and apply visibility to all three resources. Counts return non-negative integers and do not identify hidden records. A timeout or database failure uses the stable public error envelope and never returns partial counts as success.

## UI and data flow

`src/app/(app)/dashboard/page.tsx` resolves the viewer, derives `includeActivity` from `audit:read`, executes `DashboardOverviewDocument`, and passes a normalized presentation model to `DashboardOverview`.

`src/components/dashboard/dashboard-overview.tsx` is a server-compatible presentational component with:

- a workspace/role header and permission-gated “Add person” action;
- concise statistic cards for visible people and visible relationships;
- recent people and recent imports lists with permitted destination links;
- a single recent-analyses list that merges graph and AI entries and sorts by creation time descending, visibly labeling each entry “Graph” or “AI”;
- a policy summary using text, not color alone, and a “Manage policies” link only for owner/admin;
- an activity list for owner/admin with actor, action, outcome, and `<time dateTime>`; lower roles see the explicit admin-managed state;
- explicit empty states for every panel. Empty owner states provide permitted setup actions; viewer states remain read-only.

Lists and descriptions use semantic `section`, `h2`, `ul`, `dl`, and `time` elements. The layout uses responsive cards and never introduces a wide table.

`loading.tsx` exposes one named status and panel-shaped skeletons without motion dependence. `error.tsx` exposes `role="alert"`, a retry action, and no nested `<main>`.

## Error handling

- Authentication/workspace failures continue through the existing app gate.
- Conditional activity omission prevents expected viewer authorization errors from poisoning the GraphQL response.
- Unexpected GraphQL or dependency failures route to the dashboard error boundary with a generic message and retry; no partial data is presented as a complete dashboard.
- Empty data is a successful state and uses specific copy rather than an error.
- Invalid or stale cursors use stable validation errors; the dashboard first page does not send cursors.

## Verification

### Repository and GraphQL

- Newest-first ordering remains stable when timestamps tie.
- Bounds reject zero, negative, and above-maximum values.
- Cross-workspace rows never appear.
- Person/relationship sensitivity and resource grants alter both lists and exact counts correctly.
- A relationship is excluded when either endpoint is hidden.
- AI history includes only the current principal and excludes prompt/answer/error/tool fields.
- Owner/admin activity returns only safe selected fields; viewer execution omits the field without GraphQL errors.
- Safe policy defaults are available to each built-in human workspace role without exposing full administrative policy details.
- Statistics timeout returns the stable public failure contract without partial success.

### Component and browser

- Owner sees all panels, Add person, Manage policies, and activity/Audit links.
- Viewer sees only authorized research data, safe feature flags, no creation/admin/audit links, and no hidden record identifiers or actions.
- Populated and empty workspaces both have explicit states.
- Recent graph and AI analyses merge in deterministic newest-first order with type labels.
- Keyboard focus, semantic headings, visible focus, reduced motion, non-color state labels, and axe checks pass.
- At 390x844, 320 CSS pixels/200% equivalent zoom, and RTL, the page has no horizontal overflow or clipped controls.
- Browser console, URLs, storage, rendered HTML, and RSC payloads exclude protected values, prompts, provider credentials, storage coordinates, and audit diffs.
- Existing public-route and graph JavaScript budgets remain unchanged or improve.

## Documentation closeout

`HUM-FR-027` changes to Complete only in the same commit that records passing real PostgreSQL, generated-operation, owner/viewer browser, accessibility, and responsive evidence. `TODO.md` removes exactly that one entry; all other incomplete MVP requirements remain unchanged.
