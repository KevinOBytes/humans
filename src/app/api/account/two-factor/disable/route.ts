export { POST } from "./handlers";
import { createMethodBoundary } from "@/lib/api/method-boundary";

const methods = createMethodBoundary(["POST", "OPTIONS"]);
export const DELETE = methods.deny;
export const GET = methods.deny;
export const HEAD = methods.deny;
export const PATCH = methods.deny;
export const PUT = methods.deny;
export const OPTIONS = methods.options;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
