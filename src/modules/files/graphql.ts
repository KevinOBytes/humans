import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import type { SignedObjectRequest } from "@/lib/storage/types";
import { ActorAttribution } from "@/modules/audit/attribution-graphql";
import {
  PageInfo,
  Sensitivity,
  ValidationIssue,
} from "@/modules/people/graphql";
import type { PageInfo as PageInfoShape } from "@/modules/people/service";

import type { FileRow, FileVariantRow, UploadSessionRow } from "./repository";
import type { InferSelectModel } from "drizzle-orm";
import { extractionRuns } from "@/db/schema/files";

const UploadPurpose = builder.enumType("UploadPurpose", {
  values: ["EVIDENCE", "CSV_IMPORT", "JSON_IMPORT"] as const,
});
const UploadSessionState = builder.enumType("UploadSessionState", {
  values: {
    PENDING: { value: "pending" },
    VERIFYING: { value: "verifying" },
    COMPLETED: { value: "completed" },
    REJECTED: { value: "rejected" },
    EXPIRED: { value: "expired" },
    CLEANUP_PENDING: { value: "cleanup_pending" },
  } as const,
});
const FileAvailability = builder.enumType("FileAvailability", {
  values: {
    QUARANTINED: { value: "quarantined" },
    AVAILABLE: { value: "available" },
    REJECTED: { value: "rejected" },
  } as const,
});
const FileScanState = builder.enumType("FileScanState", {
  values: {
    PENDING: { value: "pending" },
    CLEAN: { value: "clean" },
    NOT_REQUIRED: { value: "not_required" },
    INFECTED: { value: "infected" },
    ERROR: { value: "error" },
  } as const,
});
const GrantMethod = builder.enumType("FileGrantMethod", {
  values: ["GET", "PUT"] as const,
});
const ExtractionRunState = builder.enumType("ExtractionRunState", {
  values: ["PENDING", "PROCESSING", "COMPLETED", "ERROR"] as const,
});
type ExtractionRunRow = InferSelectModel<typeof extractionRuns>;
const ExtractionRun = builder
  .objectRef<ExtractionRunRow>("ExtractionRun")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      fileId: t.expose("fileId", { type: "UUID" }),
      extractor: t.exposeString("extractor"),
      extractorVersion: t.exposeString("extractorVersion"),
      state: t.field({
        type: ExtractionRunState,
        resolve: (row) =>
          row.state.toUpperCase() as
            "PENDING" | "PROCESSING" | "COMPLETED" | "ERROR",
      }),
      structuredOutput: t.field({
        type: "JSON",
        nullable: true,
        resolve: (row) => row.structuredOutput,
      }),
      errorSummary: t.field({
        type: "JSON",
        nullable: true,
        resolve: (row) => row.errorSummary,
      }),
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
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
    }),
  });

const FileVariant = builder.objectRef<FileVariantRow>("FileVariant").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    kind: t.exposeString("kind"),
    mediaType: t.exposeString("mediaType", { nullable: true }),
    byteSize: t.float({
      nullable: true,
      resolve: (row) => row.byteSize,
    }),
    checksum: t.exposeString("checksum"),
    generatorVersion: t.exposeString("generatorVersion", {
      nullable: true,
    }),
    createdAt: t.field({
      type: "DateTime",
      resolve: (row) => row.createdAt.toISOString(),
    }),
  }),
});

