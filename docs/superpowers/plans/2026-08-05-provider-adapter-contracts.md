# Provider adapter contracts

## Goal

Strengthen the NFR-002 evidence seam without claiming access to external
credentials. The domain must remain dependent on provider-neutral contracts,
while local Redis/MinIO and provider-shaped clients exercise identical
semantics.

## Scope

- Add a live integration contract for every `RedisStore` operation using local
  Redis and an Upstash-shaped client facade over the same Redis server.
- Add a live S3-compatible contract for signed checksum upload, workspace
  isolation, metadata/read/download, and deletion. CI runs this against its
  disposable MinIO service.
- Register the contract in the database integration gate because that gate
  provisions the disposable Redis and MinIO services.
- Document the evidence and leave NFR-002 incomplete until externally hosted
  R2, generic S3, and real Upstash REST credentials are exercised.

## Verification

```sh
REDIS_TEST_URL=redis://127.0.0.1:6381 \
TEST_STORAGE_ENDPOINT=http://127.0.0.1:9004 \
TEST_STORAGE_BUCKET=humans-private \
TEST_STORAGE_ACCESS_KEY_ID=e2eaccess \
TEST_STORAGE_SECRET_ACCESS_KEY=e2esecret123 \
pnpm vitest run tests/integration/provider-adapter-contract.test.ts --no-file-parallelism
```

The external provider checks remain opt-in and must use a dedicated test
workspace/bucket and short-lived credentials. They must never be enabled by
default in CI or committed to `.env.example`.
