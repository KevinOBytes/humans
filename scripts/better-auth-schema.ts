import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { createHumansAuth } from "@/lib/auth/config";

const connection = postgres(
  "postgresql://schema-generator:schema-generator@127.0.0.1:5432/schema-generator",
  { prepare: false },
);
const database = drizzle(connection, { schema });

export const auth = createHumansAuth({
  database,
  emailSender: {
    send: async () => ({ id: "schema-generation-only" }),
  },
  settings: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    AUTH_SECRET: "better-auth-cli-schema-generation-only-secret",
    AUTH_ENCRYPTION_KEY: "00".repeat(32),
    AUTH_REGISTRATION_MODE: "public",
    AUTH_SECURE_COOKIES: false,
    AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
  },
});

export default auth;
