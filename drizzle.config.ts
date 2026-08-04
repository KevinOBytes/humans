import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://humans:humans@127.0.0.1:5432/humans",
  },
  strict: true,
  verbose: true,
});
