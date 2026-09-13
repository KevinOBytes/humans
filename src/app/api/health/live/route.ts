import { correlationHeaders, requestCorrelationId } from "@/lib/api/request-id";
import { createMethodBoundary } from "@/lib/api/method-boundary";

const methods = createMethodBoundary(["GET", "HEAD", "OPTIONS"]);
export const DELETE = methods.deny;
export const PATCH = methods.deny;
export const POST = methods.deny;
export const PUT = methods.deny;
export const OPTIONS = methods.options;

export function GET(request: Request): Response {
  const requestId = requestCorrelationId(request);
  return Response.json(
    { status: "ok", service: "humans", requestId },
    { headers: correlationHeaders(requestId) },
  );
}
