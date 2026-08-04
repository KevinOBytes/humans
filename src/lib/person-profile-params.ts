import { readOpaqueCursor } from "@/lib/research-pagination";

export type SearchState = Record<string, string | string[] | undefined>;

export const personIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function stringParam(
  params: SearchState,
  key: string,
  max = 100,
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length <= max ? value : undefined;
}

export function uuidParam(
  params: SearchState,
  key: string,
): string | undefined {
  const value = stringParam(params, key, 64);
  return value && personIdPattern.test(value) ? value : undefined;
}

export function cursorParam(
  params: SearchState,
  key: string,
): string | undefined {
  return readOpaqueCursor(params[key]);
}
