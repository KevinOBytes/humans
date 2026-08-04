import { Readable } from "node:stream";

import { parse as createCsvParser } from "csv-parse";
import createJsonParser from "stream-json";

import { formulaRisk } from "./mapper";
import type { ImportFormat, ParsedImportRow } from "./types";

const CSV_MAX_BYTES = 25 * 1024 * 1024;
const JSON_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 100;
const MAX_FIELD_CHARACTERS = 20_000;
const MAX_HEADER_CHARACTERS = 128;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type ByteStream = AsyncIterable<Uint8Array | string>;

function invalid(message: string): never {
  throw new TypeError(message);
}

function normalizedHeader(value: string): string {
  const header = value.normalize("NFKC").trim();
  if (
    header.length < 1 ||
    header.length > MAX_HEADER_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(header) ||
    formulaRisk(header)
  ) {
    return invalid("Invalid import header");
  }
  if (BLOCKED_KEYS.has(header)) return invalid("Invalid import key");
  return header;
}

/** NFKC plus Unicode caseless matching for keys controlled by an importer. */
function canonicalImportKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleUpperCase("und")
    .toLocaleLowerCase("und");
}

async function* strictTextChunks(stream: ByteStream, maxBytes: number) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let first = true;
  try {
    for await (const raw of stream) {
      const chunk =
        typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) return invalid("Import exceeds the size limit");
      if (
        first &&
        ((chunk[0] === 0xff && chunk[1] === 0xfe) ||
          (chunk[0] === 0xfe && chunk[1] === 0xff) ||
          (chunk[0] === 0 &&
            chunk[1] === 0 &&
            chunk[2] === 0xfe &&
            chunk[3] === 0xff) ||
          (chunk[0] === 0xff &&
            chunk[1] === 0xfe &&
            chunk[2] === 0 &&
            chunk[3] === 0))
      ) {
        return invalid("UTF-16 and UTF-32 imports are not accepted");
      }
      let text: string;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        return invalid("Import is not valid UTF-8");
      }
      if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
      if (text.includes("\0")) return invalid("NUL is not accepted in imports");
      if (text) yield text;
    }
    let tail: string;
    try {
      tail = decoder.decode();
    } catch {
      return invalid("Import is not valid UTF-8");
    }
    if (tail.includes("\0")) return invalid("NUL is not accepted in imports");
    if (tail) yield tail;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("The import stream could not be read");
  }
}

function rowWarnings(values: Record<string, unknown>): readonly string[] {
  return Object.entries(values)
    .filter(([, value]) => formulaRisk(value))
    .map(([key]) => `FORMULA_RISK:${key}`)
    .slice(0, MAX_COLUMNS);
}

async function parseCsv(input: {
  stream: ByteStream;
  onRow: (row: ParsedImportRow) => Promise<void> | void;
}) {
  const parser = createCsvParser({
    bom: false,
    cast: false,
    columns: false,
    comment: null,
    delimiter: ",",
    max_record_size: 65_536,
    relax_column_count: false,
    relax_quotes: false,
    skip_empty_lines: false,
    trim: false,
  });
  const source = Readable.from(strictTextChunks(input.stream, CSV_MAX_BYTES));
  source.on("error", (error) => parser.destroy(error as Error));
  source.pipe(parser);
  let columns: string[] | null = null;
  let totalRows = 0;
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (!Array.isArray(record)) return invalid("Invalid CSV record");
      if (!columns) {
        if (record.length < 1 || record.length > MAX_COLUMNS) {
          return invalid("CSV must contain 1 to 100 columns");
        }
        columns = record.map(normalizedHeader);
        const folded = columns.map(canonicalImportKey);
        if (new Set(folded).size !== folded.length) {
          return invalid("CSV contains duplicate headers");
        }
        continue;
      }
      if (record.length !== columns.length) {
        return invalid("CSV record column count does not match the header");
      }
      totalRows += 1;
      if (totalRows > MAX_ROWS) return invalid("Import row limit exceeded");
      const values = Object.create(null) as Record<string, string>;
      for (let index = 0; index < columns.length; index += 1) {
        const value = record[index] ?? "";
        if (value.length > MAX_FIELD_CHARACTERS) {
          return invalid("CSV field exceeds the character limit");
        }
        values[columns[index]!] = value;
      }
      await input.onRow({
        rowNumber: totalRows,
        values,
        warnings: rowWarnings(values),
      });
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("CSV is malformed or exceeds a record limit");
  }
  if (!columns) return invalid("CSV is empty");
  return { columns, totalRows };
}

type JsonToken = { name: string; value?: unknown };
type Container =
  | { kind: "array"; value: unknown[] }
  | {
      kind: "object";
      value: Record<string, unknown>;
      keys: Set<string>;
      pendingKey: string | null;
    };

