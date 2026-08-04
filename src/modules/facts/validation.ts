import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { fromMarkdown } from "mdast-util-from-markdown";
import sanitizeHtml from "sanitize-html";

export type ValidationIssue = {
  path: string[];
  code: string;
  message: string;
};

export type ValidationResult<T> =
  { value: T; issues: [] } | { value?: undefined; issues: ValidationIssue[] };

const namespacePattern = /^[a-z][a-z0-9_.-]*$/u;
const checksumPattern = /^sha256:[0-9a-f]{64}$/u;
const colorPattern = /^#[0-9A-F]{6}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const rfc3339Pattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function issue(path: string[], code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function normalizeHumanText(
  value: unknown,
  options: {
    path?: string[];
    min?: number;
    max: number;
    allowLineBreaks?: boolean;
  },
): ValidationResult<string> {
  const path = options.path ?? [];
  if (typeof value !== "string") {
    return { issues: [issue(path, "INVALID_TYPE", "A string is required.")] };
  }
  const normalized = value.normalize("NFKC").trim();
  const controls = options.allowLineBreaks
    ? controlPattern
    : /[\u0000-\u001f\u007f]/u;
  const min = options.min ?? 0;
  if (
    normalized.length < min ||
    normalized.length > options.max ||
    controls.test(normalized)
  ) {
    return {
      issues: [
        issue(
          path,
          "INVALID_STRING",
          "The value is outside the allowed bounds.",
        ),
      ],
    };
  }
  return { value: normalized, issues: [] };
}

export function normalizeNamespaceKey(
  value: unknown,
  path: string[] = [],
): ValidationResult<string> {
  const normalized = normalizeHumanText(value, { path, min: 1, max: 64 });
  if (normalized.issues.length > 0) return normalized;
  const canonical = normalized.value!.toLowerCase();
  if (!namespacePattern.test(canonical)) {
    return {
      issues: [
        issue(
          path,
          "INVALID_KEY",
          "Use lowercase letters, numbers, dots, dashes, or underscores.",
        ),
      ],
    };
  }
  return { value: canonical, issues: [] };
}

export function normalizeTagName(
  value: unknown,
  path: string[] = [],
): ValidationResult<string> {
  const normalized = normalizeHumanText(value, { path, min: 1, max: 200 });
  if (normalized.issues.length > 0) return normalized;
  return {
    value: normalized.value!.replace(/\s+/gu, " ").toLowerCase(),
    issues: [],
  };
}

export function validateColor(
  value: unknown,
  path: string[] = [],
): ValidationResult<string | null> {
  if (value == null) return { value: null, issues: [] };
  if (typeof value !== "string") {
    return { issues: [issue(path, "INVALID_COLOR", "Color must be #RRGGBB.")] };
  }
  const normalized = value.trim().toUpperCase();
  return colorPattern.test(normalized)
    ? { value: normalized, issues: [] }
    : { issues: [issue(path, "INVALID_COLOR", "Color must be #RRGGBB.")] };
}

export function validateChecksum(
  value: unknown,
  path: string[] = [],
): ValidationResult<string> {
  return typeof value === "string" && checksumPattern.test(value)
    ? { value, issues: [] }
    : {
        issues: [
          issue(
            path,
            "INVALID_CHECKSUM",
            "Checksum must be a lowercase SHA-256 value.",
          ),
        ],
      };
}

export function validateUuid(
  value: unknown,
  path: string[] = [],
): ValidationResult<string> {
  return typeof value === "string" && uuidPattern.test(value)
    ? { value: value.toLowerCase(), issues: [] }
    : { issues: [issue(path, "INVALID_UUID", "A valid UUID is required.")] };
}

export function validateDecimal(
  value: unknown,
  options: {
    maxPrecision?: number;
    maxScale: number;
    min?: number;
    max?: number;
    path?: string[];
  },
): ValidationResult<string> {
  const path = options.path ?? [];
  if (typeof value !== "string" || !decimalPattern.test(value)) {
    return {
      issues: [
        issue(path, "INVALID_DECIMAL", "A plain decimal string is required."),
      ],
    };
  }
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const [integerPart, fraction = ""] = unsigned.split(".");
  const significantInteger = integerPart.replace(/^0+/u, "") || "0";
  const precision = significantInteger.length + fraction.length;
  if (
    fraction.length > options.maxScale ||
    precision > (options.maxPrecision ?? 38)
  ) {
    return {
      issues: [
        issue(
          path,
          "DECIMAL_BOUNDS",
          "The decimal exceeds precision or scale limits.",
        ),
      ],
    };
  }
  const numeric = Number(value);
  if (
    !Number.isFinite(numeric) ||
    (options.min !== undefined && numeric < options.min) ||
    (options.max !== undefined && numeric > options.max)
  ) {
    return {
      issues: [
        issue(
          path,
          "DECIMAL_RANGE",
          "The decimal is outside the allowed range.",
        ),
      ],
    };
  }
  return { value, issues: [] };
}

