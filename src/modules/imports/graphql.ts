import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import type { JobRow } from "@/modules/jobs/repository";
import { PageInfo, ValidationIssue } from "@/modules/people/graphql";
import type { PageInfo as PageInfoShape } from "@/modules/people/service";

import type {
  ImportMappingRow,
  ImportRow,
  ImportStagedRow,
} from "./repository";

const ImportFormat = builder.enumType("ImportFormat", {
  values: ["CSV", "JSON"] as const,
});
const ImportMode = builder.enumType("ImportMode", {
  values: ["COMMIT", "DRY_RUN"] as const,
});
const ImportState = builder.enumType("ImportState", {
  values: {
    STAGING: { value: "staging" },
    PREVIEW_READY: { value: "preview_ready" },
    QUEUED: { value: "queued" },
    RUNNING: { value: "running" },
    COMPLETED: { value: "completed" },
    COMPLETED_WITH_ERRORS: { value: "completed_with_errors" },
    FAILED: { value: "failed" },
    DEAD_LETTER: { value: "dead_letter" },
  } as const,
});

function storedMappingId(row: ImportRow): string | null {
  if (
    !row.mapping ||
    typeof row.mapping !== "object" ||
    Array.isArray(row.mapping)
  )
    return null;
  const value = (row.mapping as Record<string, unknown>).mappingId;
  return typeof value === "string" ? value : null;
}

export const ImportMappingType = builder
  .objectRef<ImportMappingRow>("ImportMapping")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      name: t.exposeString("name"),
      format: t.field({
        type: ImportFormat,
        resolve: (row) => row.format as "CSV" | "JSON",
      }),
      definition: t.field({
        type: "JSON",
        resolve: (row) => row.columnMapping,
      }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (row) => row.updatedAt.toISOString(),
      }),
    }),
  });

export const ImportRecord = builder.objectRef<ImportRow>("Import").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    fileId: t.expose("fileId", { type: "UUID" }),
    format: t.field({
      type: ImportFormat,
      resolve: (row) => row.format as "CSV" | "JSON",
    }),
    state: t.field({
      type: ImportState,
      resolve: (row) =>
        row.state as
          | "staging"
          | "preview_ready"
          | "queued"
          | "running"
          | "completed"
          | "completed_with_errors"
          | "failed"
          | "dead_letter",
    }),
    mappingId: t.field({
      type: "UUID",
      nullable: true,
      resolve: storedMappingId,
    }),
    totalRows: t.exposeInt("totalRows"),
    acceptedRows: t.exposeInt("acceptedRows"),
    rejectedRows: t.exposeInt("rejectedRows"),
    startedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.startedAt?.toISOString() ?? null,
    }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.completedAt?.toISOString() ?? null,
    }),
    version: t.exposeInt("version"),
    createdAt: t.field({
      type: "DateTime",
      resolve: (row) => row.createdAt.toISOString(),
    }),
    updatedAt: t.field({
      type: "DateTime",
      resolve: (row) => row.updatedAt.toISOString(),
    }),
  }),
});

const Job = builder.objectRef<JobRow>("Job").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    kind: t.exposeString("kind"),
    state: t.exposeString("state"),
    attemptCount: t.exposeInt("attemptCount"),
    scheduledAt: t.field({
      type: "DateTime",
      resolve: (row) => row.scheduledAt.toISOString(),
    }),
    errorCode: t.exposeString("errorCode", { nullable: true }),
  }),
});

type PreviewIssue = { code?: unknown; message?: unknown };
type PreviewRow = {
  rowNumber: number;
  normalizedPayload: unknown;
  issues: readonly unknown[];
  state: string;
};
const ImportPreviewIssue = builder
  .objectRef<PreviewIssue>("ImportPreviewIssue")
  .implement({
    fields: (t) => ({
      code: t.string({
        resolve: (issue) =>
          typeof issue.code === "string" ? issue.code : "ROW_WARNING",
      }),
      message: t.string({
        resolve: (issue) =>
          typeof issue.message === "string"
            ? issue.message
            : "The row needs attention.",
      }),
    }),
  });
const ImportPreviewRow = builder
  .objectRef<PreviewRow>("ImportPreviewRow")
  .implement({
    fields: (t) => ({
      rowNumber: t.exposeInt("rowNumber"),
      normalizedPayload: t.field({
        type: "JSON",
        resolve: (row) => row.normalizedPayload,
      }),
      issues: t.field({
        type: [ImportPreviewIssue],
        resolve: (row) => row.issues as PreviewIssue[],
      }),
      state: t.exposeString("state"),
    }),
  });

const ImportRowDiagnostic = builder
  .objectRef<ImportStagedRow>("ImportRowDiagnostic")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      rowNumber: t.exposeInt("rowNumber"),
      state: t.exposeString("state"),
      normalizedPayload: t.field({
        type: "JSON",
        resolve: (row) => row.normalizedPayload,
      }),
      issues: t.field({
        type: [ImportPreviewIssue],
        resolve: (row) => row.validationErrors as PreviewIssue[],
      }),
      resultReferences: t.field({
        type: ["UUID"],
        resolve: (row) =>
          Array.isArray(row.resultReferences)
            ? row.resultReferences.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
      }),
    }),
  });

