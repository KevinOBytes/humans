import type { FactSummaryFragment } from "@/graphql/generated/graphql";

function displayDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toISOString().slice(0, 10);
}

export function factDisplayValue(value: FactSummaryFragment["value"]) {
  if (!value) return "No value recorded";
  if (value.text !== null) return value.text;
  if (value.dateStart !== null) {
    const start = displayDate(value.dateStart);
    const end = value.dateEnd ? displayDate(value.dateEnd) : null;
    return end && end !== start ? `${start} – ${end}` : start;
  }
  if (value.timestamp !== null) return value.timestamp;
  if (value.decimal !== null) {
    return `${value.decimal}${value.unit ? ` ${value.unit}` : ""}`;
  }
  if (value.boolean !== null) return value.boolean ? "True" : "False";
  if (value.referencedPersonId) return "Referenced person";
  if (value.placeId) return "Referenced place";
  if (value.fileId) return "Referenced file";
  if (value.json !== null && value.json !== undefined) {
    return JSON.stringify(value.json);
  }
  return "No value recorded";
}