export function validateUnitDecimal(
  value: unknown,
  options: { min: number; max: number; path?: string[] },
): ValidationResult<string | null> {
  if (value == null) return { value: null, issues: [] };
  const stringValue = typeof value === "number" ? String(value) : value;
  return validateDecimal(stringValue, {
    maxPrecision: 4,
    maxScale: 3,
    min: options.min,
    max: options.max,
    path: options.path,
  });
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateBoundedJson(
  value: unknown,
  options: { objectOnly?: boolean; path?: string[] } = {},
): ValidationResult<unknown> {
  const path = options.path ?? [];
  let nodes = 0;
  let invalid = false;
  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 1_000 || depth > 10) {
      invalid = true;
      return;
    }
    if (
      node === null ||
      typeof node === "string" ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    ) {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (isPlainJsonObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (controlPattern.test(key)) invalid = true;
        visit(child, depth + 1);
      }
      return;
    }
    invalid = true;
  };
  if (options.objectOnly && !isPlainJsonObject(value)) invalid = true;
  visit(value, 0);
  let encoded = "";
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid = true;
  }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > 65_536) invalid = true;
  return invalid
    ? {
        issues: [
          issue(
            path,
            "INVALID_JSON",
            "JSON exceeds the allowed shape or size.",
          ),
        ],
      }
    : { value: structuredClone(value), issues: [] };
}

export function validateHttpUrl(
  value: unknown,
  path: string[] = [],
): ValidationResult<string | null> {
  if (value == null) return { value: null, issues: [] };
  if (typeof value !== "string" || controlPattern.test(value)) {
    return {
      issues: [
        issue(path, "INVALID_URL", "An absolute HTTP(S) URL is required."),
      ],
    };
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new Error("invalid");
    }
    return { value: url.toString(), issues: [] };
  } catch {
    return {
      issues: [
        issue(path, "INVALID_URL", "An absolute HTTP(S) URL is required."),
      ],
    };
  }
}

function normalizedDate(value: string | Date): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }
  return typeof value === "string" ? value : null;
}

