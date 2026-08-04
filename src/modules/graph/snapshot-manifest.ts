import { createHash, timingSafeEqual } from "node:crypto";

export type GraphAuthorizationVector = Readonly<{
  actorRole: string | null;
  grantVersions: readonly Readonly<{
    deleted: boolean;
    effective: boolean;
    id: string;
    memberId: string | null;
    policyId: string;
    resourceId: string;
    resourceKind: string;
    role: string | null;
    state: string;
    validFrom: string | null;
    validUntil: string | null;
    version: number;
  }>[];
  permissionKeys: readonly string[];
  policyVersions: readonly Readonly<{
    deleted: boolean;
    id: string;
    resourceKinds: readonly string[];
    sensitivityCeiling: string;
    state: string;
    version: number;
  }>[];
  principalId: string;
}>;

export type GraphSnapshotManifestInput = Readonly<{
  actorKind: "USER" | "API_KEY";
  actorPrincipalId: string;
  algorithm: "DEGREE" | "PAGERANK" | "LOUVAIN_COMMUNITY";
  algorithmConfiguration: Readonly<Record<string, unknown>>;
  algorithmVersion: string;
  authorization: GraphAuthorizationVector;
  query: Readonly<Record<string, unknown>>;
  personVersions: readonly Readonly<{ id: string; version: number }>[];
  relationshipVersions: readonly Readonly<{
    id: string;
    relationshipTypeId: string;
    version: number;
  }>[];
  relationshipTypeVersions: readonly Readonly<{
    id: string;
    version: number;
  }>[];
  runtimeContract: Readonly<Record<string, unknown>>;
  workspaceId: string;
}>;

export type GraphSnapshotManifest = GraphSnapshotManifestInput &
  Readonly<{
    authorizationHash: string;
    algorithmConfigHash: string;
    manifestHash: string;
    manifestSchema: "humans.graph-snapshot-manifest.v1";
    queryHash: string;
  }>;

export type GraphSnapshotManifestMaterial = Omit<
  GraphSnapshotManifest,
  "manifestHash"
>;

export const GRAPH_SNAPSHOT_MANIFEST_LIMITS = Object.freeze({
  authorizationGrants: 35_000,
  authorizationPermissionKeys: 512,
  authorizationPolicies: 5_000,
  authorizationPolicyResourceKinds: 16,
  bytes: 32 * 1024 * 1024,
  people: 10_000,
  relationships: 25_000,
  relationshipTypes: 25_000,
});

const MANIFEST_SCHEMA = "humans.graph-snapshot-manifest.v1" as const;

export const GRAPH_RUNTIME_CONTRACT = Object.freeze({
  graphFingerprintVersion: "humans.graph-fingerprint.v1",
  manifestVersion: MANIFEST_SCHEMA,
  nodeMajor: 24,
  packages: Object.freeze({
    graphology: "0.26.0",
    graphologyCommunitiesLouvain: "2.0.2",
    graphologyMetrics: "2.4.0",
  }),
  postgresMajor: 18,
  serviceVersion: "0.1.0",
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Manifest numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object")
    throw new TypeError("The graph snapshot manifest is invalid.");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonical(value), "utf8")
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isBoundedString(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isNullableIsoInstant(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}

function isNullableString(
  value: unknown,
  maximum = 256,
): value is string | null {
  return value === null || isBoundedString(value, maximum);
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sameHash(leftValue: unknown, rightValue: unknown): boolean {
  if (!isHash(leftValue) || !isHash(rightValue)) return false;
  const left = Buffer.from(leftValue, "hex");
  const right = Buffer.from(rightValue, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonical(left) === canonical(right);
  } catch {
    return false;
  }
}

function isVersionEntry(
  value: unknown,
): value is Readonly<{ id: string; version: number }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "version"]) &&
    isUuid(value.id) &&
    isPositiveVersion(value.version)
  );
}

function isRelationshipVersionEntry(value: unknown): value is Readonly<{
  id: string;
  relationshipTypeId: string;
  version: number;
}> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "relationshipTypeId", "version"]) &&
    isUuid(value.id) &&
    isUuid(value.relationshipTypeId) &&
    isPositiveVersion(value.version)
  );
}

function hasUniqueIds(values: readonly Readonly<{ id: string }>[]): boolean {
  return new Set(values.map(({ id }) => id)).size === values.length;
}

