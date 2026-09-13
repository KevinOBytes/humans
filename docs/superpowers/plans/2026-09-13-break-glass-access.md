# Break-glass access workflow

**Goal:** Add a bounded, explicit, time-limited break-glass grant for exceptional access to a workspace-scoped list of resources. Every request, review, use, and revocation is auditable; API keys cannot request or use this path.

**Constraints:** No hidden administrator bypass, no broad workspace grant, no autonomous decision-making, and no weakening of ordinary visibility, consent, case, or redaction checks. A grant must enumerate resource kind/id pairs, include a purpose and justification, have an expiry, and be reviewed by a different owner/admin.

## Ledger

- [ ] Add failing validation and authorization tests.
- [ ] Add schema/migration and domain service.
- [ ] Add GraphQL operations and generated artifacts.
- [ ] Add focused integration coverage and documentation.
- [ ] Run gates and commit.

## Rulings

- Use a dedicated request/resource pair of tables rather than overloading field-level access approvals. This preserves explicit resource enumeration and avoids changing existing consent approval semantics.
- Let active grants participate only in resource visibility and restricted-fact authorization. Existing consent/purpose coverage remains mandatory, and case visibility still intersects the result.
