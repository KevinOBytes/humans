const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const directRouteErrorCodes = [
  "AUTH_ADMINISTRATION_DISABLED",
  "AUTH_LIFECYCLE_WRAPPER_REQUIRED",
  "AUTH_METHOD_NOT_ALLOWED",
  "AUTH_REQUEST_FAILED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "INVITATION_UNAVAILABLE",
  "RATE_LIMITED",
  "SECURITY_CHANGE_REJECTED",
  "SECURITY_CHANGE_UNAVAILABLE",
  "UNAUTHORIZED",
] as const;

export type DirectRouteErrorCode = (typeof directRouteErrorCodes)[number];

export type DirectRouteResult<T> =
  | { ok: true; data: T; requestId: string }
  | { ok: false; code: DirectRouteErrorCode; requestId: string };

type DirectRoutePayload = {
  code?: unknown;
  requestId?: unknown;
};

type DirectRouteRequest = {
  body?: unknown;
  fetcher?: typeof fetch;
  method?: "DELETE" | "GET" | "POST" | "PUT";
  signal?: AbortSignal;
  url: string;
};

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

function requestIdFrom(response: Response, payload: unknown): string {
  const header = response.headers.get("x-request-id");
  if (validRequestId(header)) return header.toLowerCase();
  if (
    payload &&
    typeof payload === "object" &&
    validRequestId((payload as DirectRoutePayload).requestId)
  ) {
    return ((payload as DirectRoutePayload).requestId as string).toLowerCase();
  }
  return "unknown";
}

function isDirectRouteErrorCode(value: unknown): value is DirectRouteErrorCode {
  return (
    typeof value === "string" &&
    (directRouteErrorCodes as readonly string[]).includes(value)
  );
}

function failure(
  response: Response,
  payload: unknown,
): DirectRouteResult<never> {
  let code: DirectRouteErrorCode = "AUTH_REQUEST_FAILED";
  if (payload && typeof payload === "object") {
    const candidate = (payload as DirectRoutePayload).code;
    if (isDirectRouteErrorCode(candidate)) code = candidate;
  }
  return { ok: false, code, requestId: requestIdFrom(response, payload) };
}

export async function requestDirectRoute<T>(
  input: DirectRouteRequest,
): Promise<DirectRouteResult<T>> {
  const fetcher = input.fetcher ?? fetch;
  const headers = new Headers();
  if (input.body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetcher(input.url, {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      method: input.method ?? "GET",
      signal: input.signal,
    });
  } catch {
    return { ok: false, code: "AUTH_REQUEST_FAILED", requestId: "unknown" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failure(response, null);
  }
  if (!response.ok) return failure(response, payload);
  if (!payload || typeof payload !== "object") return failure(response, null);
  return {
    ok: true,
    data: payload as T,
    requestId: requestIdFrom(response, payload),
  };
}
