// @vitest-environment node

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  classifyClientAddress,
  type TrustedProxyConfig,
} from "@/lib/network/client-address";

const hmacKey = "73".repeat(32);

function request(headers: Record<string, string | undefined>): Request {
  const present = Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return new Request("https://humans.test/api/graphql", { headers: present });
}

function signature(address: string): string {
  return createHmac("sha256", Buffer.from(hmacKey, "hex"))
    .update("humans:trusted-client-address:v1\0", "utf8")
    .update(address, "utf8")
    .digest("hex");
}

describe("trusted client address classification", () => {
  it("ignores every header in none mode", () => {
    expect(
      classifyClientAddress(
        request({
          "x-forwarded-for": "203.0.113.9",
          "x-humans-client-address": "198.51.100.8",
          "x-vercel-forwarded-for": "192.0.2.7",
        }),
        { deploymentMode: "docker", mode: "none" },
      ),
    ).toEqual({ reason: "disabled", trust: "unknown" });
  });

  it.each([
    ["203.0.113.9", { family: 4, prefix: "203.0.113.0/24" }],
    ["2001:0DB8:abcd:0012::9", { family: 6, prefix: "2001:db8:abcd:12::/64" }],
    ["::ffff:192.0.2.129", { family: 4, prefix: "192.0.2.0/24" }],
  ] as const)("classifies one Vercel literal %s", (address, expected) => {
    expect(
      classifyClientAddress(
        request({
          "x-forwarded-for": "10.0.0.1",
          "x-real-ip": "10.0.0.2",
          "x-vercel-forwarded-for": address,
        }),
        { deploymentMode: "vercel", mode: "vercel" },
      ),
    ).toEqual({ ...expected, source: "vercel", trust: "trusted" });
  });

  it("authenticates the canonical full address in HMAC mode", () => {
    const address = "2001:0DB8::0001";
    expect(
      classifyClientAddress(
        request({
          "x-forwarded-for": "10.0.0.1",
          "x-humans-client-address": address,
          "x-humans-client-address-signature": signature("2001:db8::1"),
        }),
        { deploymentMode: "docker", hmacKey, mode: "hmac" },
      ),
    ).toEqual({
      family: 6,
      prefix: "2001:db8::/64",
      source: "hmac_proxy",
      trust: "trusted",
    });
  });

  it.each([
    {},
    { "x-vercel-forwarded-for": "203.0.113.1, 203.0.113.2" },
    { "x-vercel-forwarded-for": "203.0. 113.1" },
    { "x-vercel-forwarded-for": "203.0.113.1:443" },
    { "x-vercel-forwarded-for": "fe80::1%en0" },
    { "x-vercel-forwarded-for": "x".repeat(129) },
  ])(
    "returns a neutral unknown result for malformed Vercel input",
    (headers) => {
      const result = classifyClientAddress(request(headers), {
        deploymentMode: "vercel",
        mode: "vercel",
      });
      expect(result.trust).toBe("unknown");
    },
  );

  it("does not distinguish HMAC tampering, malformed signatures, or missing metadata by error", () => {
    const config: TrustedProxyConfig = {
      deploymentMode: "docker",
      hmacKey,
      mode: "hmac",
    };
    for (const headers of [
      {},
      { "x-humans-client-address": "203.0.113.1" },
      {
        "x-humans-client-address": "203.0.113.1",
        "x-humans-client-address-signature": "A".repeat(64),
      },
      {
        "x-humans-client-address": "203.0.113.2",
        "x-humans-client-address-signature": signature("203.0.113.1"),
      },
    ]) {
      expect(() =>
        classifyClientAddress(request(headers), config),
      ).not.toThrow();
      expect(classifyClientAddress(request(headers), config).trust).toBe(
        "unknown",
      );
    }
  });
});