function validDate(value: string | Date): boolean {
  const normalized = normalizedDate(value);
  if (!normalized) return false;
  const match = datePattern.exec(normalized);
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

export type TemporalInput = {
  semantics: string;
  precision: string;
  earliest?: string | Date | null;
  latest?: string | Date | null;
};

export function validateTemporal(input: TemporalInput): ValidationResult<{
  semantics: string;
  precision: string;
  earliest: Date | null;
  latest: Date | null;
}> {
  const semantics = input.semantics.toLowerCase();
  const precision = input.precision.toLowerCase();
  const earliest = input.earliest == null ? null : new Date(input.earliest);
  const latest = input.latest == null ? null : new Date(input.latest);
  const invalidDate =
    (earliest !== null && Number.isNaN(earliest.getTime())) ||
    (latest !== null && Number.isNaN(latest.getTime()));
  let valid =
    !invalidDate &&
    (earliest === null || latest === null || latest >= earliest);
  switch (semantics) {
    case "unknown":
      valid &&= earliest === null && latest === null && precision === "unknown";
      break;
    case "exact":
      valid &&=
        earliest !== null &&
        (latest === null || latest.getTime() === earliest.getTime());
      break;
    case "before":
      valid &&= latest !== null && earliest === null;
      break;
    case "after":
      valid &&= earliest !== null && latest === null;
      break;
    case "between":
      valid &&= earliest !== null && latest !== null && precision === "range";
      break;
    case "approximate":
      valid &&= earliest !== null && latest !== null && precision !== "unknown";
      break;
    case "year_only": {
      valid &&= earliest !== null && latest !== null && precision === "year";
      if (earliest && latest) {
        valid &&=
          earliest.getUTCMonth() === 0 &&
          earliest.getUTCDate() === 1 &&
          earliest.getUTCHours() === 0 &&
          latest.getUTCMonth() === 11 &&
          latest.getUTCDate() === 31 &&
          latest.getUTCHours() === 23 &&
          earliest.getUTCFullYear() === latest.getUTCFullYear();
      }
      break;
    }
    default:
      valid = false;
  }
  return valid
    ? { value: { semantics, precision, earliest, latest }, issues: [] }
    : {
        issues: [
          issue(
            ["temporal"],
            "INVALID_TEMPORAL",
            "Temporal bounds are inconsistent.",
          ),
        ],
      };
}

export type FactValueInput = {
  text?: string | null;
  decimal?: string | null;
  boolean?: boolean | null;
  dateStart?: string | Date | null;
  dateEnd?: string | Date | null;
  timestamp?: string | Date | null;
  json?: unknown;
  referencedPersonId?: string | null;
  placeId?: string | null;
  fileId?: string | null;
  unit?: string | null;
};

export type FactValueColumns = {
  valueText: string | null;
  valueDecimal: string | null;
  valueBoolean: boolean | null;
  valueDateStart: string | null;
  valueDateEnd: string | null;
  valueTimestamp: Date | null;
  valueJson: unknown | null;
  referencedPersonId: string | null;
  placeId: string | null;
  fileId: string | null;
  unit: string | null;
};

const valueKeys: Array<keyof FactValueInput> = [
  "text",
  "decimal",
  "boolean",
  "dateStart",
  "dateEnd",
  "timestamp",
  "json",
  "referencedPersonId",
  "placeId",
  "fileId",
];

export function validateFactValue(
  valueType: string,
  input: FactValueInput,
): ValidationResult<FactValueColumns> {
  const type = valueType.toLowerCase();
  const present = valueKeys.filter(
    (key) => input[key] !== undefined && input[key] !== null,
  );
  const columns: FactValueColumns = {
    valueText: null,
    valueDecimal: null,
    valueBoolean: null,
    valueDateStart: null,
    valueDateEnd: null,
    valueTimestamp: null,
    valueJson: null,
    referencedPersonId: null,
    placeId: null,
    fileId: null,
    unit: null,
  };
  const invalid = () =>
    ({
      issues: [
        issue(
          ["value"],
          "INVALID_FACT_VALUE",
          "The value does not match its definition type.",
        ),
      ],
    }) as ValidationResult<FactValueColumns>;

  if (["text", "rich_text", "uri"].includes(type)) {
    if (present.length !== 1 || present[0] !== "text") return invalid();
    const textValue = normalizeHumanText(input.text, {
      path: ["value", "text"],
      min: 1,
      max: type === "rich_text" ? 20_000 : 4_000,
      allowLineBreaks: type === "rich_text",
    });
    if (textValue.issues.length > 0)
      return textValue as ValidationResult<FactValueColumns>;
    if (type === "uri" && validateHttpUrl(textValue.value).issues.length > 0)
      return invalid();
    columns.valueText = textValue.value!;
  } else if (["integer", "decimal", "duration", "quantity"].includes(type)) {
    if (present.length !== 1 || present[0] !== "decimal") return invalid();
    const decimal = validateDecimal(input.decimal, {
      maxPrecision: 38,
      maxScale: type === "integer" ? 0 : 12,
      path: ["value", "decimal"],
    });
    if (decimal.issues.length > 0)
      return decimal as ValidationResult<FactValueColumns>;
    columns.valueDecimal = decimal.value!;
    if (type === "duration" || type === "quantity") {
      const unit = normalizeHumanText(input.unit, {
        path: ["value", "unit"],
        min: 1,
        max: 64,
      });
      if (unit.issues.length > 0)
        return unit as ValidationResult<FactValueColumns>;
      columns.unit = unit.value!;
    } else if (input.unit != null) return invalid();
  } else if (type === "boolean") {
    if (present.length !== 1 || present[0] !== "boolean") return invalid();
    columns.valueBoolean = input.boolean ?? null;
  } else if (type === "date" || type === "date_range") {
    const required = type === "date" ? ["dateStart"] : ["dateStart", "dateEnd"];
    if (
      present.length !== required.length ||
      !required.every((key) => present.includes(key as never))
    )
      return invalid();
    if (!input.dateStart || !validDate(input.dateStart)) return invalid();
    const start = normalizedDate(input.dateStart)!;
    const end = input.dateEnd ? normalizedDate(input.dateEnd) : null;
    if (
      type === "date_range" &&
      (!end || !validDate(input.dateEnd!) || end < start)
    )
      return invalid();
    columns.valueDateStart = start;
    columns.valueDateEnd = type === "date_range" ? end : null;
  } else if (type === "timestamp") {
    if (present.length !== 1 || present[0] !== "timestamp" || !input.timestamp)
      return invalid();
    if (
      typeof input.timestamp === "string" &&
      !rfc3339Pattern.test(input.timestamp)
    )
      return invalid();
    const timestamp = new Date(input.timestamp);
    if (Number.isNaN(timestamp.getTime())) return invalid();
    columns.valueTimestamp = timestamp;
  } else if (type === "json") {
    if (present.length !== 1 || present[0] !== "json") return invalid();
    const json = validateBoundedJson(input.json, { path: ["value", "json"] });
    if (json.issues.length > 0)
      return json as ValidationResult<FactValueColumns>;
    columns.valueJson = json.value;
  } else {
    const referenceKey = {
      person_reference: "referencedPersonId",
      place_reference: "placeId",
      file_reference: "fileId",
    }[type] as "referencedPersonId" | "placeId" | "fileId" | undefined;
    if (!referenceKey || present.length !== 1 || present[0] !== referenceKey)
      return invalid();
    const reference = validateUuid(input[referenceKey]);
    if (reference.issues.length > 0) return invalid();
    columns[referenceKey] = reference.value!;
  }
  return { value: columns, issues: [] };
}

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: true,
});
addFormats(ajv);
const validatorCache = new Map<string, ValidateFunction>();

