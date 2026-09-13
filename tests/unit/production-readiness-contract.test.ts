import { describe, expect, it } from "vitest";

describe("production readiness smoke contract", () => {
  it("rejects missing, credential-bearing, and non-http URLs", async () => {
    const { parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(() => parseBaseUrl("")).toThrow(/base-url/);
    expect(() => parseBaseUrl("ftp://example.invalid")).toThrow(/HTTP/);
    expect(() => parseBaseUrl("https://user:pass@example.invalid")).toThrow(
      /credential-free/,
    );
  });

  it("parses only the explicit smoke switches", async () => {
    const { parseArgs } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(
      parseArgs([
        "--base-url",
        "https://example.invalid",
        "--provider-contracts",
      ]),
    ).toEqual({
      baseUrl: "https://example.invalid",
      providerContracts: true,
    });
    expect(() => parseArgs(["--secret", "value"])).toThrow(/Unknown/);
  });

  it("never includes response bodies or credentials in its observable error shape", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const logs: string[] = [];
    await expect(
      runProductionSmoke({
        base: parseBaseUrl("https://example.invalid"),
        log: (line: string) => {
          logs.push(line);
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ secret: "do-not-print" }), {
            status: 500,
          }),
      }),
    ).rejects.toThrow(/homepage returned 500/);
    expect(logs.join("\n")).not.toContain("do-not-print");
  });

  it("requires and verifies both configured administrator sign-in identifiers", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const requests: Array<{ path: string; body?: string }> = [];
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const personId = "00000000-0000-4000-8000-000000000002";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ path: url.pathname, body });

      if (url.pathname === "/") return new Response("Humans", { status: 200 });
      if (url.pathname === "/api/health/live")
        return Response.json({ status: "ok" }, { status: 200 });
      if (url.pathname === "/api/health/ready")
        return Response.json({ status: "ready" }, { status: 200 });
      if (url.pathname === "/api/graphql") {
        const query = body ?? "";
        if (query.includes("SmokeQuery"))
          return Response.json(
            { errors: [{ message: "unauthenticated" }] },
            { status: 401 },
          );
        if (query.includes("SmokeViewer"))
          return Response.json(
            {
              data: {
                viewer: { id: workspaceId, workspace: { id: workspaceId } },
              },
            },
            { status: 200 },
          );
        if (query.includes("SmokeCreatePerson"))
          return Response.json(
            {
              data: {
                createPerson: {
                  person: { id: personId, displayName: "Smoke" },
                  code: "CREATED",
                },
              },
            },
            { status: 200 },
          );
        if (query.includes("SmokePerson"))
          return Response.json(
            { data: { person: { id: personId, displayName: "Smoke" } } },
            { status: 200 },
          );
      }
      if (url.pathname === "/api/jobs/run")
        return Response.json({ success: false }, { status: 401 });
      if (
        url.pathname === "/api/auth/sign-in/email" ||
        url.pathname === "/api/auth/sign-in/username"
      )
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": "humans.session=smoke; Path=/; HttpOnly" },
        });
      throw new Error(`unexpected smoke request ${url.pathname}`);
    };

    await runProductionSmoke({
      base: parseBaseUrl("https://humans.example.com"),
      auth: true,
      adminEmail: "admin@example.com",
      adminUsername: "humans-admin",
      adminPassword: "operator-password",
      fetchImpl,
      log: () => undefined,
    });

    expect(
      requests
        .filter(({ path }) => path.startsWith("/api/auth/sign-in/"))
        .map(({ path, body }) => [path, JSON.parse(body ?? "{}")]),
    ).toEqual([
      [
        "/api/auth/sign-in/email",
        { email: "admin@example.com", password: "operator-password" },
      ],
      [
        "/api/auth/sign-in/username",
        { username: "humans-admin", password: "operator-password" },
      ],
    ]);
  });
});