async function parseJson(input: {
  stream: ByteStream;
  onRow: (row: ParsedImportRow) => Promise<void> | void;
}) {
  const parser = createJsonParser({ packKeys: true, packValues: true });
  const source = Readable.from(strictTextChunks(input.stream, JSON_MAX_BYTES));
  source.on("error", (error) => parser.destroy(error as Error));
  source.pipe(parser);
  const stack: Container[] = [];
  const columns: string[] = [];
  const columnSet = new Set<string>();
  let rootStarted = false;
  let rootClosed = false;
  let totalRows = 0;

  const addValue = async (value: unknown) => {
    const parent = stack.at(-1);
    if (!parent) return invalid("JSON must contain one top-level array");
    if (parent.kind === "array") {
      if (stack.length === 1) {
        if (
          value == null ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          return invalid("Every JSON import row must be a plain object");
        }
        totalRows += 1;
        if (totalRows > MAX_ROWS) return invalid("Import row limit exceeded");
        const values = value as ParsedImportRow["values"];
        for (const key of Object.keys(values)) {
          if (!columnSet.has(key)) {
            columnSet.add(key);
            columns.push(key);
          }
        }
        await input.onRow({
          rowNumber: totalRows,
          values,
          warnings: rowWarnings(values),
        });
      } else {
        parent.value.push(value);
      }
      return;
    }
    const key = parent.pendingKey;
    if (!key) return invalid("JSON object value is missing a key");
    parent.value[key] = value;
    parent.pendingKey = null;
  };

  try {
    for await (const token of parser as AsyncIterable<JsonToken>) {
      switch (token.name) {
        case "startArray": {
          if (!rootStarted) {
            rootStarted = true;
            stack.push({ kind: "array", value: [] });
            break;
          }
          if (stack.length >= 10) return invalid("JSON depth limit exceeded");
          stack.push({ kind: "array", value: [] });
          break;
        }
        case "endArray": {
          const ended = stack.pop();
          if (!ended || ended.kind !== "array")
            return invalid("Malformed JSON structure");
          if (stack.length === 0) {
            rootClosed = true;
          } else {
            await addValue(ended.value);
          }
          break;
        }
        case "startObject":
          if (!rootStarted || stack.length === 0)
            return invalid("JSON must contain a top-level array");
          if (stack.length >= 10) return invalid("JSON depth limit exceeded");
          stack.push({
            kind: "object",
            value: Object.create(null),
            keys: new Set(),
            pendingKey: null,
          });
          break;
        case "endObject": {
          const ended = stack.pop();
          if (!ended || ended.kind !== "object" || ended.pendingKey)
            return invalid("Malformed JSON object");
          await addValue(ended.value);
          break;
        }
        case "keyValue": {
          const parent = stack.at(-1);
          if (
            !parent ||
            parent.kind !== "object" ||
            typeof token.value !== "string"
          )
            return invalid("Malformed JSON key");
          const key = normalizedHeader(token.value);
          const folded = canonicalImportKey(key);
          if (parent.keys.has(folded))
            return invalid("JSON contains a duplicate key");
          if (parent.keys.size >= MAX_COLUMNS)
            return invalid("JSON row key limit exceeded");
          parent.keys.add(folded);
          parent.pendingKey = key;
          break;
        }
        case "stringValue": {
          if (
            typeof token.value !== "string" ||
            token.value.length > MAX_FIELD_CHARACTERS
          )
            return invalid("JSON string exceeds the character limit");
          if (token.value.includes("\0"))
            return invalid("NUL is not accepted in imports");
          await addValue(token.value);
          break;
        }
        case "numberValue": {
          const value = Number(token.value);
          if (!Number.isFinite(value))
            return invalid("JSON contains a non-finite number");
          if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
            return invalid("JSON integer exceeds safe numeric precision");
          }
          await addValue(value);
          break;
        }
        case "trueValue":
          await addValue(true);
          break;
        case "falseValue":
          await addValue(false);
          break;
        case "nullValue":
          await addValue(null);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("JSON is malformed or exceeds a limit");
  }
  if (!rootStarted || !rootClosed || stack.length !== 0)
    return invalid("JSON must contain one top-level array");
  return { columns, totalRows };
}

export async function parseImportStream(input: {
  format: ImportFormat;
  stream: ByteStream;
  onRow: (row: ParsedImportRow) => Promise<void> | void;
}): Promise<{ columns: readonly string[]; totalRows: number }> {
  if (input.format === "CSV") return parseCsv(input);
  if (input.format === "JSON") return parseJson(input);
  return invalid("Unsupported import format");
}
