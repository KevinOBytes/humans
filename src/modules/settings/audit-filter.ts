const minuteUtcPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

export type AuditDateTimeValue = {
  input: string | undefined;
  iso?: string;
  error?: string;
};

function parseAuditDateTimeLocal(
  value: string | undefined,
): AuditDateTimeValue {
  if (!value) return { input: value };
  const match = minuteUtcPattern.exec(value);
  if (!match) {
    return { input: value, error: "Enter a valid UTC date and time." };
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== parts.month - 1 ||
    date.getUTCDate() !== parts.day ||
    date.getUTCHours() !== parts.hour ||
    date.getUTCMinutes() !== parts.minute
  ) {
    return { input: value, error: "Enter a valid UTC date and time." };
  }
  return { input: value, iso: date.toISOString() };
}

export function parseAuditDateTimeRange(
  from: string | undefined,
  until: string | undefined,
) {
  const parsedFrom = parseAuditDateTimeLocal(from);
  const parsedUntil = parseAuditDateTimeLocal(until);
  const rangeError =
    parsedFrom.iso && parsedUntil.iso && parsedFrom.iso > parsedUntil.iso
      ? "From must be earlier than or equal to Until."
      : null;
  return { from: parsedFrom, until: parsedUntil, rangeError };
}
