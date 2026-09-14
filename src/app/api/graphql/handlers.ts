import {
  createGraphQLInternalErrorResponse,
  createGraphQLRequestId,
} from "@/graphql/server";
import { productionSecurityEventLogger } from "@/lib/observability/security-events";

type GraphQLRequestHandler = (
  request: Request,
  requestId?: string,
) => Promise<Response>;

export function createGraphQLRouteHandler(
  loadHandler: () => Promise<GraphQLRequestHandler>,
  logger: Pick<
    typeof productionSecurityEventLogger,
    "log"
  > = productionSecurityEventLogger,
) {
  return async function graphqlRouteHandler(request: Request) {
    const requestId = createGraphQLRequestId(request);
    try {
      const loadedHandler = await loadHandler();
      return await loadedHandler(request, requestId);
    } catch {
      logger.log({
        event: "graphql.initialization.internal",
        requestId,
        severity: "error",
      });
      return createGraphQLInternalErrorResponse(requestId);
    }
  };
}