export const File = builder.objectRef<FileRow>("File").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    originalName: t.exposeString("originalName"),
    mediaType: t.exposeString("mediaType", { nullable: true }),
    detectedType: t.exposeString("detectedType", { nullable: true }),
    byteSize: t.float({ resolve: (row) => row.byteSize }),
    availability: t.field({
      type: FileAvailability,
      resolve: (row) =>
        row.quarantineState as "available" | "quarantined" | "rejected",
    }),
    scanState: t.field({
      type: FileScanState,
      resolve: (row) =>
        row.scanState as
          "pending" | "clean" | "not_required" | "infected" | "error",
    }),
    sensitivity: t.field({
      type: Sensitivity,
      resolve: (row) => row.sensitivity,
    }),
    version: t.exposeInt("version"),
    archivedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.deletedAt?.toISOString() ?? null,
    }),
    createdAt: t.field({
      type: "DateTime",
      resolve: (row) => row.createdAt.toISOString(),
    }),
    updatedAt: t.field({
      type: "DateTime",
      resolve: (row) => row.updatedAt.toISOString(),
    }),
    uploadedBy: t.field({
      type: ActorAttribution,
      resolve: (row, _args, context) =>
        context.loaders.actorAttribution.load(`u:${row.uploadedBy}`),
    }),
    variants: t.field({
      type: [FileVariant],
      resolve: (row, _args, context) =>
        context.services.files.listVariants(row),
    }),
  }),
});

const UploadSession = builder
  .objectRef<UploadSessionRow>("UploadSession")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      originalName: t.exposeString("originalName"),
      byteSize: t.float({ resolve: (row) => row.maxBytes }),
      checksumSha256: t.exposeString("expectedChecksum", { nullable: true }),
      state: t.field({
        type: UploadSessionState,
        resolve: (row) =>
          row.state as
            | "pending"
            | "verifying"
            | "completed"
            | "rejected"
            | "expired"
            | "cleanup_pending",
      }),
      expiresAt: t.field({
        type: "DateTime",
        resolve: (row) => row.expiresAt.toISOString(),
      }),
      completedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.completedAt?.toISOString() ?? null,
      }),
      file: t.field({
        type: File,
        nullable: true,
        resolve: (row, _args, context) =>
          row.fileId ? context.loaders.file.load(row.fileId) : null,
      }),
    }),
  });

const FileGrant = builder
  .objectRef<SignedObjectRequest>("FileGrant")
  .implement({
    fields: (t) => ({
      method: t.field({ type: GrantMethod, resolve: (grant) => grant.method }),
      url: t.exposeString("url"),
      expiresAt: t.field({
        type: "DateTime",
        resolve: (grant) => grant.expiresAt.toISOString(),
      }),
      headers: t.field({ type: "JSON", resolve: (grant) => grant.headers }),
      contentLength: t.int({
        nullable: true,
        resolve: (grant) => grant.contentLength ?? null,
      }),
    }),
  });

