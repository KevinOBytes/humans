type DatabaseResetGuardInput = {
  allowReset: string | undefined;
  currentDatabase: string;
  databaseUrl: string | undefined;
};

export function assertTestDatabaseResetAllowed({
  allowReset,
  currentDatabase,
  databaseUrl,
}: DatabaseResetGuardInput): string {
  if (allowReset !== "true") {
    throw new Error(
      "Destructive test setup requires ALLOW_TEST_DATABASE_RESET=true",
    );
  }

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for destructive test setup");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!/^(?:postgres|postgresql):$/.test(parsed.protocol)) {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  const urlDatabase = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^[a-z0-9][a-z0-9_]*_test$/.test(urlDatabase)) {
    throw new Error("Test database name must end exactly in _test");
  }

  if (currentDatabase !== urlDatabase) {
    throw new Error(
      "TEST_DATABASE_URL database does not match current_database()",
    );
  }

  return currentDatabase;
}
