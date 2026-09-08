import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

import { FileExtractionControls } from "@/components/files/file-extraction-controls";
import {
  CancelFileExtractionDocument,
  FileExtractionRunsDocument,
  RequestFileExtractionDocument,
  RetryFileExtractionDocument,
} from "@/graphql/generated/graphql";

const fileId = "018f0000-0000-7000-8000-000000000420";

function successfulRuns(runs: unknown[]) {
  return { ok: true, data: { extractionRuns: runs } };
}

describe("file extraction controls", () => {
  beforeEach(() => execute.mockReset());

  it("loads workspace-scoped run history and requests an extraction", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce(successfulRuns([]))
      .mockResolvedValueOnce({
        ok: true,
        data: {
          requestExtraction: { id: "run-1", state: "PENDING" },
        },
      })
      .mockResolvedValueOnce(
        successfulRuns([
          {
            id: "run-1",
            state: "PENDING",
            extractor: "text",
            extractorVersion: "1",
            createdAt: "2026-09-08T12:00:00.000Z",
            startedAt: null,
            completedAt: null,
            errorSummary: null,
            structuredOutput: null,
          },
        ]),
      );

    render(
      <FileExtractionControls
        fileId={fileId}
        fileName="interview.txt"
        canManage
        available
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Show extraction history for interview.txt",
      }),
    );
    expect(await screen.findByText("No extraction runs yet.")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Extract text from interview.txt" }),
    );

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(RequestFileExtractionDocument, {
        fileId,
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Extraction requested.",
    );
    expect(await screen.findByText("PENDING")).toBeVisible();
    expect(execute).toHaveBeenCalledWith(FileExtractionRunsDocument, {
      fileId,
    });
    expect(document.body.textContent).not.toMatch(/storageKey|provider/iu);
  });

  it("offers cancellation for active runs and retry for terminal failures", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce(
        successfulRuns([
          {
            id: "run-active",
            state: "PROCESSING",
            extractor: "text",
            extractorVersion: "1",
            createdAt: "2026-09-08T12:00:00.000Z",
            startedAt: "2026-09-08T12:01:00.000Z",
            completedAt: null,
            errorSummary: null,
            structuredOutput: null,
          },
          {
            id: "run-failed",
            state: "ERROR",
            extractor: "text",
            extractorVersion: "1",
            createdAt: "2026-09-08T11:00:00.000Z",
            startedAt: "2026-09-08T11:01:00.000Z",
            completedAt: "2026-09-08T11:02:00.000Z",
            errorSummary: { code: "extract_failed" },
            structuredOutput: null,
          },
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: { cancelExtraction: { id: "run-active", state: "CANCELLED" } },
      })
      .mockResolvedValueOnce(
        successfulRuns([
          {
            id: "run-failed",
            state: "ERROR",
            extractor: "text",
            extractorVersion: "1",
            createdAt: "2026-09-08T11:00:00.000Z",
            startedAt: "2026-09-08T11:01:00.000Z",
            completedAt: "2026-09-08T11:02:00.000Z",
            errorSummary: { code: "extract_failed" },
            structuredOutput: null,
          },
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: { retryExtraction: { id: "run-failed", state: "PENDING" } },
      })
      .mockResolvedValueOnce(successfulRuns([]));

    render(
      <FileExtractionControls
        fileId={fileId}
        fileName="interview.txt"
        canManage
        available
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Show extraction history for interview.txt",
      }),
    );
    await screen.findByRole("button", {
      name: "Cancel extraction run run-active",
    });

    await user.click(
      screen.getByRole("button", { name: "Cancel extraction run run-active" }),
    );
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(CancelFileExtractionDocument, {
        runId: "run-active",
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Retry extraction run run-failed" }),
    );
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(RetryFileExtractionDocument, {
        runId: "run-failed",
      }),
    );
  });

  it("does not expose extraction actions without update permission", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValueOnce(successfulRuns([]));
    render(
      <FileExtractionControls
        fileId={fileId}
        fileName="interview.txt"
        canManage={false}
        available
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Show extraction history for interview.txt",
      }),
    );
    await screen.findByText("No extraction runs yet.");
    expect(
      screen.queryByRole("button", { name: "Extract text from interview.txt" }),
    ).not.toBeInTheDocument();
  });
});
