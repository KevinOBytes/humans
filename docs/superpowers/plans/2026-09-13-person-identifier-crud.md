# Person identifier CRUD

## Goal

Make identifiers a complete governed rich-profile surface. Authorized users
must be able to create, edit, and archive person identifiers through generated
GraphQL and the profile UI while preserving sensitivity redaction, provenance,
optimistic versions, auditability, and principal-bound replay semantics.

## Task 1

Add focused failing tests, then implement the service lifecycle, GraphQL
inputs/mutations/operations, and accessible profile controls. Public values may
be projected only when sensitivity is `public`; non-public values must use the
existing protected-exact encryption and blind-index helpers, and missing keys
must fail closed. Preserve workspace authorization, effective-date validation,
version fencing, audit records, and idempotency. Update requirements/backlog
only after verification.

## Non-goals

This tranche does not claim hosted credentials/provider acceptance or closure
of the whole rich-profile accessibility, retention, or performance matrices.
