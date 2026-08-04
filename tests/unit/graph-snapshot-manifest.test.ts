import { describe, expect, it } from "vitest";

import {
  createGraphSnapshotManifest,
  graphSnapshotManifestMaterial,
  GRAPH_RUNTIME_CONTRACT,
  GRAPH_SNAPSHOT_MANIFEST_LIMITS,
  validateStoredGraphSnapshotManifest,
  validateGraphSnapshotReplay,
} from "@/modules/graph/snapshot-manifest";

const base = {
  actorKind: "USER" as const,
  actorPrincipalId: "0198ef53-1010-7000-8000-000000000001",
  algorithm: "DEGREE" as const,
  algorithmConfiguration: { order: "ascending" },
  algorithmVersion: "graphology@0.26.0/degree/humans-v1",
  authorization: {
    actorRole: "owner",
    grantVersions: [
      {
        deleted: false,
        effective: true,
        id: "0198ef53-1010-7000-8000-000000000008",
        memberId: "member-1",
        policyId: "0198ef53-1010-7000-8000-000000000007",
        resourceId: "0198ef53-1010-7000-8000-000000000002",
        resourceKind: "person",
        role: null,
        state: "active",
        validFrom: null,
        validUntil: null,
        version: 2,
      },
    ],
    permissionKeys: ["graphView:read", "analysis:run"],
    policyVersions: [
      {
        deleted: false,
        id: "0198ef53-1010-7000-8000-000000000007",
        resourceKinds: ["relationship", "person"],
        sensitivityCeiling: "restricted",
        state: "active",
        version: 3,
      },
    ],
    principalId: "0198ef53-1010-7000-8000-000000000001",
  },
  query: { mode: "WORKSPACE", nodeLimit: 100, edgeLimit: 200 },
  personVersions: [
    { id: "0198ef53-1010-7000-8000-000000000003", version: 2 },
    { id: "0198ef53-1010-7000-8000-000000000002", version: 1 },
  ],
  relationshipVersions: [
    {
      id: "0198ef53-1010-7000-8000-000000000004",
      relationshipTypeId: "0198ef53-1010-7000-8000-000000000005",
      version: 3,
    },
  ],
  relationshipTypeVersions: [
    { id: "0198ef53-1010-7000-8000-000000000005", version: 4 },
  ],
  runtimeContract: {
    graphFingerprintVersion: "humans.graph-fingerprint.v1",
    manifestVersion: "humans.graph-snapshot-manifest.v1",
  },
  workspaceId: "0198ef53-1010-7000-8000-000000000009",
};

