// @vitest-environment node

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  GraphQLFixture,
  createSyntheticGraphQLSchema,
  expectGraphQLError,
} from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("GraphQL request and operation limits", () => {
  let fixture: GraphQLFixture;

  beforeAll(() => {
    fixture = new GraphQLFixture({
      schema: createSyntheticGraphQLSchema(),
    });
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("rejects unsupported content types, encodings, and multipart requests", async () => {
    const actor = await fixture.createSessionActor();
    for (const input of [
      { contentType: "text/plain" },
      { contentType: "multipart/form-data; boundary=fixture" },
      { encoding: "gzip" },
    ]) {
      const result = await fixture.execute({ jar: actor.jar, ...input });
      expect(result.status).toBe(415);
      expectGraphQLError(result, "VALIDATION_FAILED");
    }
  });

  it("accepts only JSON with no parameters or one UTF-8 charset parameter", async () => {
    const actor = await fixture.createSessionActor();
    for (const contentType of [
      "application/json",
      "application/json; charset=utf-8",
      'application/json; charset="UTF-8"',
    ]) {
      const result = await fixture.execute({
        contentType,
        jar: actor.jar,
        query: "query { workspace { id } }",
      });
      expect(result.body?.errors).toBeUndefined();
    }

    for (const contentType of [
      "application/json; boundary=fixture",
      "application/json; charset=iso-8859-1",
      "application/json; charset=utf-8; charset=utf-8",
      "application/json; charset=utf-8;",
      "application/json; charset",
      "application/json, application/json",
    ]) {
      const result = await fixture.execute({
        contentType,
        jar: actor.jar,
        query: "query { workspace { id } }",
      });
      expect(result.status).toBe(415);
      expectGraphQLError(result, "VALIDATION_FAILED");
    }
  });

  it("normalizes a failing request body stream as an internal GraphQL response", async () => {
    const actor = await fixture.createSessionActor();
    const streamSecret = "private-stream-failure";
    const headers = new Headers({
      "content-type": "application/json",
      origin: "http://127.0.0.1:3106",
      "sec-fetch-site": "same-origin",
    });
    actor.jar.apply(headers);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(streamSecret));
      },
    });
    const request = new Request("http://127.0.0.1:3106/api/graphql", {
      body,
      duplex: "half",
      headers,
      method: "POST",
    } as RequestInit & { duplex: "half" });

    const result = await fixture.executeRequest(request);
    expect(result.status).toBe(500);
    expectGraphQLError(result, "INTERNAL");
    expect(JSON.stringify(fixture.capturedLogs)).not.toContain(streamSecret);
  });

  it("normalizes lazy production-route initialization failure with one request ID", async () => {
    vi.resetModules();
    const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { POST } = await import("@/app/api/graphql/route");
      const response = await POST(
        new Request("http://127.0.0.1:3106/api/graphql", {
          body: JSON.stringify({ query: "query { viewer { id } }" }),
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          method: "POST",
        }),
      );
      const body = (await response.json()) as {
        errors?: Array<{ extensions?: Record<string, unknown> }>;
      };

      expect(response.status).toBe(500);
      expect(response.headers.get("x-request-id")).toBe(requestId);
      expect(body.errors?.[0]?.extensions).toEqual({
        code: "INTERNAL",
        requestId,
      });
      expect(consoleError.mock.calls).toEqual([
        [
          {
            event: "graphql.initialization.internal",
            requestId,
            severity: "error",
          },
        ],
      ]);
      expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
        /AUTH_SECRET|DATABASE_URL|failed query|parameters?:/iu,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects declared and streamed request bodies over 256 KiB", async () => {
    const actor = await fixture.createSessionActor();
    const declared = await fixture.execute({
      contentLength: 262_145,
      jar: actor.jar,
    });
    expect(declared.status).toBe(413);
    expectGraphQLError(declared, "VALIDATION_FAILED");

    const actual = await fixture.execute({
      body: JSON.stringify({ query: `{ ${"viewer { id } ".repeat(30_000)} }` }),
      jar: actor.jar,
    });
    expect(actual.status).toBe(413);
    expectGraphQLError(actual, "VALIDATION_FAILED");
  });

  it("rejects GraphQL request batches", async () => {
    const actor = await fixture.createSessionActor();
    const result = await fixture.execute({
      body: JSON.stringify([{ query: "query { viewer { id } }" }]),
      jar: actor.jar,
    });
    expectGraphQLError(result, "VALIDATION_FAILED");
  });

  it("normalizes parse and validation failures with correlation IDs", async () => {
    const actor = await fixture.createSessionActor();
    expectGraphQLError(
      await fixture.execute({ body: "{", jar: actor.jar }),
      "VALIDATION_FAILED",
    );
    for (const query of ["query {", "query { missingField }"]) {
      const requestId = "0198-incorrect-request-id";
      const result = await fixture.execute({
        headers: { "x-request-id": requestId },
        jar: actor.jar,
        query,
      });
      expectGraphQLError(result, "VALIDATION_FAILED");
      expect(result.requestId).not.toBe(requestId);
    }
  });

  it("rejects excessive aliases and tokens with stable validation errors", async () => {
    const actor = await fixture.createSessionActor();
    const aliases = Array.from(
      { length: 16 },
      (_, index) => `a${index}: workspace { id }`,
    ).join("\n");
    expectGraphQLError(
      await fixture.execute({ jar: actor.jar, query: `query { ${aliases} }` }),
      "VALIDATION_FAILED",
    );

    const tokenHeavy = `query { viewer { ${"id ".repeat(2_100)} } }`;
    expectGraphQLError(
      await fixture.execute({ jar: actor.jar, query: tokenHeavy }),
      "VALIDATION_FAILED",
    );
  });

  it("rejects depth, breadth, and complexity violations", async () => {
    const actor = await fixture.createSessionActor();
    const tooDeep = `query { depthRoot { next { next { next { next { next { next { next { next { next { next { value } } } } } } } } } } } }`;
    const tooBroad = `query { breadthRoot { ${Array.from(
      { length: 101 },
      (_, index) => `field${index}`,
    ).join(" ")} } }`;
    const tooComplex = `query { expensive(first: 100) }`;
    for (const query of [tooDeep, tooBroad, tooComplex]) {
      expectGraphQLError(
        await fixture.execute({ jar: actor.jar, query }),
        "VALIDATION_FAILED",
      );
    }
  });

  it("validates pagination bounds centrally", async () => {
    const actor = await fixture.createSessionActor();
    for (const first of [0, -1, 101]) {
      expectGraphQLError(
        await fixture.execute({
          jar: actor.jar,
          query: `query Page($first: Int) { paginatedWorkspaces(first: $first) { id } }`,
          variables: { first },
        }),
        "VALIDATION_FAILED",
      );
    }
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        query: `query Page { paginatedWorkspaces(first: 5, last: 5) { id } }`,
      }),
      "VALIDATION_FAILED",
    );
    const valid = await fixture.execute({
      jar: actor.jar,
      query: `query Page { paginatedWorkspaces(first: 1) { id } }`,
    });
    expect(valid.body?.errors).toBeUndefined();
  });

  it("disables production GET while development permits authenticated GraphiQL and queries", async () => {
    const actor = await fixture.createSessionActor();
    const production = new GraphQLFixture({ environment: "production" });
    const development = new GraphQLFixture({ environment: "development" });
    try {
      await production.reset();
      await development.reset();
      const disabledGet = await production.execute({
        jar: actor.jar,
        method: "GET",
      });
      expect(disabledGet.status).toBe(405);
      expectGraphQLError(disabledGet, "VALIDATION_FAILED");

      const developmentActor = await development.createSessionActor();
      const graphiql = await development.execute({
        headers: { accept: "text/html", "x-graphql-yoga-csrf": "1" },
        jar: developmentActor.jar,
        method: "GET",
      });
      expect(graphiql.status).toBe(200);
      expect(graphiql.response.headers.get("content-type")).toContain(
        "text/html",
      );
      const query = await development.execute({
        headers: { "x-graphql-yoga-csrf": "1" },
        jar: developmentActor.jar,
        method: "GET",
      });
      expect(query.body?.errors).toBeUndefined();
      const introspection = await development.execute({
        headers: { "x-graphql-yoga-csrf": "1" },
        jar: developmentActor.jar,
        method: "GET",
        query: `query { __schema { queryType { name } } }`,
      });
      expect(introspection.body?.errors).toBeUndefined();
    } finally {
      await production.close();
      await development.close();
    }
  });

  it("requires explicit production introspection permission", async () => {
    const production = new GraphQLFixture({ environment: "production" });
    try {
      await production.reset();
      const owner = await production.createSessionActor();
      const readKey = await production.provisionKey(owner, {
        person: ["read"],
      });
      const introspectionKey = await production.provisionKey(owner, {
        graphql: ["introspect"],
      });
      const query = `query { __schema { queryType { name } } }`;
      const ownerIntrospection = await production.execute({
        jar: owner.jar,
        query,
      });
      expect(ownerIntrospection.body?.errors).toBeUndefined();
      expectGraphQLError(
        await production.execute({ apiKey: readKey.key, origin: null, query }),
        "FORBIDDEN",
      );
      const allowed = await production.execute({
        apiKey: introspectionKey.key,
        origin: null,
        query,
      });
      expect(allowed.body?.errors).toBeUndefined();
      expect(allowed.body?.data).toBeDefined();
    } finally {
      await production.close();
    }
  });

  it("masks unexpected errors and never logs credentials or variables", async () => {
    const actor = await fixture.createSessionActor();
    const secretVariable = "private-record-value";
    const result = await fixture.execute({
      jar: actor.jar,
      query: `query Explode($secret: String!) { internalFailure(secret: $secret) }`,
      variables: { secret: secretVariable },
    });
    expectGraphQLError(result, "INTERNAL");
    expect(result.body?.errors?.[0]?.message).toBe(
      "An internal error occurred.",
    );
    expect(fixture.capturedLogs).toEqual([
      {
        event: "auth.registration.allowed",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
        severity: "info",
      },
      {
        event: "graphql.request.internal",
        requestId: result.requestId,
        severity: "error",
      },
    ]);
    const logs = JSON.stringify(fixture.capturedLogs);
    expect(logs).not.toContain(actor.jar.toString());
    expect(logs).not.toContain(secretVariable);
    expect(logs).not.toMatch(/select |insert |update |delete /iu);

    const key = await fixture.provisionKey(actor);
    await fixture.execute({
      apiKey: key.key,
      origin: null,
      query: `query Explode($secret: String!) { internalFailure(secret: $secret) }`,
      variables: { secret: secretVariable },
    });
    expect(JSON.stringify(fixture.capturedLogs)).not.toContain(key.key);
  });

  it("returns private no-store responses and preserves valid caller request IDs", async () => {
    const actor = await fixture.createSessionActor();
    const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";
    const result = await fixture.execute({
      headers: { "x-request-id": requestId },
      jar: actor.jar,
    });
    expect(result.requestId).toBe(requestId);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
});
