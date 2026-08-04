import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ArchiveFileControl,
  CancelUploadControl,
} from "@/components/files/file-lifecycle-controls";

const execute = vi.fn();
const refresh = vi.fn();

vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

describe("file lifecycle controls", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
  });

  it("cancels an abandoned upload, announces success, and restores focus", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        cancelUploadSession: {
          issues: [],
          session: {
            id: "018f0000-0000-7000-8000-000000000410",
            state: "CLEANUP_PENDING",
          },
        },
      },
    });
    const view = render(
      <>
        <h2 id="workspace-files-heading" tabIndex={-1}>
          Workspace files
        </h2>
        <CancelUploadControl
          sessionId="018f0000-0000-7000-8000-000000000410"
          fileName="abandoned.txt"
        />
      </>,
    );

    const button = screen.getByRole("button", {
      name: "Cancel upload abandoned.txt",
    });
    button.focus();
    await user.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upload cancelled.",
    );
    const durableHeading = screen.getByRole("heading", {
      name: "Workspace files",
    });
    expect(durableHeading).toHaveFocus();
    view.rerender(
      <h2 id="workspace-files-heading" tabIndex={-1}>
        Workspace files
      </h2>,
    );
    expect(durableHeading).toHaveFocus();
    expect(document.body.textContent).not.toMatch(/uploads\/|minio|provider/iu);
  });

  it("requires confirmation before archiving and returns focus after success", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        archiveFile: {
          issues: [],
          file: {
            id: "018f0000-0000-7000-8000-000000000411",
            version: 2,
            archivedAt: "2026-08-04T12:00:00.000Z",
          },
        },
      },
    });
    const view = render(
      <>
        <h2 id="workspace-files-heading" tabIndex={-1}>
          Workspace files
        </h2>
        <ArchiveFileControl
          fileId="018f0000-0000-7000-8000-000000000411"
          fileName="evidence.txt"
          version={1}
        />
      </>,
    );

    const archive = screen.getByRole("button", {
      name: "Archive evidence.txt",
    });
    await user.click(archive);
    expect(
      screen.getByText(/archive evidence\.txt\? this cannot be undone/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Confirm archive evidence.txt" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File archived.",
    );
    const durableHeading = screen.getByRole("heading", {
      name: "Workspace files",
    });
    expect(durableHeading).toHaveFocus();
    view.rerender(
      <h2 id="workspace-files-heading" tabIndex={-1}>
        Workspace files
      </h2>,
    );
    expect(durableHeading).toHaveFocus();
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(
      /storageKey|provider failure/iu,
    );
  });
});
