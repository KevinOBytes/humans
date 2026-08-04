import { NextResponse, type NextRequest } from "next/server";

import { routeProxy } from "@/route-proxy";

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
};

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function applySecurityHeaders(request: NextRequest, response: NextResponse) {
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    response.headers.set("cache-control", "no-store");
  }
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (
      request.nextUrl.protocol === "http:" &&
      loopbackHostnames.has(request.nextUrl.hostname) &&
      (name === "strict-transport-security" ||
        name === "content-security-policy")
    ) {
      if (name === "content-security-policy") {
        response.headers.set(
          name,
          value.replace("; upgrade-insecure-requests", ""),
        );
      }
      continue;
    }
    response.headers.set(name, value);
  }
  return response;
}

export default function proxy(request: NextRequest) {
  return applySecurityHeaders(request, routeProxy(request));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest).*)",
  ],
};
