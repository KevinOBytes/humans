type DatabaseSeedGuardInput = {
  allowSeed: string | undefined;
  databaseUrl: string | undefined;
  nodeEnv: string | undefined;
};

export function assertDatabaseSeedAllowed({
  allowSeed,
  databaseUrl,
  nodeEnv,
}: DatabaseSeedGuardInput): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database) {
    throw new Error("DATABASE_URL must name a PostgreSQL database");
  }

  if (allowSeed === "true") return database;

  const effectiveNodeEnv = nodeEnv ?? "development";
  if (
    (effectiveNodeEnv === "development" || effectiveNodeEnv === "test") &&
    database.endsWith("_test")
  ) {
    return database;
  }

  throw new Error(
    `Refusing to seed database ${JSON.stringify(database)}. Set ALLOW_DATABASE_SEED=true for this explicit operation.`,
  );
}
