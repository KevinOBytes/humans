export { createStorageProxyHandlers } from "@/lib/storage/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(): Promise<Response> {
  return Response.json({ status: "not_found" }, { status: 404 });
}

export async function GET(): Promise<Response> {
  return Response.json({ status: "not_found" }, { status: 404 });
}
