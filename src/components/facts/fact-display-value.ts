import type { FactSummaryFragment } from "@/graphql/generated/graphql";

export function factDisplayValue(value: FactSummaryFragment["value"]) {
  if (!value) return "No value recorded";
  if (value.text !== null) return value.text;
  if (value.dateStart !== null) {
    return value.dateEnd && value.dateEnd !== value.dateStart
      ? `${value.dateStart} – ${value.dateEnd}`
      : value.dateStart;
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
