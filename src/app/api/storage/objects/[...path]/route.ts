import { storageErrorResponse, storageRequestId } from "@/lib/storage/proxy";
import { createMethodBoundary } from "@/lib/api/method-boundary";

const methods = createMethodBoundary(["GET", "HEAD", "PUT", "OPTIONS"]);
export const DELETE = methods.deny;
export const PATCH = methods.deny;
export const POST = methods.deny;
export const OPTIONS = methods.options;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request): Promise<Response> {
  return storageErrorResponse(404, storageRequestId(request));
}

export async function GET(request: Request): Promise<Response> {
  return storageErrorResponse(404, storageRequestId(request));
}
