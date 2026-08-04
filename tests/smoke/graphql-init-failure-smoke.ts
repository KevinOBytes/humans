function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const baseUrl = process.env.GRAPHQL_SMOKE_BASE_URL;
  assert(baseUrl, "GRAPHQL_SMOKE_BASE_URL is required");
  const requestId = crypto.randomUUID();
  const response = await fetch(new URL("/api/graphql", baseUrl), {
    body: JSON.stringify({ query: "query { viewer { id } }" }),
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    method: "POST",
  });
  const body = (await response.json()) as {
    errors?: Array<{ extensions?: { code?: string; requestId?: string } }>;
  };

  assert(response.status === 500, "Initialization failure was not HTTP 500");
  assert(
    response.headers.get("x-request-id") === requestId,
    "Initialization failure did not preserve the request ID header",
  );
  assert(
    body.errors?.[0]?.extensions?.code === "INTERNAL" &&
      body.errors[0].extensions.requestId === requestId,
    "Initialization failure did not return the masked GraphQL envelope",
  );
  assert(
    response.headers.get("cache-control") === "private, no-store",
    "Initialization failure was cacheable",
  );
  process.stdout.write("GraphQL initialization-failure smoke passed\n");
}

void main().catch(() => {
  process.stderr.write("GraphQL initialization-failure smoke failed\n");
  process.exitCode = 1;
});
