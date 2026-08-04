import { createHmac } from "node:crypto";

import {
  classifyClientAddress,
  type TrustedProxyConfig,
} from "@/lib/network/client-address";
import {
  AUTH_RATE_LIMIT_ADDRESS_HEADER,
  AUTH_REQUEST_ID_HEADER,
} from "@/modules/auth/request-headers";

export { AUTH_RATE_LIMIT_ADDRESS_HEADER, AUTH_REQUEST_ID_HEADER };

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const targetFields = new Map([
  ["/api/auth/sign-in/email", "email"],
  ["/api/auth/sign-in/username", "username"],
  ["/api/auth/sign-up/email", "email"],
  ["/api/auth/request-password-reset", "email"],
]);

function trustedPrefixAddress(prefix: string): string {
  return prefix.slice(0, prefix.lastIndexOf("/"));
}

function syntheticTargetAddress(target: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update("humans:auth-rate-limit-target:v1\0", "utf8")
    .update(target, "utf8")
    .digest();
  const groups = ["fd00"];
  for (let offset = 0; offset < 14; offset += 2) {
    groups.push(digest.readUInt16BE(offset).toString(16));
  }
  return groups.join(":");
}

async function targetIdentity(request: Request): Promise<string> {
  const path = new URL(request.url).pathname;
  const targetField = targetFields.get(path);
  if (!targetField) return path;
  try {
    const body = (await request.clone().json()) as unknown;
    if (body && typeof body === "object") {
      const target = (body as Record<string, unknown>)[targetField];
      if (typeof target === "string") {
        const normalized = target.trim().toLowerCase().slice(0, 320);
        if (normalized) return `${path}\0${normalized}`;
      }
    }
  } catch {
    // Invalid bodies share a bounded per-path fallback bucket.
  }
  return `${path}\0invalid`;
}

export async function resolveAuthClientAddress(
  request: Request,
  input: {
    authSecret: string;
    clientAddressConfig: TrustedProxyConfig;
  },
): Promise<string> {
  const classification = classifyClientAddress(
    request,
    input.clientAddressConfig,
  );
  return classification.trust === "trusted"
    ? trustedPrefixAddress(classification.prefix)
    : syntheticTargetAddress(await targetIdentity(request), input.authSecret);
}

export function sanitizeAuthRequestId(value: string | null): string {
  const candidate = value?.trim();
  return candidate && requestIdPattern.test(candidate)
    ? candidate.toLowerCase()
    : crypto.randomUUID();
}

export async function decorateAuthBoundaryResponse(
  response: Response,
  requestId: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  if (response.status >= 400) {
    headers.set("cache-control", "private, no-store");
  }
  if (response.status < 400) {
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  if (
    !headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({ code: "AUTH_REQUEST_FAILED", requestId }),
      { headers, status: response.status, statusText: response.statusText },
    );
  }
  try {
    const raw = await response.text();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Response(
        JSON.stringify({ code: "AUTH_REQUEST_FAILED", requestId }),
        { headers, status: response.status, statusText: response.statusText },
      );
    }
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({ ...(parsed as Record<string, unknown>), requestId }),
      { headers, status: response.status, statusText: response.statusText },
    );
  } catch {
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({ code: "AUTH_REQUEST_FAILED", requestId }),
      {
        headers,
        status: response.status,
        statusText: response.statusText,
      },
    );
  }
}

export async function prepareAuthBoundaryRequest(
  request: Request,
  input: {
    authSecret: string;
    clientAddressConfig: TrustedProxyConfig;
  },
): Promise<Request> {
  const address = await resolveAuthClientAddress(request, input);
  const requestId = sanitizeAuthRequestId(request.headers.get("x-request-id"));
  const headers = new Headers(request.headers);
  headers.delete(AUTH_RATE_LIMIT_ADDRESS_HEADER);
  headers.delete(AUTH_REQUEST_ID_HEADER);
  headers.set(AUTH_RATE_LIMIT_ADDRESS_HEADER, address);
  headers.set(AUTH_REQUEST_ID_HEADER, requestId);
  return new Request(request.url, {
    body: request.body,
    headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
    ...(request.body ? { duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });
}
