import type {
  FactValueInput,
  FactValueType,
} from "@/graphql/generated/graphql";

export type FactDraft = {
  unit?: string;
  value: string;
  valueEnd?: string;
};

export type ParsedFactDraft =
  | { value: FactValueInput }
  | { error: string; field: "unit" | "value" | "valueEnd" };

const supportedTypes = new Set<FactValueType>([
  "BOOLEAN",
  "DATE",
  "DATE_RANGE",
  "DECIMAL",
  "DURATION",
  "INTEGER",
  "JSON",
  "QUANTITY",
  "RICH_TEXT",
  "TEXT",
  "TIMESTAMP",
  "URI",
]);
const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function supportedFactValueType(valueType: FactValueType): boolean {
  return supportedTypes.has(valueType);
}

function validDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseFactDraft(
  valueType: FactValueType,
  draft: FactDraft,
): ParsedFactDraft {
  const value = draft.value.trim();
  if (!supportedFactValueType(valueType)) {
    return {
      error: "This fact type is not supported by the safe editor.",
      field: "value",
    };
  }

  switch (valueType) {
    case "BOOLEAN":
      return value === "true" || value === "false"
        ? { value: { boolean: value === "true" } }
        : { error: "Choose true or false.", field: "value" };
    case "DATE":
      return validDate(value)
        ? { value: { dateStart: value } }
        : { error: "Choose a valid date.", field: "value" };
    case "DATE_RANGE": {
      const end = draft.valueEnd?.trim() ?? "";
      if (!validDate(value))
        return { error: "Choose a valid start date.", field: "value" };
      if (!end) return { error: "Choose an end date.", field: "valueEnd" };
      if (!validDate(end) || end < value)
        return {
          error: "Choose an end date on or after the start date.",
          field: "valueEnd",
        };
      return { value: { dateStart: value, dateEnd: end } };
    }
    case "DECIMAL":
    case "INTEGER": {
      const valid =
        decimalPattern.test(value) &&
        (valueType !== "INTEGER" || !value.includes("."));
      return valid
        ? { value: { decimal: value } }
        : {
            error:
              valueType === "INTEGER"
                ? "Enter a whole number."
                : "Enter a plain decimal number.",
            field: "value",
          };
    }
    case "DURATION":
    case "QUANTITY": {
      if (!decimalPattern.test(value))
        return { error: "Enter a plain decimal number.", field: "value" };
      const unit = draft.unit?.trim() ?? "";
      return unit
        ? { value: { decimal: value, unit } }
        : { error: "Enter a unit.", field: "unit" };
    }
    case "JSON":
      try {
        return { value: { json: JSON.parse(draft.value) as unknown } };
      } catch {
        return { error: "Enter valid JSON.", field: "value" };
      }
    case "TIMESTAMP": {
      const timestamp = new Date(value);
      return Number.isNaN(timestamp.getTime())
        ? { error: "Choose a valid date and time.", field: "value" }
        : { value: { timestamp: timestamp.toISOString() } };
    }
    case "URI":
      try {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new Error("invalid");
        }
        return { value: { text: url.toString() } };
      } catch {
        return {
          error: "Enter an absolute HTTP or HTTPS URL without credentials.",
          field: "value",
        };
      }
    case "RICH_TEXT":
    case "TEXT":
      return value
        ? { value: { text: draft.value } }
        : { error: "Enter a value.", field: "value" };
    default:
      return {
        error: "This fact type is not supported by the safe editor.",
        field: "value",
      };
  }
}
