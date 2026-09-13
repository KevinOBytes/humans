import { correlationHeaders, requestCorrelationId } from "./request-id";

/** Explicitly replace Next's uncorrelated automatic 405/OPTIONS responses.
 * These handlers never initialize providers, read bodies, or grant CORS access.
 * HEAD denials and OPTIONS intentionally have no body under HTTP semantics.
 */
export function createMethodBoundary(
  allowedMethods: readonly string[],
  format: "direct" | "graphql" = "direct",
) {
  const allow = [...allowedMethods].sort().join(", ");
  return {
    deny(request: Request): Response {
      const requestId = requestCorrelationId(request);
      const headers = correlationHeaders(requestId);
      headers.set("allow", allow);
      if (request.method === "HEAD") {
        return new Response(null, { status: 405, headers });
      }
      return Response.json(
        format === "graphql"
          ? {
              errors: [
                {
                  message: "The HTTP method is not supported.",
                  extensions: { code: "VALIDATION_FAILED", requestId },
                },
              ],
            }
          : { code: "METHOD_NOT_ALLOWED", requestId },
        { status: 405, headers },
      );
    },
    options(request: Request): Response {
      const headers = correlationHeaders(requestCorrelationId(request));
      headers.set("allow", allow);
      return new Response(null, { status: 204, headers });
    },
  };
}
