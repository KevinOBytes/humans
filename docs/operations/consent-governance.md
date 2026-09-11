# Consent-governed research UI checkpoint

## Workflow

Open an authorized person record, choose **Consent & Purpose**, enter the actual
purpose, select the operation and supply field/case scope when relevant. A denial
blocks the stated operation; a successful check is only an observation, not a grant.
Every processing operation must revalidate server-side. Public visibility and
confidence are not consent.

Open `/cases` for membership-scoped cases and paginated linked resources. Following
a person link rechecks access but does not carry case authority to unrelated pages.
Review competing claims and evidence before changing data. The focused graph editor
retains explicit confirmation and optimistic versions; it has no evidence-state
promotion control. AI proposals continue to use the existing human review queue.

## Limits

- Non-public fact values, provenance, temporal context and selection actions are
  now withheld from server-built profile projections and contradictory-claim
  summaries. Public fact projections remain visible under existing server access
  checks. A request-bound field disclosure flow is still required to reveal
  non-public values; a previous client coverage check never unlocks them.
- Workspace policy settings are not a complete consent/privacy administration UI.
  The new **Privacy Requests** tab provides person-scoped retention/hold metadata
  and authorized request-ID/processor-status lookup. The API has no person-filtered
  request listing, so lookup never claims an association with the current person.
  Full consent, request, hold and case CRUD surfaces remain pending.
- Graph source counts/case memberships are absent from the generated projection.
- Existing graph downloads serialize loaded data. The new scope notice is not an
  export authorization gate; server-validated preview/export work remains pending.
- Legacy backfill and target-environment migrations must be rehearsed against
  preserved copies and verified separately. This UI change does not apply hosted
  migrations, validate lawful basis or prove external provider propagation.

## Local verification

Focused component tests: `person-governance-panels`, `case-workspace`,
`person-profile-fields` and `graph-accessibility`. Synthetic fixtures use fictional
identities, reserved `.test` contacts and a fictional NANP phone number; they are
not production exports. Component tests prove UI contracts, not backend enforcement.

The following targeted browser command was attempted on 2026-09-11:

```sh
pnpm test:e2e tests/e2e/consent-governance.spec.ts tests/e2e/research-core.spec.ts --grep 'consent panel checks|person research loads governed'
```

Next development servers started, but fixture construction stopped test collection
with `TEST_DATABASE_URL is required`. No browser acceptance test ran. The command
reuses the existing AI acceptance journey instead of duplicating that test into a
new spec. Authenticated local/hosted/provider acceptance remains unverified.

Final local gates on Node 24.19.0: formatting, lint, typecheck, database migration
check/drift, Better Auth schema comparison, generated GraphQL comparison and the
production build passed. The full Vitest run reported 166 files / 1,464 tests passed,
with 72 files / 598 tests skipped; skipped service-backed tests are not acceptance
evidence. The standalone production server started on loopback and
`GET /api/health/live` returned HTTP 200 with `status: ok`. This is a process-health
smoke only, not authenticated application, database readiness or hosted proof.

The follow-up fail-closed fact projection and read-only Privacy Requests panel
have 14 passing focused tests across six files. This is bounded UI/server-projection
evidence: it does not close governance coverage for every contact, attachment,
overview, graph or other person-record surface. Those require a complete field/
resource coverage audit and authenticated request-bound disclosure verification.
