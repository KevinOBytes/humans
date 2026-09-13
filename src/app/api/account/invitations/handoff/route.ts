export { DELETE, GET, POST } from "./handlers";
import { createMethodBoundary } from "@/lib/api/method-boundary";

const methods = createMethodBoundary([
  "DELETE",
  "GET",
  "HEAD",
  "POST",
  "OPTIONS",
]);
export const PATCH = methods.deny;
export const PUT = methods.deny;
export const OPTIONS = methods.options;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
