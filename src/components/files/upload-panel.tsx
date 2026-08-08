"use client";

import { Download, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { completedUploadStatus } from "@/components/files/upload-status";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  CompleteWorkspaceUploadDocument,
  CreateWorkspaceFileDownloadDocument,
  CreateWorkspaceUploadDocument,
  FileWorkspaceItemFragmentDoc,
  RegrantWorkspaceUploadDocument,
  type FileWorkspaceItemFragment,
  type UploadPurpose,
} from "@/graphql/generated/graphql";

const acceptedTypes: Record<UploadPurpose, string> = {
  EVIDENCE: ".pdf,.png,.jpg,.jpeg,.webp,.txt",
  CSV_IMPORT: ".csv,text/csv",
  JSON_IMPORT: ".json,application/json",
};

function uploadMediaType(file: File, purpose: UploadPurpose): string {
  if (purpose === "CSV_IMPORT") return "text/csv";
  if (purpose === "JSON_IMPORT") return "application/json";
  return file.type || "application/octet-stream";
}

function grantHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function checksumDigest(value: string): string {
  return value.replace(/^sha256:/u, "").toLowerCase();
}

function firstIssue(
  issues: readonly { message: string }[] | null | undefined,
): string | null {
  return issues?.[0]?.message ?? null;
}