function isAuthorizationVector(
  value: unknown,
): value is GraphAuthorizationVector {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "actorRole",
      "grantVersions",
      "permissionKeys",
      "policyVersions",
      "principalId",
    ]) ||
    !isNullableString(value.actorRole, 64) ||
    !isUuid(value.principalId) ||
    !Array.isArray(value.grantVersions) ||
    value.grantVersions.length >
      GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationGrants ||
    !Array.isArray(value.permissionKeys) ||
    value.permissionKeys.length >
      GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPermissionKeys ||
    !Array.isArray(value.policyVersions) ||
    value.policyVersions.length >
      GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPolicies
  ) {
    return false;
  }
  if (
    !value.permissionKeys.every((key) => isBoundedString(key, 128)) ||
    new Set(value.permissionKeys).size !== value.permissionKeys.length
  ) {
    return false;
  }
  const grants = value.grantVersions;
  if (
    !grants.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, [
          "deleted",
          "effective",
          "id",
          "memberId",
          "policyId",
          "resourceId",
          "resourceKind",
          "role",
          "state",
          "validFrom",
          "validUntil",
          "version",
        ]) &&
        typeof entry.deleted === "boolean" &&
        typeof entry.effective === "boolean" &&
        isUuid(entry.id) &&
        (entry.memberId === null || isBoundedString(entry.memberId, 128)) &&
        isUuid(entry.policyId) &&
        isUuid(entry.resourceId) &&
        isBoundedString(entry.resourceKind, 64) &&
        isNullableString(entry.role, 64) &&
        isBoundedString(entry.state, 64) &&
        isNullableIsoInstant(entry.validFrom) &&
        isNullableIsoInstant(entry.validUntil) &&
        isPositiveVersion(entry.version),
    ) ||
    !hasUniqueIds(grants as readonly Readonly<{ id: string }>[])
  ) {
    return false;
  }
  const policies = value.policyVersions;
  return (
    policies.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, [
          "deleted",
          "id",
          "resourceKinds",
          "sensitivityCeiling",
          "state",
          "version",
        ]) &&
        typeof entry.deleted === "boolean" &&
        isUuid(entry.id) &&
        Array.isArray(entry.resourceKinds) &&
        entry.resourceKinds.length <=
          GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPolicyResourceKinds &&
        entry.resourceKinds.every((kind) => isBoundedString(kind, 64)) &&
        new Set(entry.resourceKinds).size === entry.resourceKinds.length &&
        isBoundedString(entry.sensitivityCeiling, 64) &&
        isBoundedString(entry.state, 64) &&
        isPositiveVersion(entry.version),
    ) && hasUniqueIds(policies as readonly Readonly<{ id: string }>[])
  );
}

function parseManifestMaterial(
  value: unknown,
): GraphSnapshotManifestMaterial | null {
  if (!isRecord(value)) return null;
  try {
    if (
      Buffer.byteLength(canonical(value), "utf8") >
      GRAPH_SNAPSHOT_MANIFEST_LIMITS.bytes
    )
      return null;
  } catch {
    return null;
  }
  if (
    !hasExactKeys(value, [
      "actorKind",
      "actorPrincipalId",
      "algorithm",
      "algorithmConfigHash",
      "algorithmConfiguration",
      "algorithmVersion",
      "authorization",
      "authorizationHash",
      "manifestSchema",
      "personVersions",
      "query",
      "queryHash",
      "relationshipTypeVersions",
      "relationshipVersions",
      "runtimeContract",
      "workspaceId",
    ]) ||
    (value.actorKind !== "USER" && value.actorKind !== "API_KEY") ||
    !isUuid(value.actorPrincipalId) ||
    (value.algorithm !== "DEGREE" &&
      value.algorithm !== "PAGERANK" &&
      value.algorithm !== "LOUVAIN_COMMUNITY") ||
    !isHash(value.algorithmConfigHash) ||
    !isRecord(value.algorithmConfiguration) ||
    Object.keys(value.algorithmConfiguration).length === 0 ||
    !isBoundedString(value.algorithmVersion) ||
    !isAuthorizationVector(value.authorization) ||
    value.authorization.principalId !== value.actorPrincipalId ||
    (value.actorKind === "API_KEY" &&
      (value.authorization.actorRole !== null ||
        value.authorization.grantVersions.length !== 0 ||
        value.authorization.policyVersions.length !== 0)) ||
    !isHash(value.authorizationHash) ||
    value.manifestSchema !== MANIFEST_SCHEMA ||
    !Array.isArray(value.personVersions) ||
    value.personVersions.length > GRAPH_SNAPSHOT_MANIFEST_LIMITS.people ||
    !value.personVersions.every(isVersionEntry) ||
    !hasUniqueIds(value.personVersions) ||
    !isRecord(value.query) ||
    !isHash(value.queryHash) ||
    !Array.isArray(value.relationshipVersions) ||
    value.relationshipVersions.length >
      GRAPH_SNAPSHOT_MANIFEST_LIMITS.relationships ||
    !value.relationshipVersions.every(isRelationshipVersionEntry) ||
    !hasUniqueIds(value.relationshipVersions) ||
    !Array.isArray(value.relationshipTypeVersions) ||
    value.relationshipTypeVersions.length >
      GRAPH_SNAPSHOT_MANIFEST_LIMITS.relationshipTypes ||
    !value.relationshipTypeVersions.every(isVersionEntry) ||
    !hasUniqueIds(value.relationshipTypeVersions) ||
    !isRecord(value.runtimeContract) ||
    Object.keys(value.runtimeContract).length === 0 ||
    !isUuid(value.workspaceId)
  ) {
    return null;
  }
  return value as GraphSnapshotManifestMaterial;
}

