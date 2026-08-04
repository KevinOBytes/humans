import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";

type QueryCounter = { count: number };

const QUERY_COUNTER_SYMBOL = Symbol.for(
  "humans.graphql.database-query-counter",
);
type QueryCounterGlobal = typeof globalThis & {
  [QUERY_COUNTER_SYMBOL]?: AsyncLocalStorage<QueryCounter>;
};
const queryCounterGlobal = globalThis as QueryCounterGlobal;
const queryCounter = (queryCounterGlobal[QUERY_COUNTER_SYMBOL] ??=
  new AsyncLocalStorage<QueryCounter>());

const PERFORMANCE_DIAGNOSTIC_VERSION = "graph-reference-v1";
const PERFORMANCE_PRINCIPAL_HEADER = "x-humans-performance-principal";
const PERFORMANCE_SIGNATURE_HEADER = "x-humans-performance-signature";

export type PerformanceDiagnosticSettings = {
  enabled: boolean;
  isolatedTestRuntime: boolean;
  secret: string;
};

export type PerformanceDiagnosticCandidate = {
  principalId: string;
};

export function createPerformanceDiagnosticSignature(
  principalId: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${PERFORMANCE_DIAGNOSTIC_VERSION}:${principalId}`)
    .digest("hex");
}

export function isPerformanceDiagnosticRequest(
  request: Request,
  authenticatedPrincipalId: string,
  settings: PerformanceDiagnosticSettings,
): boolean {
  return (
    getPerformanceDiagnosticCandidate(request, settings)?.principalId ===
    authenticatedPrincipalId
  );
}

export function getPerformanceDiagnosticCandidate(
  request: Request,
  settings: PerformanceDiagnosticSettings,
): PerformanceDiagnosticCandidate | null {
  if (
    !settings.enabled ||
    !settings.isolatedTestRuntime ||
    settings.secret.length < 32 ||
    request.headers.get("x-humans-performance") !==
      PERFORMANCE_DIAGNOSTIC_VERSION
  )
    return null;

  const requestedPrincipal = request.headers
    .get(PERFORMANCE_PRINCIPAL_HEADER)
    ?.trim();
  const suppliedSignature = request.headers
    .get(PERFORMANCE_SIGNATURE_HEADER)
    ?.trim();
  if (
    !requestedPrincipal ||
    !suppliedSignature ||
    !/^[0-9a-f]{64}$/u.test(suppliedSignature)
  )
    return null;

  const expectedSignature = createPerformanceDiagnosticSignature(
    requestedPrincipal,
    settings.secret,
  );
  return timingSafeEqual(
    Buffer.from(suppliedSignature, "hex"),
    Buffer.from(expectedSignature, "hex"),
  )
    ? { principalId: requestedPrincipal }
    : null;
}

export async function measureDatabaseQueries<T>(
  operation: () => Promise<T>,
): Promise<{ queryCount: number; value: T }> {
  const counter: QueryCounter = { count: 0 };
  const value = await queryCounter.run(counter, operation);
  return { queryCount: counter.count, value };
}

export function recordDatabaseQuery(): void {
  const counter = queryCounter.getStore();
  if (counter) counter.count += 1;
}