export function validateJsonSchema(
  cacheKey: string,
  schema: unknown,
  value: unknown,
): ValidationResult<unknown> {
  const boundedSchema = validateBoundedJson(schema, { objectOnly: true });
  if (boundedSchema.issues.length > 0) {
    return {
      issues: [
        issue([], "INVALID_STORED_SCHEMA", "The stored schema is not usable."),
      ],
    };
  }
  let validator = validatorCache.get(cacheKey);
  try {
    validator ??= ajv.compile(boundedSchema.value as object);
    validatorCache.set(cacheKey, validator);
  } catch {
    return {
      issues: [
        issue([], "INVALID_STORED_SCHEMA", "The stored schema is not usable."),
      ],
    };
  }
  if (validator(value)) return { value, issues: [] };
  const errors = structuredClone(
    (validator.errors ?? []).slice(0, 20),
  ) as ErrorObject[];
  return {
    issues: errors.map((error) =>
      issue(
        error.instancePath.split("/").filter(Boolean).slice(0, 10),
        "SCHEMA_VALIDATION",
        "The value does not satisfy the definition schema.",
      ),
    ),
  };
}

export function canonicalizeRelationshipEndpoints(
  sourceId: string,
  targetId: string,
  directed: boolean,
): [string, string] {
  const source = sourceId.toLowerCase();
  const target = targetId.toLowerCase();
  return directed || source <= target ? [source, target] : [target, source];
}

function decodeMarkdownDestination(value: string): string | null {
  let decoded = value.trim().replace(/^<|>$/gu, "").normalize("NFKC");
  const maxPasses = decoded.length + 1;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const entities = decoded.replace(
      /&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);?/giu,
      (match, reference: string) =>
        decodeNamedCharacterReference(reference) || match,
    );
    let canonical = entities.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    canonical = canonical.normalize("NFKC");
    if (canonical === decoded) return canonical;
    decoded = canonical;
  }
  return null;
}

function safeMarkdownDestination(value: string): boolean {
  const decoded = decodeMarkdownDestination(value);
  if (decoded == null) return false;
  const compact = decoded.replace(/[\p{White_Space}\p{Cc}\p{Cf}\\]/gu, "");
  if (!compact) return false;
  if (compact.startsWith("//")) return false;
  if (
    compact.startsWith("/") ||
    compact.startsWith("./") ||
    compact.startsWith("../") ||
    compact.startsWith("#") ||
    compact.startsWith("?")
  )
    return true;
  const colon = compact.indexOf(":");
  if (colon === -1) return true;
  const scheme = compact.slice(0, colon).toLowerCase();
  return /^(?:http|https|mailto)$/u.test(scheme);
}

