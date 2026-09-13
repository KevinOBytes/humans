const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function requestCorrelationId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && requestIdPattern.test(candidate)
    ? candidate.toLowerCase()
    : crypto.randomUUID();
}

export function correlationHeaders(requestId: string): Headers {
  return new Headers({
    "cache-control": "private, no-store",
    "x-request-id": requestId,
  });
}
