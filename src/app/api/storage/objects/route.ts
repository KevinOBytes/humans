export { GET, PUT } from "./handlers";
import { createMethodBoundary } from "@/lib/api/method-boundary";

const methods = createMethodBoundary(["GET", "HEAD", "PUT", "OPTIONS"]);
export const DELETE = methods.deny;
export const PATCH = methods.deny;
export const POST = methods.deny;
export const OPTIONS = methods.options;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
