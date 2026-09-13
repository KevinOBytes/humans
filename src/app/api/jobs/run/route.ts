export { GET, POST } from "./handler";
import { createMethodBoundary } from "@/lib/api/method-boundary";

const methods = createMethodBoundary(["GET", "HEAD", "OPTIONS"]);
export const DELETE = methods.deny;
export const PATCH = methods.deny;
export const PUT = methods.deny;
export const OPTIONS = methods.options;

export const runtime = "nodejs";
export const maxDuration = 30;
