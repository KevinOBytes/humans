# Contact and location GraphQL API

Task 18 exposes a partial generated GraphQL surface at `/api/graphql`:

- `Person.contacts(first, after)` requires `contactPoint:read` and returns only
  authorized, decrypted PHONE projections.
- `Person.addresses(first, after)` requires `address:read`; linked places are
  returned only when they independently pass `place` visibility.
- `places(first, after)` requires `place:read`.
- `createPhoneContact`, `updatePhoneContact`, and `archivePhoneContact` require
  the corresponding `contactPoint` action.
- `createPersonAddress` and `archivePersonAddress` require the corresponding
  `address` action. A supplied place must be independently visible.
- `createPlace` requires `place:create`.

Page sizes are bounded to 1–100 and charged through complexity multipliers.
Cursors are HMAC tokens bound to workspace, purpose, order, and person (or the
workspace for place listing). Mutation payloads use the standard `issues`,
`code`, and `currentVersion` envelope. Protected values, raw idempotency keys,
blind indexes, normalized hashes, and full address text are excluded from audit
metadata.

Mutations currently validate an `idempotencyKey`, but this slice does **not**
yet provide durable response-reference replay. Clients must not assume retries
are deduplicated until `HUM-NFR-008` is complete. Email/other contacts,
existing-record link operations, address update, and place update/archive are
also not yet public operations.
