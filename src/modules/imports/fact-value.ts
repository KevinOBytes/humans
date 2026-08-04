import { z } from "zod";

import type { FactValueInput } from "@/modules/facts/validation";

import type { ImportValue } from "./types";

const dateRange = z
  .object({ dateStart: z.string(), dateEnd: z.string() })
  .strict();
const measured = z
  .object({
    decimal: z.union([z.string(), z.number()]),
    unit: z.string(),
  })
  .strict();

function text(value: ImportValue): string {
  if (typeof value !== "string")
    throw new TypeError("Expected text fact value");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new TypeError("Expected non-empty fact value");
  return normalized;
}

function decimal(value: string | number, integer = false): string {
  const normalized =
    typeof value === "string" ? value.normalize("NFKC").trim() : String(value);
  if (
    !normalized ||
    (integer && typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new TypeError("Expected a safe numeric fact value");
  }
  return normalized;
}

function composite(value: ImportValue): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Expected a JSON-encoded fact value");
  }
}

export function importFactValue(
  valueType: string,
  raw: ImportValue,
): FactValueInput {
  switch (valueType) {
    case "text":
    case "rich_text":
    case "uri":
      return { text: text(raw) };
    case "integer":
      if (typeof raw !== "string" && typeof raw !== "number")
        throw new TypeError("Expected an integer fact value");
      return { decimal: decimal(raw, true) };
    case "decimal":
      if (typeof raw !== "string" && typeof raw !== "number")
        throw new TypeError("Expected a decimal fact value");
      return { decimal: decimal(raw) };
    case "boolean": {
      if (typeof raw === "boolean") return { boolean: raw };
      const normalized = text(raw).toLocaleLowerCase("und");
      if (normalized === "true") return { boolean: true };
      if (normalized === "false") return { boolean: false };
      throw new TypeError("Expected a boolean fact value");
    }
    case "date":
      return { dateStart: text(raw) };
    case "date_range": {
      const parsed = dateRange.safeParse(composite(raw));
      if (!parsed.success)
        throw new TypeError("Expected a date range fact value");
      return parsed.data;
    }
    case "timestamp":
      return { timestamp: text(raw) };
    case "duration":
    case "quantity": {
      const parsed = measured.safeParse(composite(raw));
      if (!parsed.success)
        throw new TypeError("Expected a measured fact value");
      return {
        decimal: decimal(parsed.data.decimal),
        unit: text(parsed.data.unit),
      };
    }
    case "json":
      return { json: composite(raw) };
    case "person_reference":
      return { referencedPersonId: text(raw) };
    case "place_reference":
      return { placeId: text(raw) };
    case "file_reference":
      return { fileId: text(raw) };
    default:
      throw new TypeError("Unsupported fact definition type");
  }
}
