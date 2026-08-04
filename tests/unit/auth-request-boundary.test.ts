// @vitest-environment node

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AUTH_RATE_LIMIT_ADDRESS_HEADER,
  decorateAuthBoundaryResponse,
  prepareAuthBoundaryRequest,
} from "@/modules/auth/request-boundary";

const secret = "test-only-auth-boundary-secret-".repeat(2);

function request(
  headers: Record<string, string>,
  email = "Person@Example.test",
) {
  return new Request("https://humans.example.test/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email, password: "never-used-by-boundary" }),
  });
}

function signature(address: string, key: string) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update("humans:trusted-client-address:v1\0", "utf8")
    .update(address, "utf8")
    .digest("hex");
}

const untrustedVercelHeaders: Record<string, string>[] = [
  {},
  { "x-vercel-forwarded-for": "198.51.100.1, 203.0.113.2" },
];

describe("auth request client-address boundary", () => {
  it("uses only the single trusted Vercel address and ignores spoofed forwarding", async () => {
    const prepared = await prepareAuthBoundaryRequest(
      request({
        "x-forwarded-for": "203.0.113.99",
        "x-vercel-forwarded-for": "198.51.100.42",
        [AUTH_RATE_LIMIT_ADDRESS_HEADER]: "192.0.2.10",
      }),
      {
        authSecret: secret,
        clientAddressConfig: { deploymentMode: "vercel", mode: "vercel" },
      },
    );

    expect(prepared.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).toBe(
      "198.51.100.0",
    );
  });

  it.each(untrustedVercelHeaders)(
    "uses stable target-bound fallback for untrusted Vercel metadata",
    async (headers) => {
      const first = await prepareAuthBoundaryRequest(request(headers), {
        authSecret: secret,
        clientAddressConfig: { deploymentMode: "vercel", mode: "vercel" },
      });
      const same = await prepareAuthBoundaryRequest(
        request(headers, " person@example.test "),
        {
          authSecret: secret,
          clientAddressConfig: { deploymentMode: "vercel", mode: "vercel" },
        },
      );
      const other = await prepareAuthBoundaryRequest(
        request(headers, "other@example.test"),
        {
          authSecret: secret,
          clientAddressConfig: { deploymentMode: "vercel", mode: "vercel" },
        },
      );

      expect(first.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).toBe(
        same.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER),
      );
      expect(first.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).not.toBe(
        other.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER),
      );
    },
  );

  it("ignores Docker forwarding unless the address has a valid HMAC", async () => {
    const hmacKey = "ab".repeat(32);
    const spoofed = await prepareAuthBoundaryRequest(
      request({ "x-forwarded-for": "198.51.100.42" }),
      {
        authSecret: secret,
        clientAddressConfig: { deploymentMode: "docker", mode: "none" },
      },
    );
    const authenticated = await prepareAuthBoundaryRequest(
      request({
        "x-humans-client-address": "203.0.113.77",
        "x-humans-client-address-signature": signature("203.0.113.77", hmacKey),
      }),
      {
        authSecret: secret,
        clientAddressConfig: {
          deploymentMode: "docker",
          hmacKey,
          mode: "hmac",
        },
      },
    );
    const multiHop = await prepareAuthBoundaryRequest(
      request({
        "x-humans-client-address": "203.0.113.77, 198.51.100.2",
        "x-humans-client-address-signature": signature(
          "203.0.113.77, 198.51.100.2",
          hmacKey,
        ),
      }),
      {
        authSecret: secret,
        clientAddressConfig: {
          deploymentMode: "docker",
          hmacKey,
          mode: "hmac",
        },
      },
    );

    expect(authenticated.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).toBe(
      "203.0.113.0",
    );
    expect(spoofed.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).not.toBe(
      "198.51.100.0",
    );
    expect(multiHop.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).not.toBe(
      "203.0.113.0",
    );
  });

  it("separates sign-in fallback buckets by normalized account target", async () => {
    const prepare = (username: string) =>
      prepareAuthBoundaryRequest(
        new Request("https://humans.example.test/api/auth/sign-in/username", {
          body: JSON.stringify({ password: "unused", username }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        {
          authSecret: secret,
          clientAddressConfig: { deploymentMode: "docker", mode: "none" },
        },
      );
    const first = await prepare(" AccountOne ");
    const same = await prepare("accountone");
    const other = await prepare("accounttwo");

    expect(first.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).toBe(
      same.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER),
    );
    expect(first.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER)).not.toBe(
      other.headers.get(AUTH_RATE_LIMIT_ADDRESS_HEADER),
    );
  });

  it("decorates successful, error, and rate-limit responses with correlation", async () => {
    const id = "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1";
    const success = await decorateAuthBoundaryResponse(
      Response.json({ status: true }),
      id,
    );
    const failure = await decorateAuthBoundaryResponse(
      Response.json({ code: "RATE_LIMITED" }, { status: 429 }),
      id,
    );
    const malformedShape = await decorateAuthBoundaryResponse(
      Response.json(["unsafe-shape"], { status: 500 }),
      id,
    );

    expect(success.headers.get("x-request-id")).toBe(id);
    expect(await success.json()).toEqual({ status: true });
    expect(failure.headers.get("x-request-id")).toBe(id);
    expect(await failure.json()).toEqual({
      code: "RATE_LIMITED",
      requestId: id,
    });
    expect(await malformedShape.json()).toEqual({
      code: "AUTH_REQUEST_FAILED",
      requestId: id,
    });
  });
});
