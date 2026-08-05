# Representative performance runbook

This runbook produces reviewable, local reference evidence for the bounded
graph/route portions of `HUM-NFR-020`. It does not make a hosted-production
claim and does not close the requirement.

## Reference machine

Run on an idle, mains-powered x86_64 desktop running Ubuntu 24.04 with at least
8 physical CPU cores, 32 GiB RAM, a hardware-accelerated WebGL2-capable GPU,
and the current stable Chromium supplied by Playwright. Record the exact CPU,
RAM, GPU/driver, Chromium version, Node version, commit SHA, and ambient load
with the artifacts. Do not compare results across materially different machines.

## Required services

- Disposable PostgreSQL 18 with `TEST_DATABASE_URL` and reset permission.
- Redis with `TEST_REDIS_URL`; the run flushes only that benchmark database.
- Private MinIO/S3-compatible storage with `TEST_STORAGE_*` credentials.
- The application checkout with dependencies installed using its pinned
  Node/pnpm versions.

For the local Compose-backed services used by this repository, start the
isolated test services first and map the command below to their published
ports/credentials. Never point this run at a production database, Redis, or
bucket.

## Run and collect

```sh
GRAPH_PERFORMANCE=1 \
ALLOW_TEST_DATABASE_RESET=true \
TEST_DATABASE_URL=postgresql://humans:humans_test@127.0.0.1:55441/humans_test \
TEST_REDIS_URL=redis://127.0.0.1:6381 \
TEST_STORAGE_ENDPOINT=http://127.0.0.1:9004 \
TEST_STORAGE_REGION=us-east-1 \
TEST_STORAGE_BUCKET=humans-private \
TEST_STORAGE_ACCESS_KEY_ID=e2eaccess \
TEST_STORAGE_SECRET_ACCESS_KEY=e2esecret123 \
pnpm test:performance:graph
```

Archive the Playwright result directory and attach these files to the release
record for the tested commit:

- `graph-api-performance.json`
- `graph-render-performance.json`
- `graph-route-javascript.json`

Review that the graph run seeded exactly 10,000 people and 25,000 edges,
authenticated 20 concurrent readers, met its read p95/query/byte thresholds,
met render/FPS/route-JavaScript thresholds, and includes the machine metadata.
Record failures rather than relaxing a threshold.

## Remaining required evidence

The harness does not measure authenticated mutations under 20 concurrent users;
the required mutation p95 at or below 750 ms remains unmeasured. It also does
not measure upload-path latency, public-route LCP/INP/CLS, or hosted deployment
performance. Those artifacts are required before `HUM-NFR-020` can be complete.
