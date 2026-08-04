export const SETTINGS_PAGE_SIZE = 25;
const MAX_SETTINGS_OFFSET = 1_000_000;

export type SafeSettingsPage<T> = {
  nodes: readonly T[];
  offset: number;
  limit: number;
  total: number;
  hasPrevious: boolean;
  hasMore: boolean;
};

export function readSettingsOffset(
  value: string | string[] | undefined,
): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return 0;
  const offset = Number(value);
  return Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= MAX_SETTINGS_OFFSET &&
    offset % SETTINGS_PAGE_SIZE === 0
    ? offset
    : 0;
}

export function normalizeSettingsOffset(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SETTINGS_OFFSET &&
    value % SETTINGS_PAGE_SIZE === 0
    ? value
    : 0;
}

export function buildSafeSettingsPage<T>(
  nodes: readonly T[],
  offset: number,
  total: number,
): SafeSettingsPage<T> {
  return {
    nodes,
    offset,
    limit: SETTINGS_PAGE_SIZE,
    total,
    hasPrevious: offset > 0,
    hasMore: offset + nodes.length < total,
  };
}
