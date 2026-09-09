import { correlationHeaders, requestCorrelationId } from "@/lib/api/request-id";

export function GET(request: Request): Response {
  const requestId = requestCorrelationId(request);
  return Response.json(
    { status: "ok", service: "humans", requestId },
    { headers: correlationHeaders(requestId) },
  );
}
