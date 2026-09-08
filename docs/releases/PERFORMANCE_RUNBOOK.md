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
disposable performance dependencies with the checked-in host-port override:

```sh
PERF_POSTGRES_PORT=55442 \
PERF_REDIS_PORT=6382 \
PERF_MINIO_PORT=9005 \
POSTGRES_DB=humans_test \
POSTGRES_USER=humans_test \
POSTGRES_PASSWORD=humans_test \
REDIS_PASSWORD=humans_test_redis_password \
MINIO_ROOT_USER=e2eaccess \
MINIO_ROOT_PASSWORD=e2esecret123 \
MINIO_CORS_ALLOW_ORIGIN=http://127.0.0.1:3106 \
docker compose -p humans-performance \
  -f docker-compose.yml -f docker-compose.test.yml \
  -f docker-compose.performance.yml up -d postgres redis minio minio-init
```

After the run, remove the disposable project with
`docker compose -p humans-performance -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.performance.yml down -v`.
Never point this run at a production database, Redis, or bucket.

## Run and collect

```sh
GRAPH_PERFORMANCE=1 \
ALLOW_TEST_DATABASE_RESET=true \
TEST_DATABASE_URL=postgresql://humans_test:humans_test@127.0.0.1:55442/humans_test \
TEST_REDIS_URL=redis://:humans_test_redis_password@127.0.0.1:6382 \
TEST_STORAGE_ENDPOINT=http://127.0.0.1:9005 \
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
