import { storageErrorResponse, storageRequestId } from "@/lib/storage/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request): Promise<Response> {
  return storageErrorResponse(404, storageRequestId(request));
}

export async function GET(request: Request): Promise<Response> {
  return storageErrorResponse(404, storageRequestId(request));
}