describe("Task 12 graph snapshot manifests", () => {
  it("locks the supported runtime and package contract", () => {
    expect(GRAPH_RUNTIME_CONTRACT).toEqual({
      graphFingerprintVersion: "humans.graph-fingerprint.v1",
      manifestVersion: "humans.graph-snapshot-manifest.v1",
      nodeMajor: 24,
      packages: {
        graphology: "0.26.0",
        graphologyCommunitiesLouvain: "2.0.2",
        graphologyMetrics: "2.4.0",
      },
      postgresMajor: 18,
      serviceVersion: "0.1.0",
    });
  });

  it("canonicalizes membership independently of insertion order", () => {
    const left = createGraphSnapshotManifest(base);
    const right = createGraphSnapshotManifest({
      ...base,
      authorization: {
        ...base.authorization,
        grantVersions: [...base.authorization.grantVersions].reverse(),
        permissionKeys: [...base.authorization.permissionKeys].reverse(),
        policyVersions: base.authorization.policyVersions.map((policy) => ({
          ...policy,
          resourceKinds: [...policy.resourceKinds].reverse(),
        })),
      },
      personVersions: [...base.personVersions].reverse(),
    });

    expect(right).toEqual(left);
    expect(left.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(left.queryHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(left.authorizationHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts the declared maximum entry vectors below the byte bound", () => {
    const uuid = (index: number) =>
      `0198ef53-${index.toString(16).padStart(4, "0")}-7000-8000-000000000001`;
    const resourceKinds = Array.from(
      {
        length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPolicyResourceKinds,
      },
      (_, index) => `kind-${index}`,
    );
    const manifest = createGraphSnapshotManifest({
      ...base,
      authorization: {
        ...base.authorization,
        grantVersions: Array.from(
          { length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationGrants },
          (_, index) => ({
            deleted: false,
            effective: true,
            id: uuid(index),
            memberId: base.authorization.grantVersions[0]!.memberId,
            policyId: uuid(index),
            resourceId: uuid(index),
            resourceKind: "person",
            role: null,
            state: "active",
            validFrom: null,
            validUntil: null,
            version: 1,
          }),
        ),
        permissionKeys: Array.from(
          {
            length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPermissionKeys,
          },
          (_, index) => `permission:${index}`,
        ),
        policyVersions: Array.from(
          { length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPolicies },
          (_, index) => ({
            deleted: false,
            id: uuid(index),
            resourceKinds,
            sensitivityCeiling: "restricted",
            state: "active",
            version: 1,
          }),
        ),
      },
      personVersions: Array.from(
        { length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.people },
        (_, index) => ({ id: uuid(index), version: 1 }),
      ),
      relationshipVersions: Array.from(
        { length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.relationships },
        (_, index) => ({
          id: uuid(index),
          relationshipTypeId: uuid(index),
          version: 1,
        }),
      ),
      relationshipTypeVersions: Array.from(
        { length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.relationshipTypes },
        (_, index) => ({ id: uuid(index), version: 1 }),
      ),
    });

    const materialBytes = Buffer.byteLength(
      JSON.stringify(graphSnapshotManifestMaterial(manifest)),
      "utf8",
    );
    expect(materialBytes).toBeLessThan(GRAPH_SNAPSHOT_MANIFEST_LIMITS.bytes);
  }, 30_000);

  it("rejects over-cap and duplicate vectors during creation", () => {
    expect(() =>
      createGraphSnapshotManifest({
        ...base,
        personVersions: Array.from(
          { length: GRAPH_SNAPSHOT_MANIFEST_LIMITS.people + 1 },
          (_, index) => ({
            id: `0198ef53-${index.toString(16).padStart(4, "0")}-7000-8000-000000000001`,
            version: 1,
          }),
        ),
      }),
    ).toThrow("exceeds supported bounds");
    expect(() =>
      createGraphSnapshotManifest({
        ...base,
        personVersions: [base.personVersions[0]!, base.personVersions[0]!],
      }),
    ).toThrow("exceeds supported bounds");
  });

  it("round-trips the complete canonical material and verifies its hash", () => {
    const manifest = createGraphSnapshotManifest(base);
    const manifestMaterial = graphSnapshotManifestMaterial(manifest);

    expect(manifestMaterial).toEqual({
      ...manifest,
      manifestHash: undefined,
    });
    expect(Object.hasOwn(manifestMaterial, "manifestHash")).toBe(false);
    expect(
      validateStoredGraphSnapshotManifest({
        ...manifest,
        manifestMaterial,
        includedPersonVersions: Object.fromEntries(
          manifest.personVersions.map(({ id, version }) => [id, version]),
        ),
        includedRelationshipVersions: Object.fromEntries(
          manifest.relationshipVersions.map(({ id, version }) => [id, version]),
        ),
        includedRelationshipTypeVersions: Object.fromEntries(
          manifest.relationshipTypeVersions.map(({ id, version }) => [
            id,
            version,
          ]),
        ),
        queryInput: manifest.query,
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    [
      "material",
      (stored: Record<string, unknown>) => ({
        ...stored,
        manifestMaterial: {
          ...(stored.manifestMaterial as Record<string, unknown>),
          workspaceId: "0198ef53-1010-7000-8000-000000000099",
        },
      }),
    ],
    [
      "hash",
      (stored: Record<string, unknown>) => ({
        ...stored,
        manifestHash: "0".repeat(64),
      }),
    ],
    [
      "denormalized query",
      (stored: Record<string, unknown>) => ({
        ...stored,
        queryInput: { mode: "PERSON" },
      }),
    ],
    [
      "denormalized relationship versions",
      (stored: Record<string, unknown>) => ({
        ...stored,
        includedRelationshipVersions: {},
      }),
    ],
  ])("fails closed on %s tampering", (_name, tamper) => {
    const manifest = createGraphSnapshotManifest(base);
    const stored = {
      ...manifest,
      manifestMaterial: graphSnapshotManifestMaterial(manifest),
      includedPersonVersions: Object.fromEntries(
        manifest.personVersions.map(({ id, version }) => [id, version]),
      ),
      includedRelationshipVersions: Object.fromEntries(
        manifest.relationshipVersions.map(({ id, version }) => [id, version]),
      ),
      includedRelationshipTypeVersions: Object.fromEntries(
        manifest.relationshipTypeVersions.map(({ id, version }) => [
          id,
          version,
        ]),
      ),
      queryInput: manifest.query,
    };

    expect(validateStoredGraphSnapshotManifest(tamper(stored))).toEqual({
      valid: false,
    });
  });

  it.each([
    [
      "addition",
      {
        personVersions: [
          ...base.personVersions,
          { id: "0198ef53-1010-7000-8000-000000000006", version: 1 },
        ],
      },
    ],
    ["removal", { personVersions: base.personVersions.slice(1) }],
    [
      "entity version",
      {
        personVersions: [
          { ...base.personVersions[0]!, version: 9 },
          base.personVersions[1]!,
        ],
      },
    ],
    [
      "type version",
      {
        relationshipTypeVersions: [
          { ...base.relationshipTypeVersions[0]!, version: 9 },
        ],
      },
    ],
    [
      "policy",
      {
        authorization: {
          ...base.authorization,
          permissionKeys: ["graphView:read"],
        },
      },
    ],
    [
      "grant",
      {
        authorization: {
          ...base.authorization,
          grantVersions: [
            { ...base.authorization.grantVersions[0]!, effective: false },
          ],
        },
      },
    ],
    [
      "grant deletion",
      {
        authorization: {
          ...base.authorization,
          grantVersions: [
            { ...base.authorization.grantVersions[0]!, deleted: true },
          ],
        },
      },
    ],
    [
      "grant bounds",
      {
        authorization: {
          ...base.authorization,
          grantVersions: [
            {
              ...base.authorization.grantVersions[0]!,
              validUntil: "2026-08-04T00:00:00.000Z",
            },
          ],
        },
      },
    ],
    [
      "policy deletion",
      {
        authorization: {
          ...base.authorization,
          policyVersions: [
            { ...base.authorization.policyVersions[0]!, deleted: true },
          ],
        },
      },
    ],
    [
      "actor",
      {
        actorPrincipalId: "0198ef53-1010-7000-8000-000000000010",
        authorization: {
          ...base.authorization,
          principalId: "0198ef53-1010-7000-8000-000000000010",
        },
      },
    ],
    ["algorithm config", { algorithmConfiguration: { projection: "changed" } }],
    ["algorithm", { algorithmVersion: "changed" }],
    [
      "runtime",
      {
        runtimeContract: {
          ...base.runtimeContract,
          graphFingerprintVersion: "changed",
        },
      },
    ],
    ["workspace", { workspaceId: "0198ef53-1010-7000-8000-000000000010" }],
  ])("invalidates neutrally on %s drift", (_name, patch) => {
    const stored = createGraphSnapshotManifest(base);
    const current = createGraphSnapshotManifest({ ...base, ...patch });
    expect(validateGraphSnapshotReplay(stored, current)).toEqual({
      valid: false,
    });
  });
});
