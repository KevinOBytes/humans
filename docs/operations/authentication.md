# Authentication operations

## Registration policy

Set `AUTH_REGISTRATION_MODE` to one of:

- `invite_only` (recommended and default): signup requires a live pending
  invitation for the same normalized email. Signup leaves the invitation
  pending until verified recipient acceptance succeeds.
- `disabled`: public email/username signup is unavailable. One-shot
  administrator bootstrap and sign-in remain available.
- `public`: anyone may submit the signup form. Use this only for an intentional
  local or public-registration deployment.

Changing the mode requires an app restart. Do not expose invitation or account
existence in support responses. Better Auth stores shared signup and recovery
rate-limit state in PostgreSQL.

Invite-only signup is request-transactional. The policy locks the live
invitation row, Better Auth creates the user and credential through a nested
savepoint, and a database create hook revalidates invitation expiry and active,
non-deleted workspace state immediately before the user insert. Cancellation
waits behind that lock. Expiry during password hashing rejects and rolls back
the user and credential; any rejected handler result rolls back the outer
transaction. The invitation is never consumed by signup.

The authentication catch-all classifies client addresses before invoking
Better Auth. It removes any caller-supplied internal address header, and Better
Auth reads only the replacement header. It never trusts `x-forwarded-for`.
Vercel mode accepts exactly one valid `x-vercel-forwarded-for` address; missing,
malformed, or multi-hop values use an `AUTH_SECRET`-keyed bucket bound to the
normalized signup, sign-in, or recovery target. Docker `none` mode always uses that fallback.
Docker `hmac` mode accepts only a directly observed address signed by a trusted
edge that strips inbound forwarding and Humans headers and prevents direct
application access. PostgreSQL-backed counters make the limit shared across
application instances.

Invitation acceptance also uses an application-owned transaction: it locks the
pending invitation and workspace, rechecks active/non-deleted workspace state,
expiry, role, verified recipient email, and prior membership, then creates the
membership and marks the invitation accepted as one unit. All domain failures
return the same `409 INVITATION_UNAVAILABLE` shape; only redacted correlated
server telemetry records the reason. Direct Better Auth acceptance is disabled,
and the wrapper requires a
same-origin cookie session rather than an API key. Workspace activation happens
after this durable acceptance. If activation fails, acceptance remains complete
and the member can recover by selecting the joined workspace from the workspace
selector.

Invitation links place the invitation identifier in a URL fragment. The
acceptance client removes that fragment immediately, then exchanges the value
through a same-origin POST for an AES-GCM sealed, 15-minute, HTTP-only,
SameSite=Strict handoff cookie. Sign-in and sign-up use the clean
`/accept-invitation` return path. After authentication, a same-origin
cookie-session request returns the identifier only into ephemeral client state;
success, terminal failure, and explicit cleanup delete the handoff cookie.

Owners and admins issue, resend, and cancel invitations through the generated
GraphQL boundary documented in
[Workspace member operations](workspace-members.md). Invitation mail uses the
same encrypted authentication outbox and fenced Resend delivery worker as
verification mail. Cancellation suppresses any intent not already claimed;
provider delivery already in progress remains an at-least-once race that
causes cancellation to return unchanged for retry; cancellation never commits
while that provider delivery may still occur. Query-to-fragment conversion at
the proxy remains only for legacy links. Newly generated mail uses a fragment
from the outset so the action credential is absent from the HTTP request URL.

## Recovery

`NEXT_PUBLIC_APP_URL` and every `AUTH_TRUSTED_ORIGINS` entry must name an
operator-controlled HTTP(S) origin. Resend password-reset mail contains only a
same-origin Better Auth callback. The callback validates expiry before sending
the browser to the reset form. Reset tokens are one-time, expire under Better
Auth policy, and successful reset revokes every existing session.

The reset callback moves the token into the URL fragment. The client captures
it once and synchronously replaces browser history with the token-free path
before the form becomes usable. Invalid, failed, replayed, and abandoned flows
perform the same cleanup; tokens are never stored in browser storage.

If mail delivery fails, inspect provider delivery state without logging the
recipient, reset URL, or token. The public form always reports that mail may
have been sent, whether or not an account exists.

## Two-factor lifecycle

Enrollment, disablement, and backup-code regeneration require the current
password. Users must verify a TOTP before enablement and acknowledge that codes
were saved before leaving the presentation step. Plaintext QR secrets and codes
must never be copied into tickets, screenshots, logs, analytics, URLs, or
browser storage.

The application-owned disable endpoint accepts only a cookie session from the
exact trusted Origin; API keys and direct Better Auth disable calls are denied.
Before password hashing it consumes an atomic PostgreSQL attempt budget keyed
by an `AUTH_SECRET` HMAC of the trusted client classification, user, and
operation. Five attempts are allowed per five-minute window across instances;
untrusted/spoofed proxy metadata cannot select another client bucket, and the
stored key contains no user or address value.
Inside one PostgreSQL transaction it locks the user and credential, verifies
the password, clears the enabled flag, deletes TOTP/backup and trust-device
material, and revokes every session. Any failure rolls back the entire change.
The user must sign in again. Cancelling an unverified enrollment atomically
deletes the pending factor without revoking sessions. Regeneration invalidates
all previous unused backup codes immediately. A backup code is consumed once;
replay is rejected. After TOTP verification, the QR and manual secret are
removed immediately while backup codes remain until their saved-codes
acknowledgement.

Every delegated Better Auth response, including errors and `429` responses,
returns a sanitized `x-request-id`; JSON error bodies carry the same value.
Requests bearing `Authorization` or `x-api-key` are rejected before Better Auth
loads, even when a session cookie is also present. API keys remain supported at
the GraphQL API boundary, not as interactive account authority.

## Verification commands

Run the focused handler and browser evidence against an isolated test database:

```sh
TEST_DATABASE_URL=postgresql://... ALLOW_TEST_DATABASE_RESET=true \
  pnpm vitest run tests/integration/auth-security.test.ts --no-file-parallelism

TEST_DATABASE_URL=postgresql://... ALLOW_TEST_DATABASE_RESET=true \
  NODE_OPTIONS=--conditions=react-server \
  pnpm playwright test tests/e2e/auth-lifecycle.spec.ts --project=chromium
```
