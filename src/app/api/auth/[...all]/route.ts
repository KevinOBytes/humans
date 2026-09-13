export { DELETE, GET, PATCH, POST, PUT } from "./handlers";
import { createMethodBoundary } from "@/lib/api/method-boundary";

export const OPTIONS = createMethodBoundary([
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
  "OPTIONS",
]).options;
