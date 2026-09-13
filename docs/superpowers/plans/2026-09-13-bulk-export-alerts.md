# Persistent bulk-export alerts

## Context

Humans records immutable redacted mutation audits and governed export approvals, but the auditability contract also requires a persistent alert when a newly completed export crosses a bounded bulk threshold. The alert must be operational metadata only and must not create a policy bypass. Break-glass access and universal read logging remain separate follow-up design work.

## Global constraints

- Keep workspace, case, sensitivity, purpose, approval, legal-hold, and export authorization checks unchanged.
- Emit exactly one alert only on the first successful transition of an export artifact to ready; replay/recovery must not duplicate it.
- Persist only redaction-safe bounded scalars (row count, threshold, redaction profile/category, case-scoped boolean); never query text, identities, source IDs, object keys, or bytes.
- Reuse immutable `audit_events` and existing settings audit review; no access-policy bypass.
- Add focused redaction and live PostgreSQL/object-store lifecycle tests. Update requirements and TODO without claiming the whole auditability/provider matrix complete.

## Task 1 — thresholded audit alert

Add a fixed threshold constant and append `export.bulk_alert` in the existing final artifact-ready transaction when the newly transitioned artifact has at least that many rows. Extend the audit metadata allowlist and tests for normal/restricted profiles. Prove threshold/non-threshold behavior, replay/recovery no-duplicate behavior, immutable/cross-workspace fencing, and no sensitive metadata leakage. Update docs.

## Review

A fresh reviewer must inspect the isolated branch, run focused lifecycle/redaction tests plus format/lint/typecheck and relevant database gates, and reject any unsupported completion claims.
