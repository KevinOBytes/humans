# Privacy search propagation

## Goal

Make privacy-request propagation honest and useful for app-owned search state. A
workspace-scoped privacy request must be able to invalidate every search
document attributable to its people, including dependent contributions, while
remaining idempotent and auditable. External email and AI-provider deletion
remain explicitly fail-closed until provider-specific erasure contracts exist.

## Scope

- Add an injectable, transactional search processor adapter.
- Delete only documents in the request workspace whose `subjectPersonId`
  matches the request scope, plus direct `person` source documents for those
  subjects.
- Add a narrow Redis/cache `not_applicable` capability marker because Redis is
  currently operational-only and does not store person data.
- Wire only these safe adapters in the worker runtime.
- Add integration coverage for idempotent, workspace-scoped purge and worker
  evidence; keep email and AI processors failed-closed.
- Update requirements and TODO evidence without marking hosted provider
  erasure complete.

## Non-goals

- No Redis key scan or shared flush.
- No claim of Resend/OpenAI/Ollama remote deletion.
- No network calls inside the current transactional worker adapter boundary.
- No hard-delete or anonymization retention semantics.

## Verification

Run formatting, lint, typecheck, focused privacy integration tests, the full
unit suite, production build, then the GitHub database/security gate and full
CI workflow.