function markdownAnalysis(markdown: string): {
  destinations: string[];
  literalRanges: Array<{ start: number; end: number }>;
} {
  const destinations: string[] = [];
  const literalRanges: Array<{ start: number; end: number }> = [];
  type MarkdownNode = {
    children?: MarkdownNode[];
    position?: { start?: { offset?: number }; end?: { offset?: number } };
    type?: string;
    url?: unknown;
  };
  const visit = (node: MarkdownNode): void => {
    if (
      (node.type === "definition" ||
        node.type === "image" ||
        node.type === "link") &&
      typeof node.url === "string"
    )
      destinations.push(node.url);
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number")
        literalRanges.push({ start, end });
    }
    for (const child of node.children ?? []) visit(child);
  };
  try {
    visit(fromMarkdown(markdown) as MarkdownNode);
  } catch {
    return { destinations: ["unsafe:unparseable"], literalRanges: [] };
  }
  return { destinations, literalRanges };
}

function hasUnsafeMalformedMarkdownDestination(
  markdown: string,
  literalRanges: readonly { start: number; end: number }[],
): boolean {
  for (let start = markdown.indexOf("]("); start !== -1;) {
    const opener = markdown.lastIndexOf("[", start);
    if (opener >= 0) {
      let escapes = 0;
      for (
        let index = opener - 1;
        index >= 0 && markdown[index] === "\\";
        index -= 1
      )
        escapes += 1;
      if (escapes % 2 === 1) {
        start = markdown.indexOf("](", start + 2);
        continue;
      }
    }
    if (
      literalRanges.some((range) => start >= range.start && start < range.end)
    ) {
      start = markdown.indexOf("](", start + 2);
      continue;
    }
    const candidate = markdown.slice(start + 2, start + 4_098);
    const decoded = decodeMarkdownDestination(candidate);
    if (decoded === null) return true;
    const compact = decoded.replace(/[\p{Cc}\p{Cf}\p{Z}]/gu, "");
    if (
      /^(?:<)?(?:javascript|data|vbscript|file):/iu.test(compact) ||
      /^(?:<)?\/\//u.test(compact)
    )
      return true;
    start = markdown.indexOf("](", start + 2);
  }
  return false;
}

export function validateNoteContent(input: {
  plainText?: unknown;
  markdown?: unknown;
}): ValidationResult<{
  plainText: string | null;
  sanitizedMarkdown: string | null;
}> {
  const hasPlain = input.plainText !== undefined && input.plainText !== null;
  const hasMarkdown = input.markdown !== undefined && input.markdown !== null;
  if (hasPlain === hasMarkdown) {
    return {
      issues: [
        issue(["content"], "ONE_OF", "Provide exactly one note content form."),
      ],
    };
  }
  if (hasPlain) {
    const plain = normalizeHumanText(input.plainText, {
      path: ["plainText"],
      min: 1,
      max: 20_000,
      allowLineBreaks: true,
    });
    return plain.issues.length > 0
      ? (plain as ValidationResult<{
          plainText: string | null;
          sanitizedMarkdown: string | null;
        }>)
      : {
          value: { plainText: plain.value!, sanitizedMarkdown: null },
          issues: [],
        };
  }
  if (typeof input.markdown !== "string") {
    return {
      issues: [
        issue(["markdown"], "INVALID_TYPE", "Markdown must be a string."),
      ],
    };
  }
  const markdown = markdownAnalysis(input.markdown);
  if (
    markdown.destinations.some(
      (destination) => !safeMarkdownDestination(destination),
    ) ||
    hasUnsafeMalformedMarkdownDestination(
      input.markdown,
      markdown.literalRanges,
    )
  ) {
    return {
      issues: [
        issue(
          ["markdown"],
          "UNSAFE_MARKDOWN_DESTINATION",
          "Markdown links and images must use a safe destination.",
        ),
      ],
    };
  }
  const sanitized = sanitizeHtml(input.markdown.normalize("NFKC"), {
    allowedAttributes: {},
    allowedSchemes: ["http", "https", "mailto"],
    allowedTags: [],
  }).trim();
  const checked = normalizeHumanText(sanitized, {
    path: ["markdown"],
    min: 1,
    max: 20_000,
    allowLineBreaks: true,
  });
  return checked.issues.length > 0
    ? (checked as ValidationResult<{
        plainText: string | null;
        sanitizedMarkdown: string | null;
      }>)
    : {
        value: { plainText: null, sanitizedMarkdown: checked.value! },
        issues: [],
      };
}
