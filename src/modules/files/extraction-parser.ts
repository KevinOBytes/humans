import { JobExecutionError } from "@/modules/jobs/types";

const MAX_JSON_DEPTH = 32;
const MAX_JSON_KEYS_PER_OBJECT = 256;
const MAX_JSON_ITEMS_PER_ARRAY = 10_000;
const MAX_CSV_ROWS = 10_000;
const MAX_CSV_COLUMNS = 256;

export type ParsedExtraction = Readonly<{
  text: string;
  bytes: number;
  contentType: string;
  json?: unknown;
  rows?: readonly (readonly string[])[];
}>;

function malformed(): never {
  throw new JobExecutionError("extraction_malformed_input", "permanent");
}

function validateJsonShape(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return malformed();
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ITEMS_PER_ARRAY) return malformed();
    return value.map((item) => validateJsonShape(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_KEYS_PER_OBJECT) return malformed();
    return Object.fromEntries(
      entries.map(([key, item]) => [key, validateJsonShape(item, depth + 1)]),
    );
  }
  return value;
}

export function parseCsv(input: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;

  const pushField = () => {
    if (row.length >= MAX_CSV_COLUMNS) return malformed();
    row.push(field);
    field = "";
    atFieldStart = true;
  };
  const pushRow = () => {
    pushField();
    if (rows.length >= MAX_CSV_ROWS) return malformed();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (character === ",") {
      pushField();
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    field += character;
    atFieldStart = false;
  }
  if (quoted) return malformed();
  if (field.length > 0 || row.length > 0 || input.endsWith(",")) pushRow();
  return rows;
}

export function parseExtractionContent(input: {
  contentType: string;
  extractor: string;
  text: string;
  bytes: number;
}): ParsedExtraction {
  const contentType = input.contentType.trim().toLowerCase();
  const extractor = input.extractor.trim().toLowerCase();
  if (
    extractor === "json" ||
    contentType.includes("json") ||
    contentType.endsWith("+json")
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.text) as unknown;
    } catch {
      return malformed();
    }
    return {
      bytes: input.bytes,
      contentType,
      json: validateJsonShape(parsed),
      text: input.text,
    };
  }
  if (extractor === "csv" || contentType === "text/csv") {
    return {
      bytes: input.bytes,
      contentType,
      rows: parseCsv(input.text),
      text: input.text,
    };
  }
  return { bytes: input.bytes, contentType, text: input.text };
}