export function UploadPanel({
  maxBytes,
  onCompleted,
  purpose,
}: {
  maxBytes: number;
  onCompleted?(file: FileWorkspaceItemFragment): void;
  purpose: UploadPurpose;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function uploadFile(file: File) {
    const maxMib = maxBytes / (1024 * 1024);
    if (file.size > maxBytes) {
      setStatus(`Choose a file no larger than ${maxMib} MiB.`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    setStatus("Preparing secure upload…");
    try {
      const created = await executeBrowserGraphQL(
        CreateWorkspaceUploadDocument,
        {
          input: {
            originalName: file.name,
            claimedMediaType: uploadMediaType(file, purpose),
            byteSize: file.size,
            checksumSha256: await sha256(file),
            purpose,
          },
        },
      );
      if (!created.ok) throw new Error(created.errors[0]?.message);
      const upload = created.data.createUploadSession;
      const issue = firstIssue(upload?.issues);
      if (issue) throw new Error(issue);
      if (
        !upload?.session?.id ||
        upload.grant?.method !== "PUT" ||
        !upload.grant.url
      ) {
        throw new Error("The secure upload grant was incomplete.");
      }
      setStatus("Uploading and verifying…");
      const response = await fetch(upload.grant.url, {
        method: "PUT",
        headers: grantHeaders(upload.grant.headers),
        body: file,
      });
      if (!response.ok) throw new Error("The object upload was rejected.");
      const completed = await executeBrowserGraphQL(
        CompleteWorkspaceUploadDocument,
        { uploadSessionId: upload.session.id },
      );
      if (!completed.ok) throw new Error(completed.errors[0]?.message);
      const payload = completed.data.completeUpload;
      const completionIssue = firstIssue(payload?.issues);
      if (completionIssue) throw new Error(completionIssue);
      const uploaded = readFragment(
        FileWorkspaceItemFragmentDoc,
        payload?.file,
      );
      if (!uploaded?.id) throw new Error("The verified file was not returned.");
      setStatus(completedUploadStatus(uploaded));
      if (
        uploaded.availability === "AVAILABLE" &&
        (uploaded.scanState === "CLEAN" ||
          uploaded.scanState === "NOT_REQUIRED")
      ) {
        onCompleted?.(uploaded);
      }
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : "The upload could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-border bg-card rounded-2xl border p-5">
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-xl">
          <Upload aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-semibold">
            {purpose === "EVIDENCE" ? "Upload evidence" : "Upload import data"}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Files are checksum-verified, private to this workspace, and limited
            to {maxBytes / (1024 * 1024)} MiB.
          </p>
        </div>
      </div>
      <label htmlFor={inputId} className="mt-5 block text-sm font-medium">
        Choose file
      </label>
      <Input
        ref={inputRef}
        id={inputId}
        className="mt-2 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-semibold"
        type="file"
        accept={acceptedTypes[purpose]}
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void uploadFile(file);
        }}
      />
      <p className="text-muted-foreground mt-3 text-xs" aria-live="polite">
        {status ??
          `Select one supported file up to ${maxBytes / (1024 * 1024)} MiB.`}
      </p>
    </section>
  );
}

export function UploadRecoveryControl({
  session,
  onCompleted,
}: {
  session: {
    id: string;
    originalName: string;
    byteSize: number;
    checksumSha256: string;
  };
  onCompleted?(file: FileWorkspaceItemFragment): void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function resume(file: File) {
    setBusy(true);
    setStatus("Checking the selected file…");
    try {
      const digest = await sha256(file);
      if (
        file.name !== session.originalName ||
        file.size !== session.byteSize ||
        digest !== checksumDigest(session.checksumSha256)
      ) {
        setStatus("The selected file does not match the pending upload.");
        return;
      }
      const regranted = await executeBrowserGraphQL(
        RegrantWorkspaceUploadDocument,
        { id: session.id },
      );
      if (!regranted.ok) throw new Error("regrant_failed");
      const recovery = regranted.data.regrantUploadSession;
      if (
        firstIssue(recovery?.issues) ||
        recovery?.grant?.method !== "PUT" ||
        !recovery.grant.url
      ) {
        throw new Error("regrant_failed");
      }
      setStatus("Uploading and verifying…");
      const response = await fetch(recovery.grant.url, {
        method: "PUT",
        headers: grantHeaders(recovery.grant.headers),
        body: file,
      });
      if (!response.ok) throw new Error("upload_failed");
      const completed = await executeBrowserGraphQL(
        CompleteWorkspaceUploadDocument,
        { uploadSessionId: session.id },
      );
      if (!completed.ok || firstIssue(completed.data.completeUpload?.issues)) {
        throw new Error("completion_failed");
      }
      const uploaded = readFragment(
        FileWorkspaceItemFragmentDoc,
        completed.data.completeUpload?.file,
      );
      if (!uploaded?.id) throw new Error("completion_failed");
      setStatus(completedUploadStatus(uploaded));
      onCompleted?.(uploaded);
    } catch {
      setStatus("The pending upload could not be resumed. Please try again.");
    } finally {
      // Reset even when validation or recovery fails so selecting the same
      // file again reliably emits a change event in every browser.
      if (inputRef.current) inputRef.current.value = "";
      setBusy(false);
    }
  }

  return (
    <div>
      <label htmlFor={inputId} className="text-sm font-medium">
        Resume {session.originalName}
      </label>
      <Input
        ref={inputRef}
        id={inputId}
        className="mt-2 max-w-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-semibold"
        type="file"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void resume(file);
        }}
      />
      {status ? (
        <p className="text-muted-foreground mt-2 text-xs" role="alert">
          {status}
        </p>
      ) : null}
    </div>
  );
}

export function FileDownloadButton({
  fileId,
  fileName,
}: {
  fileId: string;
  fileName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await executeBrowserGraphQL(
              CreateWorkspaceFileDownloadDocument,
              { fileId },
            );
            if (!result.ok) throw new Error(result.errors[0]?.message);
            const grant = result.data.createFileDownload?.grant;
            if (grant?.method !== "GET" || !grant.url) {
              throw new Error("The download grant was incomplete.");
            }
            const response = await fetch(grant.url, {
              headers: grantHeaders(grant.headers),
            });
            if (!response.ok) throw new Error("The download was unavailable.");
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = fileName;
            anchor.click();
            URL.revokeObjectURL(url);
          } catch (caught) {
            setError(
              caught instanceof Error && caught.message
                ? caught.message
                : "The download could not be completed.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download aria-hidden="true" data-icon="inline-start" />
        {busy ? "Preparing…" : "Download"}
      </Button>
      {error ? (
        <span className="sr-only" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