function sortedVersions<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

export function createGraphSnapshotManifest(
  input: GraphSnapshotManifestInput,
): GraphSnapshotManifest {
  const normalized = {
    ...input,
    authorization: {
      ...input.authorization,
      grantVersions: sortedVersions(input.authorization.grantVersions),
      permissionKeys: [...new Set(input.authorization.permissionKeys)].sort(),
      policyVersions: sortedVersions(input.authorization.policyVersions).map(
        (policy) => ({
          ...policy,
          resourceKinds: [...new Set(policy.resourceKinds)].sort(),
        }),
      ),
    },
    personVersions: sortedVersions(input.personVersions),
    relationshipVersions: sortedVersions(input.relationshipVersions),
    relationshipTypeVersions: sortedVersions(input.relationshipTypeVersions),
  };
  const queryHash = hash("humans.graph-query.v1", normalized.query);
  const authorizationHash = hash(
    "humans.graph-authorization.v1",
    normalized.authorization,
  );
  const algorithmConfigHash = hash(
    "humans.graph-algorithm-config.v1",
    normalized.algorithmConfiguration,
  );
  const material = {
    ...normalized,
    algorithmConfigHash,
    authorizationHash,
    manifestSchema: MANIFEST_SCHEMA,
    queryHash,
  };
  if (!parseManifestMaterial(material))
    throw new TypeError(
      "The graph snapshot manifest exceeds supported bounds.",
    );
  return Object.freeze({
    ...material,
    manifestHash: hash("humans.graph-snapshot.v1", material),
  });
}

export function graphSnapshotManifestMaterial(
  manifest: GraphSnapshotManifest,
): GraphSnapshotManifestMaterial {
  const material = { ...manifest };
  Reflect.deleteProperty(material, "manifestHash");
  return Object.freeze(material);
}

export function validateStoredGraphSnapshotManifest(
  storedValue: unknown,
): Readonly<{ valid: boolean }> {
  if (!isRecord(storedValue)) return Object.freeze({ valid: false });
  const material = parseManifestMaterial(storedValue.manifestMaterial);
  if (!material || !isHash(storedValue.manifestHash))
    return Object.freeze({ valid: false });
  try {
    const rebuilt = createGraphSnapshotManifest({
      actorKind: material.actorKind,
      actorPrincipalId: material.actorPrincipalId,
      algorithm: material.algorithm,
      algorithmConfiguration: material.algorithmConfiguration,
      algorithmVersion: material.algorithmVersion,
      authorization: material.authorization,
      query: material.query,
      personVersions: material.personVersions,
      relationshipVersions: material.relationshipVersions,
      relationshipTypeVersions: material.relationshipTypeVersions,
      runtimeContract: material.runtimeContract,
      workspaceId: material.workspaceId,
    });
    const expectedMaterial = graphSnapshotManifestMaterial(rebuilt);
    const includedPersonVersions = Object.fromEntries(
      material.personVersions.map(({ id, version }) => [id, version]),
    );
    const includedRelationshipVersions = Object.fromEntries(
      material.relationshipVersions.map(({ id, version }) => [id, version]),
    );
    const includedRelationshipTypeVersions = Object.fromEntries(
      material.relationshipTypeVersions.map(({ id, version }) => [id, version]),
    );
    const valid =
      sameCanonical(material, expectedMaterial) &&
      sameHash(storedValue.manifestHash, rebuilt.manifestHash) &&
      storedValue.manifestSchema === material.manifestSchema &&
      storedValue.workspaceId === material.workspaceId &&
      storedValue.actorKind === material.actorKind &&
      storedValue.actorPrincipalId === material.actorPrincipalId &&
      storedValue.algorithm === material.algorithm &&
      storedValue.algorithmVersion === material.algorithmVersion &&
      sameHash(storedValue.algorithmConfigHash, material.algorithmConfigHash) &&
      sameHash(storedValue.authorizationHash, material.authorizationHash) &&
      sameHash(storedValue.queryHash, material.queryHash) &&
      sameCanonical(
        storedValue.algorithmConfiguration,
        material.algorithmConfiguration,
      ) &&
      sameCanonical(storedValue.runtimeContract, material.runtimeContract) &&
      sameCanonical(storedValue.queryInput, material.query) &&
      sameCanonical(
        storedValue.includedPersonVersions,
        includedPersonVersions,
      ) &&
      sameCanonical(
        storedValue.includedRelationshipVersions,
        includedRelationshipVersions,
      ) &&
      sameCanonical(
        storedValue.includedRelationshipTypeVersions,
        includedRelationshipTypeVersions,
      );
    return Object.freeze({ valid });
  } catch {
    return Object.freeze({ valid: false });
  }
}

export function validateGraphSnapshotReplay(
  stored: Pick<GraphSnapshotManifest, "manifestHash">,
  current: GraphSnapshotManifest,
): Readonly<{ valid: boolean }> {
  return Object.freeze({
    valid: sameHash(stored.manifestHash, current.manifestHash),
  });
}
