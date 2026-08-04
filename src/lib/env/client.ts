import { z } from "zod";

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
