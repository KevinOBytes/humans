import "server-only";

import { parseServerEnv, type ServerEnv } from "@/lib/env/server-schema";

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(source?: NodeJS.ProcessEnv): ServerEnv {
  if (source) return parseServerEnv(source);
  cachedServerEnv ??= parseServerEnv(process.env);
  return cachedServerEnv;
}
