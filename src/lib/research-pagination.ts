const opaqueCursorPattern = /^[A-Za-z0-9_-]{1,1024}$/u;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export function readOpaqueCursor(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" && opaqueCursorPattern.test(value)
    ? value
    : undefined;
}

export function readBoundedId(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" && idPattern.test(value) ? value : undefined;
}

export function profilePageHref(
  personId: string,
  view: string,
  values: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const params = new URLSearchParams({ view });
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  return `/people/${personId}?${params.toString()}`;
}