const ImportConnection = builder
  .objectRef<{ nodes: ImportRow[]; pageInfo: PageInfoShape }>(
    "ImportConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [ImportRecord],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const ImportMappingConnection = builder
  .objectRef<{ nodes: ImportMappingRow[]; pageInfo: PageInfoShape }>(
    "ImportMappingConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [ImportMappingType],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const ImportRowConnection = builder
  .objectRef<{ nodes: ImportStagedRow[]; pageInfo: PageInfoShape }>(
    "ImportRowConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [ImportRowDiagnostic],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const SaveImportMappingInput = builder.inputType("SaveImportMappingInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID" }),
    expectedVersion: t.int(),
    name: t.string({ required: true }),
    format: t.field({ type: ImportFormat, required: true }),
    definition: t.field({ type: "JSON", required: true }),
  }),
});
const PrepareImportInput = builder.inputType("PrepareImportInput", {
  fields: (t) => ({
    fileId: t.field({ type: "UUID", required: true }),
    mappingId: t.field({ type: "UUID", required: true }),
    idempotencyKey: t.string({ required: true }),
    mode: t.field({ type: ImportMode }),
  }),
});
const ImportFilterInput = builder.inputType("ImportFilterInput", {
  fields: (t) => ({ state: t.field({ type: ImportState }) }),
});

type Issues = readonly { code: string; message: string; path: string[] }[];
const ImportMappingPayload = builder
  .objectRef<{ mapping: ImportMappingRow; issues: Issues }>(
    "ImportMappingPayload",
  )
  .implement({
    fields: (t) => ({
      mapping: t.expose("mapping", { type: ImportMappingType }),
      issues: t.field({
        type: [ValidationIssue],
        resolve: (payload) => [...payload.issues],
      }),
    }),
  });
const ImportPreparePayload = builder
  .objectRef<{ import: ImportRow; preview: PreviewRow[]; issues: Issues }>(
    "ImportPreparePayload",
  )
  .implement({
    fields: (t) => ({
      import: t.expose("import", { type: ImportRecord }),
      preview: t.expose("preview", { type: [ImportPreviewRow] }),
      issues: t.field({
        type: [ValidationIssue],
        resolve: (payload) => [...payload.issues],
      }),
    }),
  });
const ImportStartPayload = builder
  .objectRef<{ import: ImportRow; job: JobRow; issues: Issues }>(
    "ImportStartPayload",
  )
  .implement({
    fields: (t) => ({
      import: t.expose("import", { type: ImportRecord }),
      job: t.expose("job", { type: Job }),
      issues: t.field({
        type: [ValidationIssue],
        resolve: (payload) => [...payload.issues],
      }),
    }),
  });

export function registerImportsGraphQL(): void {
  builder.queryFields((t) => ({
    imports: t.field({
      type: ImportConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: ImportFilterInput }),
      },
      complexity: (args) => ({ field: 2, multiplier: args.first ?? 25 }),
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "read");
        return context.services.imports.list({
          first: args.first,
          after: args.after,
          state: args.filter?.state,
        });
      },
    }),
    import: t.field({
      type: ImportRecord,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "read");
        return context.loaders.import.load(args.id);
      },
    }),
    importMappings: t.field({
      type: ImportMappingConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: args.first ?? 25 }),
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "read");
        return context.services.imports.listMappings(args);
      },
    }),
    importRows: t.field({
      type: ImportRowConnection,
      args: {
        importId: t.arg({ type: "UUID", required: true }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => ({ field: 2, multiplier: args.first ?? 25 }),
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "read");
        return context.services.imports.listRows(args);
      },
    }),
  }));

  builder.mutationFields((t) => ({
    saveImportMapping: t.field({
      type: ImportMappingPayload,
      args: { input: t.arg({ type: SaveImportMappingInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(
          context,
          "import",
          args.input.id ? "update" : "create",
        );
        return context.services.imports.saveMapping({
          ...args.input,
          definition: args.input.definition,
        });
      },
    }),
    prepareImport: t.field({
      type: ImportPreparePayload,
      args: { input: t.arg({ type: PrepareImportInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "create");
        return context.services.imports.prepareImport(args.input);
      },
    }),
    startImport: t.field({
      type: ImportStartPayload,
      args: {
        importId: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        idempotencyKey: t.arg.string({ required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "run");
        return context.services.imports.startImport(args);
      },
    }),
    retryImport: t.field({
      type: ImportStartPayload,
      args: {
        importId: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        idempotencyKey: t.arg.string({ required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "import", "run");
        return context.services.imports.retryImport(args);
      },
    }),
  }));
}
