"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { executeBrowserGraphQL } from "@/graphql/client";
import {
  ArchivePersonFileDocument,
  AttachPersonFileDocument,
  MutationIssueFragmentDoc,
} from "@/graphql/generated/graphql";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";

type WorkspaceFile = {
  id: string;
  originalName: string;
  mediaType: string | null;
  byteSize: number;
  availability: string;
  scanState: string;
};

export function PersonFileAttachmentPanel({
  personId,
  files,
}: {
  personId: string;
  files: readonly WorkspaceFile[];
}) {
  const router = useRouter();
  const [fileId, setFileId] = useState(files[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function attach() {
    if (!fileId) return;
    setStatus("Attaching file…");
    const result = await executeBrowserGraphQL(AttachPersonFileDocument, {
      input: {
        personId,
        fileId,
        label: label.trim() || null,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    if (!result.ok) {
      setStatus(result.errors[0]?.message ?? "The file could not be attached.");
      return;
    }
    const issue = readFragment(
      MutationIssueFragmentDoc,
      result.data.attachPersonFile.issues ?? [],
    )[0];
    if (issue || !result.data.attachPersonFile.attachment) {
      setStatus(issue?.message ?? "The file could not be attached.");
      return;
    }
    setLabel("");
    setStatus("File attached.");
    router.refresh();
  }

  if (files.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Upload a file first, then attach it here.
      </p>
    );
  }

  return (
    <div className="border-border bg-card space-y-3 rounded-xl border p-4">
      <div>
        <h3 className="font-semibold">Attach an existing file</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Keep a direct person reference without inventing a fact or citation.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium">
          Workspace file
          <select
            className="border-input bg-background min-h-10 rounded-md border px-3"
            value={fileId}
            onChange={(event) => setFileId(event.target.value)}
          >
            {files.map((file) => (
              <option key={file.id} value={file.id}>
                {file.originalName} ({file.availability.toLowerCase()})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Label (optional)
          <input
            className="border-input bg-background min-h-10 rounded-md border px-3"
            maxLength={500}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Interview recording"
          />
        </label>
        <button
          type="button"
          className="bg-primary text-primary-foreground min-h-10 rounded-md px-4 text-sm font-semibold"
          onClick={() => void attach()}
        >
          Attach file
        </button>
      </div>
      {status ? (
        <p className="text-muted-foreground text-xs" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}

export function PersonFileDetachButton({
  attachmentId,
  expectedVersion,
}: {
  attachmentId: string;
  expectedVersion: number;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);

  async function detach() {
    setStatus("Detaching…");
    const result = await executeBrowserGraphQL(ArchivePersonFileDocument, {
      input: {
        id: attachmentId,
        expectedVersion,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    if (!result.ok) {
      setStatus(result.errors[0]?.message ?? "The file could not be detached.");
      return;
    }
    const issue = readFragment(
      MutationIssueFragmentDoc,
      result.data.archivePersonFile.issues ?? [],
    )[0];
    if (issue || !result.data.archivePersonFile.attachment) {
      setStatus(issue?.message ?? "The file could not be detached.");
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="text-destructive text-xs font-semibold underline underline-offset-4"
        onClick={() => void detach()}
      >
        Detach
      </button>
      {status ? (
        <span className="text-muted-foreground text-xs" role="status">
          {status}
        </span>
      ) : null}
    </span>
  );
}
