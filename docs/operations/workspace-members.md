# Workspace member operations

## Authorization and role matrix

Workspace member and invitation changes are available only to cookie-session
actors through generated GraphQL operations. API-key and mixed cookie/API-key
requests fail before the member service runs.

- Owners may invite or assign `admin`, `analyst`, `contributor`, and `viewer`.
- Admins may invite or manage only `analyst`, `contributor`, and `viewer`.
- Neither role may use this boundary to assign `owner`, act on itself, or remove
  or demote the workspace's last owner.

Every mutation supplies a fresh UUID idempotency key. The server binds its HMAC
to the workspace, actor, operation, and request body. An exact replay returns
the stored safe result; changed input, another actor, or another workspace does
not inherit the original authority.

## Invitation lifecycle

Issue normalizes the recipient email and creates at most one live pending
invitation per workspace and recipient. Resend creates a replacement email
intent while retaining the invitation action ID. Cancel and replacement
mark queued outbox intents terminal inside the same transaction. Cancellation
returns an unchanged/retry result while a matching intent is already running,
so it cannot commit while provider delivery may still occur. The worker locks
and revalidates pending status, expiry, and active workspace state while
claiming work, so cancel-first prevents a later claim and canceled or expired
rows cannot consume the bounded claim window.

Invitation recipient and link content are AES-GCM sealed in PostgreSQL, and new
mail carries the opaque action credential in the URL fragment from the outset.
The authenticated directory deliberately returns recipient email and opaque
action IDs to client-only state so authorized administrators can act; these are
not serialized into initial HTML/RSC, URLs, browser storage, logs, audits, or
generic errors. Mutation payloads return only an opaque action ID, closed result
code, and request ID. Ciphertext and provider responses never cross the API.
Resend receives the stable outbox idempotency key.

## Member changes

Role changes and removals lock current actor authority and serialize the
workspace owner invariant. Removing a member clears `activeOrganizationId` on
that user's sessions only when it names the affected organization; it does not
delete session rows. Memberships and active session context for unrelated
workspaces remain intact. The audit event is written before membership deletion
so actor attribution remains valid, and all effects roll back together on
failure.

The settings UI requires confirmation for cancel, role change, and removal,
disables concurrent actions, and exposes only safe action status and correlated
request IDs.

## Verification

Run the focused live PostgreSQL and Chromium suites against an isolated test
database:

```sh
TEST_DATABASE_URL=postgresql://... ALLOW_TEST_DATABASE_RESET=true \
  pnpm vitest run tests/integration/workspace-member-administration.test.ts \
  --no-file-parallelism

TEST_DATABASE_URL=postgresql://... ALLOW_TEST_DATABASE_RESET=true \
  pnpm playwright test tests/e2e/settings.spec.ts --project=chromium
```
