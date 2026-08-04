import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { createGraphQLError } from "@/graphql/errors";

import {
  canonicalSearchJson,
  SEARCH_RESULT_KINDS,
  type SearchResultKind,
} from "./normalization";

type TextSearchCursor = {
  branch: "text";
  kind: SearchResultKind;
  queryHash: string;
  rank: number;
  resourceId: string;
  updatedAt: string;
  workspaceId: string;
};
type ProtectedSearchCursor = {
  branch: "protectedExact";
  kind: "PERSON";
  personId: string;
  queryHash: string;
  workspaceId: string;
};
export type SearchCursorPayload = TextSearchCursor | ProtectedSearchCursor;

const HEX_KEY = /^[0-9a-f]{64}$/iu;
const HEX_HASH = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function invalid(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "The search cursor is invalid.",
  );
}

function key(secret: string): Buffer {
  if (!HEX_KEY.test(secret)) return invalid();
  return Buffer.from(secret, "hex");
}

function component(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function hmac(
  secret: string,
  domain: string,
  values: readonly string[],
): string {
  const digest = createHmac("sha256", key(secret));
  digest.update(`${domain}\0`, "utf8");
  for (const value of values) digest.update(component(value));
  return digest.digest("hex");
}

export function searchQueryBinding(
  secret: string,
  input: {
    branch: "text" | "protectedExact";
    query: string;
    workspaceId: string;
  },
): string {
  if (
    !UUID.test(input.workspaceId.toLowerCase()) ||
    typeof input.query !== "string"
  )
    return invalid();
  return hmac(secret, "humans:search-query-binding:v1", [
    input.workspaceId.toLowerCase(),
    input.branch,
    input.query,
  ]);
}

function validatePayload(value: unknown): SearchCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const payload = value as Record<string, unknown>;
  if (
    payload.v !== 1 ||
    payload.p !== "humans.search.cursor.v1" ||
    typeof payload.branch !== "string" ||
    typeof payload.workspaceId !== "string" ||
    !UUID.test(payload.workspaceId) ||
    typeof payload.queryHash !== "string" ||
    !HEX_HASH.test(payload.queryHash)
  )
    return invalid();
  if (payload.branch === "text") {
    if (
      Reflect.ownKeys(payload).length !== 9 ||
      typeof payload.kind !== "string" ||
      !SEARCH_RESULT_KINDS.includes(payload.kind as SearchResultKind) ||
      typeof payload.rank !== "number" ||
      !Number.isFinite(payload.rank) ||
      payload.rank < 0 ||
      typeof payload.resourceId !== "string" ||
      !UUID.test(payload.resourceId) ||
      typeof payload.updatedAt !== "string" ||
      new Date(payload.updatedAt).toISOString() !== payload.updatedAt
    )
      return invalid();
    return {
      branch: "text",
      kind: payload.kind as SearchResultKind,
      queryHash: payload.queryHash,
      rank: payload.rank,
      resourceId: payload.resourceId,
      updatedAt: payload.updatedAt,
      workspaceId: payload.workspaceId,
    };
  }
  if (
    payload.branch !== "protectedExact" ||
    Reflect.ownKeys(payload).length !== 7 ||
    payload.kind !== "PERSON" ||
    typeof payload.personId !== "string" ||
    !UUID.test(payload.personId)
  )
    return invalid();
  return {
    branch: "protectedExact",
    kind: "PERSON",
    personId: payload.personId,
    queryHash: payload.queryHash,
    workspaceId: payload.workspaceId,
  };
}

export function encodeSearchCursor(
  payload: SearchCursorPayload,
  secret: string,
): string {
  const normalized = validatePayload({
    v: 1,
    p: "humans.search.cursor.v1",
    ...payload,
  });
  const body = Buffer.from(
    canonicalSearchJson({ v: 1, p: "humans.search.cursor.v1", ...normalized }),
    "utf8",
  ).toString("base64url");
  const signature = hmac(secret, "humans:search-cursor-signature:v1", [body]);
  return `${body}.${signature}`;
}

export function decodeSearchCursor(
  value: string,
  binding: {
    branch: "text" | "protectedExact";
    queryHash: string;
    secret: string;
    workspaceId: string;
  },
): SearchCursorPayload {
  try {
    if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u.test(value))
      return invalid();
    const [body = "", signature = ""] = value.split(".");
    const expected = hmac(binding.secret, "humans:search-cursor-signature:v1", [
      body,
    ]);
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      )
    )
      return invalid();
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length > 1_024 || bytes.toString("base64url") !== body)
      return invalid();
    const payload = validatePayload(JSON.parse(bytes.toString("utf8")));
    if (
      payload.branch !== binding.branch ||
      payload.workspaceId !== binding.workspaceId.toLowerCase() ||
      payload.queryHash !== binding.queryHash
    )
      return invalid();
    return payload;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { extensions?: { code?: unknown } }).extensions?.code ===
        "VALIDATION_FAILED"
    )
      throw error;
    return invalid();
  }
}