const CreateUploadSessionInput = builder.inputType("CreateUploadSessionInput", {
  fields: (t) => ({
    originalName: t.string({ required: true }),
    claimedMediaType: t.string({ required: true }),
    byteSize: t.int({ required: true }),
    checksumSha256: t.string({ required: true }),
    purpose: t.field({ type: UploadPurpose, required: true }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});

const FileFilterInput = builder.inputType("FileFilterInput", {
  fields: (t) => ({ availability: t.field({ type: FileAvailability }) }),
});

const FileConnection = builder
  .objectRef<{ nodes: FileRow[]; pageInfo: PageInfoShape }>("FileConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [File],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const UploadSessionConnection = builder
  .objectRef<{ nodes: UploadSessionRow[]; pageInfo: PageInfoShape }>(
    "UploadSessionConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [UploadSession],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

type FileIssues = readonly { code: string; message: string; path: string[] }[];
const UploadPayload = builder
  .objectRef<{
    session: UploadSessionRow;
    file?: FileRow;
    grant?: SignedObjectRequest;
    issues: FileIssues;
  }>("UploadPayload")
  .implement({
    fields: (t) => ({
      session: t.expose("session", { type: UploadSession }),
      file: t.expose("file", { type: File, nullable: true }),
      grant: t.expose("grant", { type: FileGrant, nullable: true }),
      issues: t.field({
        type: [ValidationIssue],
        resolve: (payload) => [...payload.issues],
      }),
    }),
  });
const FileDownloadPayload = builder
  .objectRef<{ file: FileRow; grant: SignedObjectRequest; issues: FileIssues }>(
    "FileDownloadPayload",
  )
  .implement({
    fields: (t) => ({
      file: t.expose("file", { type: File }),
      grant: t.expose("grant", { type: FileGrant }),
      issues: t.field({
        type: [ValidationIssue],
        resolve: (payload) => [...payload.issues],
      }),
    }),
  });
const ArchiveFilePayload = builder
  .objectRef<{ file: FileRow; issues: FileIssues }>("ArchiveFilePayload")
  .implement({
    fields: (t) => ({
      file: t.expose("file", { type: File }),
      issues: t.field({
        type: [ValidationIssue],
        resolve: (payload) => [...payload.issues],
      }),
    }),
  });

export function registerFilesGraphQL(): void {
  builder.queryFields((t) => ({
    files: t.field({
      type: FileConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: FileFilterInput }),
      },
      complexity: (args) => ({ field: 2, multiplier: args.first ?? 25 }),
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "read");
        return context.services.files.list({
          first: args.first,
          after: args.after,
          availability: args.filter?.availability,
        });
      },
    }),
    file: t.field({
      type: File,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "read");
        return context.loaders.file.load(args.id);
      },
    }),
    uploadSessions: t.field({
      type: UploadSessionConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        states: t.arg({ type: [UploadSessionState] }),
      },
      complexity: (args) => ({ field: 2, multiplier: args.first ?? 20 }),
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "create");
        return context.services.files.listUploadSessions({
          first: args.first,
          after: args.after,
          states: args.states,
        });
      },
    }),
    extractionRuns: t.field({
      type: [ExtractionRun],
      args: { fileId: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "read");
        if (!context.services.extraction) return [];
        return context.services.extraction.list(args.fileId);
      },
    }),
  }));

  builder.mutationFields((t) => ({
    createUploadSession: t.field({
      type: UploadPayload,
      args: {
        input: t.arg({ type: CreateUploadSessionInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "create");
        return context.services.files.createUploadSession({
          ...args.input,
          sensitivity: args.input.sensitivity,
        });
      },
    }),
    completeUpload: t.field({
      type: UploadPayload,
      args: { uploadSessionId: t.arg({ type: "UUID", required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "file", "create");
        const result = await context.services.files.completeUpload(
          args.uploadSessionId,
        );
        context.loaders.file.prime(result.file.id, result.file);
        return result;
      },
    }),
    regrantUploadSession: t.field({
      type: UploadPayload,
      args: { uploadSessionId: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "create");
        return context.services.files.regrantUploadSession(
          args.uploadSessionId,
        );
      },
    }),
    cancelUploadSession: t.field({
      type: UploadPayload,
      args: { uploadSessionId: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "create");
        return context.services.files.cancelUploadSession(args.uploadSessionId);
      },
    }),
    archiveFile: t.field({
      type: ArchiveFilePayload,
      args: {
        fileId: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
      },
      resolve: async (_root, args, context) => {
        requirePermission(context, "file", "delete");
        const result = await context.services.files.archiveFile(
          args.fileId,
          args.expectedVersion,
        );
        context.loaders.file.prime(result.file.id, result.file);
        return result;
      },
    }),
    createFileDownload: t.field({
      type: FileDownloadPayload,
      args: { fileId: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "file", "read");
        return context.services.files.createDownload(args.fileId);
      },
    }),
    requestExtraction: t.field({
      type: ExtractionRun,
      args: {
        fileId: t.arg({ type: "UUID", required: true }),
        extractor: t.arg.string(),
        configuration: t.arg({ type: "JSON" }),
      },
      resolve: async (_root, args, context) => {
        requirePermission(context, "file", "update");
        if (!context.services.extraction) {
          throw new Error("Extraction storage is not configured");
        }
        const queued = await context.services.extraction.request({
          fileId: args.fileId,
          extractor: args.extractor ?? undefined,
          configuration: args.configuration,
        });
        const runs = await context.services.extraction.list(args.fileId);
        const run = runs.find((item) => item.id === queued.runId);
        if (!run) throw new Error("Extraction run was not persisted");
        return run;
      },
    }),
  }));
}
