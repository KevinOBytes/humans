import Link from "next/link";

import { getAppContext } from "@/app/(app)/app-session";
import {
  FileDownloadButton,
  UploadPanel,
} from "@/components/files/upload-panel";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  EvidenceFilesDocument,
  FileWorkspaceItemFragmentDoc,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { readOpaqueCursor } from "@/lib/research-pagination";

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const params = await searchParams;
  const after = readOpaqueCursor(params.after);
  const data = await executeServerGraphQL(EvidenceFilesDocument, {
    first: 20,
    after,
  });
  const files =
    readFragment(FileWorkspaceItemFragmentDoc, data.files?.nodes) ?? [];
  const pageInfo = data.files?.pageInfo;
  const canCreate = context.viewer.permissions.includes("file:create");

  return (
    <div className="space-y-7">
      <header>
        <p className="text-primary text-sm font-semibold">Evidence workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Files and evidence
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          Upload private source material, monitor verification, and retrieve
          authorized evidence without exposing storage credentials.
        </p>
      </header>

      {canCreate ? <UploadPanel purpose="EVIDENCE" /> : null}

      <section aria-labelledby="workspace-files-heading">
        <div className="mb-4">
          <h2 id="workspace-files-heading" className="text-xl font-semibold">
            Workspace files
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Only files visible to your current role are shown.
          </p>
        </div>
        <div className="border-border overflow-x-auto rounded-2xl border">
          <Table aria-label="Workspace evidence files">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead>Scan</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.flatMap((file) =>
                file.id && file.originalName
                  ? [
                      <TableRow key={file.id}>
                        <TableCell>
                          <p className="font-medium">{file.originalName}</p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {file.detectedType ??
                              file.mediaType ??
                              "Unknown type"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge>{file.availability ?? "UNKNOWN"}</Badge>
                        </TableCell>
                        <TableCell>{file.scanState ?? "UNKNOWN"}</TableCell>
                        <TableCell>
                          {file.byteSize == null
                            ? "—"
                            : `${Math.max(1, Math.ceil(file.byteSize / 1024)).toLocaleString()} KB`}
                        </TableCell>
                        <TableCell>
                          {file.updatedAt
                            ? new Date(file.updatedAt).toLocaleString()
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {file.availability === "AVAILABLE" ? (
                            <FileDownloadButton
                              fileId={file.id}
                              fileName={file.originalName}
                            />
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              Not available
                            </span>
                          )}
                        </TableCell>
                      </TableRow>,
                    ]
                  : [],
              )}
              {files.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center">
                    <p className="font-medium">No evidence files yet</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Upload a supported file to begin.
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        {pageInfo?.hasNextPage && pageInfo.endCursor ? (
          <div className="mt-4 flex justify-end">
            <Link
              href={`/evidence?after=${encodeURIComponent(pageInfo.endCursor)}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Next files
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}
