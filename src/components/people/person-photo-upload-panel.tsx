"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { UploadPanel } from "@/components/files/upload-panel";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  SelectPersonPresentationDocument,
  type FileWorkspaceItemFragment,
} from "@/graphql/generated/graphql";

export function PersonPhotoUploadPanel({
  expectedVersion,
  maxBytes,
  personId,
}: {
  expectedVersion: number;
  maxBytes: number;
  personId: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);

  async function attachPhoto(file: FileWorkspaceItemFragment) {
    if (!file.id) return;
    setStatus("Attaching the verified photo to this person…");
    const result = await executeBrowserGraphQL(
      SelectPersonPresentationDocument,
      {
        input: {
          personId,
          expectedVersion,
          primaryPhotoFileId: file.id,
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    if (!result.ok) {
      setStatus(
        result.errors[0]?.message ??
          "The photo uploaded, but could not be attached to this person.",
      );
      return;
    }
    const payload = result.data.selectPersonPresentation;
    const issue = payload.issues?.[0];
    if (issue || !payload.person) {
      setStatus(
        issue?.message ??
          "The photo uploaded, but could not be attached to this person.",
      );
      return;
    }
    setStatus("Profile photo attached.");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <UploadPanel
        accept="image/*"
        description="Upload a verified image and make it this person’s primary profile photo. Files stay private to the workspace."
        heading="Upload profile photo"
        maxBytes={maxBytes}
        onCompleted={(file) => void attachPhoto(file)}
        purpose="EVIDENCE"
      />
      {status ? (
        <p className="text-muted-foreground text-xs" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
