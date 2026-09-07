import { notFound } from "next/navigation";

import { FileDownloadButton } from "@/components/files/upload-panel";
import { PersonPhotoUploadPanel } from "@/components/people/person-photo-upload-panel";
import {
  PersonFileAttachmentPanel,
  PersonFileDetachButton,
} from "@/components/people/person-file-attachment-panel";
import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { Badge } from "@/components/ui/badge";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  EvidenceFilesDocument,
  EvidenceFileRowFragmentDoc,
  PersonFilesDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { cursorParam, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export async function PersonFilesSection({
  canAttach,
  canManageAttachments,
  personVersion,
  personId,
  search,
  uploadMaxBytes,
}: {
  canAttach: boolean;
  canManageAttachments: boolean;
  personVersion: number;
  personId: string;
  search: SearchState;
  uploadMaxBytes: number | null;
}) {
  const after = cursorParam(search, "fileAfter");
  const [data, workspaceFiles] = await Promise.all([
    executeServerGraphQL(PersonFilesDocument, {
      id: personId,
      first: 10,
      after,
    }),
    canManageAttachments
      ? executeServerGraphQL(EvidenceFilesDocument, { first: 50, after: null })
      : Promise.resolve(null),
  ]);
  if (!data.person || !data.person.files) notFound();
  const page = readFragment(PageDetailsFragmentDoc, data.person.files.pageInfo);
  const files = data.person.files.nodes ?? [];
  const workspaceFileOptions = (workspaceFiles?.files?.nodes ?? [])
    .filter((file): file is NonNullable<typeof file> => file != null)
    .map((file) => readFragment(EvidenceFileRowFragmentDoc, file))
    .filter(
      (
        file,
      ): file is typeof file & {
        id: string;
        originalName: string;
        byteSize: number;
        availability: string;
        scanState: string;
      } =>
        typeof file.id === "string" &&
        typeof file.originalName === "string" &&
        typeof file.byteSize === "number" &&
        typeof file.availability === "string" &&
        typeof file.scanState === "string",
    );

  return (
    <div className="space-y-3">
      {canAttach && uploadMaxBytes ? (
        <PersonPhotoUploadPanel
          expectedVersion={personVersion}
          maxBytes={uploadMaxBytes}
          personId={personId}
        />
      ) : null}
      {canManageAttachments ? (
        <PersonFileAttachmentPanel
          personId={personId}
          files={workspaceFileOptions}
        />
      ) : null}
      <ResearchList
        title="Person files"
        empty="No visible files are attached to this person."
      >
        {files.map((file) => {
          const downloadable =
            file.availability === "AVAILABLE" &&
            (file.scanState === "CLEAN" || file.scanState === "NOT_REQUIRED");
          return (
            <li
              key={file.id}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold break-all">
                    {file.originalName}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {formatBytes(file.byteSize)}
                    {file.mediaType ? ` · ${file.mediaType}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge>{file.availability.toLowerCase()}</Badge>
                  <Badge>{file.scanState.toLowerCase()}</Badge>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {file.roles.map((role) => (
                  <Badge key={role} variant="neutral">
                    {role.toLowerCase().replaceAll("_", " ")}
                  </Badge>
                ))}
                {downloadable ? (
                  <FileDownloadButton
                    fileId={file.id}
                    fileName={file.originalName}
                  />
                ) : (
                  <span className="text-muted-foreground text-xs">
                    Download unavailable until the file is cleared.
                  </span>
                )}
                {canManageAttachments &&
                file.directAttachmentId &&
                file.directAttachmentVersion ? (
                  <PersonFileDetachButton
                    attachmentId={file.directAttachmentId}
                    expectedVersion={file.directAttachmentVersion}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ResearchList>
      <PageControls
        label="Person files"
        resetHref={after ? profilePageHref(personId, "files") : null}
        nextHref={
          page?.hasNextPage && page.endCursor
            ? profilePageHref(personId, "files", { fileAfter: page.endCursor })
            : null
        }
        nextLabel="More files"
      />
    </div>
  );
}
