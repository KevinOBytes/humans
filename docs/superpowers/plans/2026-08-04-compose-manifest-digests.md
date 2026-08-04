# Compose Manifest Digest Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `HUM-FR-034` by pinning every third-party Docker Compose image to its live multi-architecture index digest and continuously verifying those pins.

**Architecture:** Keep readable immutable version tags and append the registry-reported `sha256` index digest to each PostgreSQL, Redis, MinIO, MinIO client, and optional Ollama image reference. Add one dependency-free verifier that discovers third-party image references from the committed Compose files, rejects unpinned or per-platform references, and asks Buildx to prove every pinned digest still resolves to the declared multi-platform index. Promote the offline pin-shape contract to unit tests and the live registry check to the existing Compose CI gate.

**Tech Stack:** Docker Compose v2, Docker Buildx imagetools, Node.js 24 ESM, Vitest, GitHub Actions.

## Global Constraints

- Preserve the human-readable version tag in every `tag@sha256:<index-digest>` reference.
- Pin registry index/manifest-list digests, never architecture-specific child manifests.
- Continue allowing `${HUMANS_IMAGE:-humans:local}` for the locally built application image; the verifier covers only third-party registry images.
- Verify both `docker-compose.yml` and the opt-in `docker-compose.ollama.yml`; duplicate references are resolved only once.
- The ordinary stack remains independent of Ollama and must not pull or start it during verification.
- The verifier must never print environment values or registry credentials.
- Use test-first changes and keep all existing Compose lifecycle behavior passing.

---

### Task 1: Pin and continuously verify third-party Compose indexes

**Files:**
- Create: `scripts/verify-compose-image-digests.mjs`
- Create: `tests/unit/compose-image-digests.test.ts`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.ollama.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `docs/operations/docker.md`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: direct `image:` values in `docker-compose.yml` and `docker-compose.ollama.yml`, `docker buildx imagetools inspect IMAGE --format {{json .Manifest}}`, and optional `DOCKER_BIN` for a deterministic test double.
- Produces: `pnpm compose:images:verify`, which exits nonzero for an unpinned third-party image, a digest mismatch, a non-index media type, or an index without both `linux/amd64` and `linux/arm64` manifests.

- [ ] **Step 1: Write failing verifier tests**

  Add Vitest cases that run the verifier against temporary Compose fixtures and a fake `DOCKER_BIN`. Prove it:

  1. rejects a tag-only third-party image;
  2. ignores the `${HUMANS_IMAGE:-humans:local}` application-image expression;
  3. rejects a registry result whose digest differs from the pin;
  4. rejects a single-platform child manifest media type;
  5. rejects an index missing either `linux/amd64` or `linux/arm64`;
  6. accepts and deduplicates matching multi-platform index references across two Compose files; and
  7. reports only image names and fixed diagnostics, never supplied environment values.

- [ ] **Step 2: Run the focused tests and verify failure**

  Run: `PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm vitest run tests/unit/compose-image-digests.test.ts`

  Expected: FAIL because `scripts/verify-compose-image-digests.mjs` and the package command do not exist.

- [ ] **Step 3: Implement the dependency-free verifier**

  Parse only direct `image:` scalar lines from the supplied/default Compose files. Treat the application expression as an explicit exception; require every other reference to match `tag@sha256:<64 lowercase hex>`. For each unique reference, inspect the tag without its digest, parse the JSON manifest, require the pinned and reported digest to match, require OCI index or Docker manifest-list media type, and require Linux AMD64 and ARM64 child descriptors. Exit at the first failure with a stable diagnostic and print a bounded success summary.

- [ ] **Step 4: Pin the reviewed live registry indexes**

  Use these index digests resolved with Docker Buildx on 2026-08-04:

  ```text
  postgres:18.3-bookworm@sha256:80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba
  redis:8.6.1@sha256:315270d166080f537bbdf1b489b603aaaa213cb55a544acfa51feb7481abb1c0
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e
  quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727
  ollama/ollama:0.13.5@sha256:2c9595c555fd70a28363489ac03bd5bf9e7c5bdf2890373c3a830ffd7252ce6d
  ```

  Keep the same Ollama reference on both `ollama` and `ollama-init`.

- [ ] **Step 5: Promote verification into commands and CI**

  Add `compose:images:verify` to `package.json`. In the existing `compose-lifecycle` job, run it after Compose contract tests and before rendering/starting the lifecycle. This live check must inspect registry metadata only; it must not pull layers or start Ollama.

- [ ] **Step 6: Update the operator and requirement contracts**

  Replace the mutable-tag warning in `docs/operations/docker.md` with the exact pin/update procedure and resolution date. Mark `HUM-FR-034` **Complete** only after the focused tests, live verifier, rendered configs, and isolated lifecycle pass; remove its single unchecked `TODO.md` entry without changing other incomplete requirements.

- [ ] **Step 7: Run focused and affected verification**

  Run:

  ```sh
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm vitest run tests/unit/compose-image-digests.test.ts tests/unit/compose-config.test.ts tests/unit/infrastructure-config.test.ts tests/unit/compose-operations.test.ts
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm compose:images:verify
  docker compose --profile smoke config --quiet
  docker compose -f docker-compose.yml -f docker-compose.ollama.yml --profile ollama config --quiet
  ```

  Expected: all tests pass; all five unique third-party references resolve to matching multi-architecture indexes; both Compose models render without starting services.

- [ ] **Step 8: Run release gates and commit**

  Run:

  ```sh
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm ci:validate
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm test:compose:lifecycle
  ```

  Expected: PASS.

  Commit:

  ```sh
  git add scripts/verify-compose-image-digests.mjs tests/unit/compose-image-digests.test.ts docker-compose.yml docker-compose.ollama.yml .github/workflows/ci.yml package.json docs/operations/docker.md docs/REQUIREMENTS.md TODO.md
  git commit -m "build: pin Compose service image indexes"
  ```
