# Retention capability matrix

## Goal

Make retention evaluation agree with the worker's actual capabilities. Unsupported
resource-kind and deletion-behavior combinations must never be reported as
automatically eligible for deletion.

## Scope

- Add an explicit capability matrix for the currently supported `person` and
  `file` soft-delete worker path.
- Make `retentionDecision` capability-aware while preserving review-only
  behavior for `review`, `hard_delete`, and `anonymize`.
- Make retention candidate planning carry resource kind and use the same matrix.
- Add focused unit and live integration coverage for unsupported resource kinds,
  exact expiry, legal holds, and supported person/file soft-delete behavior.
- Update requirements/TODO with bounded evidence and keep hard-delete,
  anonymization, and durable review disposition explicitly open.

## Non-goals

- Do not silently map hard-delete or anonymize to soft-delete.
- Do not implement irreversible deletion/anonymization without a dependency
  closure and provider propagation contract.
- Do not create a fake review queue in this slice.
