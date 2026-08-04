# API-key lifecycle implementation plan

## Goal

Close HUM-FR-006 with a usable, workspace-scoped administrator journey for creating, rotating, and revoking organization API keys through the canonical GraphQL API and settings UI.

## Global Constraints

- Only live owner/admin browser sessions may administer keys; API-key principals and lower roles fail closed.
- Every key is workspace-bound, Better Auth hashed, permissioned within the caller's live role, optionally expiring, and immediately unusable after revocation.
- A newly generated plaintext secret crosses the server boundary exactly once in the successful mutation payload, is never selected from storage, logged, audited, or returned by later reads, and is presented with an explicit copy/save warning.
- Creation, rotation, and revocation are canonical GraphQL mutations with generated typed operations. Mutation inputs are validated and return stable public error codes without leaking tenant identifiers or key material.
- Rotation creates a replacement with the requested name, permissions, and expiry, then disables the selected live key. A failed replacement must leave the original usable; a successful response returns only the new secret.
- The existing settings list remains redacted and tenant-bound. It exposes a stable opaque action identifier required for mutations, not a database or organization identifier.
- Successful lifecycle operations write redacted audit events attributed to the current user and request ID.
- Add focused unit/component and live database/GraphQL integration coverage for happy paths, authorization, tenant isolation, validation, one-time secret handling, rotation failure safety, and revocation.
- Update REQUIREMENTS.md/TODO.md only where the new evidence genuinely closes HUM-FR-006; do not imply the whole product is production-ready.
- Before commit, run formatting, lint, typecheck, focused tests, code generation/drift checks, and a production build.

## Task 1: Implement and verify the complete API-key lifecycle

Extend the settings service and GraphQL schema with create, rotate, and revoke operations using the existing Better Auth organization-key configuration and live workspace membership. Add the minimum repository support, audit records, and opaque action-id mapping needed to target keys safely. Add generated GraphQL documents and a client settings surface that can select a least-privilege preset or explicit allowed scopes, choose an expiry, create a key, copy the one-time secret, rotate a key, and revoke a key with clear confirmation and accessible feedback. Keep all later list/read responses redacted. Cover the security and lifecycle contract with focused tests, then update the requirement evidence and TODO row.
