"use client";

import { Archive, Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { UploadRecoveryControl } from "@/components/files/upload-panel";
import { Button } from "@/components/ui/button";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  ArchiveWorkspaceFileDocument,
  CancelWorkspaceUploadDocument,
} from "@/graphql/generated/graphql";

export function CancelUploadControl({
  sessionId,
}: {
  sessionId: string;
  fileName: string;
}) {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div>
      <Button
        ref={buttonRef}
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setStatus(null);
          try {
            const result = await executeBrowserGraphQL(
              CancelWorkspaceUploadDocument,
              { id: sessionId },
            );
            if (
              !result.ok ||
              result.data.cancelUploadSession?.issues?.length ||
              result.data.cancelUploadSession?.session?.state !==
                "CLEANUP_PENDING"
            ) {
              throw new Error("cancel_failed");
            }
            setStatus("Upload cancelled.");
            buttonRef.current?.focus();
            router.refresh();
          } catch {
            setStatus("The upload could not be cancelled. Please try again.");
            buttonRef.current?.focus();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Ban aria-hidden="true" data-icon="inline-start" />
        {busy ? "Cancelling…" : "Cancel upload"}
      </Button>
      {status ? (
        <p className="text-muted-foreground mt-2 text-xs" role="alert">
          {status}
        </p>
      ) : null}
    </div>
  );
}

export function ArchiveFileControl({
  fileId,
  fileName,
  version,
}: {
  fileId: string;
  fileName: string;
  version: number;
}) {
  const router = useRouter();
  const archiveRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming && status) archiveRef.current?.focus();
  }, [confirming, status]);

  return (
    <div>
      <Button
        ref={archiveRef}
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setStatus(null);
          setConfirming(true);
        }}
      >
        <Archive aria-hidden="true" data-icon="inline-start" />
        Archive
      </Button>
      {confirming ? (
        <div className="border-border bg-background mt-2 rounded-xl border p-3">
          <p className="text-sm">Archive {fileName}? This cannot be undone.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await executeBrowserGraphQL(
                    ArchiveWorkspaceFileDocument,
                    { id: fileId, expectedVersion: version },
                  );
                  if (
                    !result.ok ||
                    result.data.archiveFile?.issues?.length ||
                    !result.data.archiveFile?.file?.archivedAt
                  ) {
                    throw new Error("archive_failed");
                  }
                  setConfirming(false);
                  setStatus("File archived.");
                  archiveRef.current?.focus();
                  router.refresh();
                } catch {
                  setStatus(
                    "The file could not be archived. Refresh and try again.",
                  );
                  archiveRef.current?.focus();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Archiving…" : "Confirm archive"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                archiveRef.current?.focus();
              }}
            >
              Keep file
            </Button>
          </div>
        </div>
      ) : null}
      {status ? (
        <p className="text-muted-foreground mt-2 text-xs" role="alert">
          {status}
        </p>
      ) : null}
    </div>
  );
}

export function PendingUploadRecoveryList({
  sessions,
}: {
  sessions: readonly {
    id: string;
    originalName: string;
    byteSize: number;
    checksumSha256?: string | null;
    expiresAt: string;
  }[];
}) {
  const router = useRouter();
  if (sessions.length === 0) return null;
  return (
    <section aria-labelledby="pending-uploads-heading">
      <h2 id="pending-uploads-heading" className="text-xl font-semibold">
        Pending uploads
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Resume with the exact local file or cancel an abandoned upload.
      </p>
      <ul className="mt-4 space-y-3">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="border-border bg-card rounded-2xl border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-medium">{session.originalName}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {Math.max(
                    1,
                    Math.ceil(session.byteSize / 1024),
                  ).toLocaleString()}{" "}
                  KB · Expires {new Date(session.expiresAt).toLocaleString()}
                </p>
              </div>
              <CancelUploadControl
                sessionId={session.id}
                fileName={session.originalName}
              />
            </div>
            {session.checksumSha256 ? (
              <div className="mt-4">
                <UploadRecoveryControl
                  session={{
                    id: session.id,
                    originalName: session.originalName,
                    byteSize: session.byteSize,
                    checksumSha256: session.checksumSha256,
                  }}
                  onCompleted={() => router.refresh()}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
