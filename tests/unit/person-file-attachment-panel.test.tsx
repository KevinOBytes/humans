import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeBrowser = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => executeBrowser(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import {
  PersonFileAttachmentPanel,
  PersonFileDetachButton,
} from "@/components/people/person-file-attachment-panel";
import {
  ArchivePersonFileDocument,
  AttachPersonFileDocument,
} from "@/graphql/generated/graphql";

const files = [
  {
    id: "018f0000-0000-7000-8000-000000000401",
    originalName: "interview.wav",
    mediaType: "audio/wav",
    byteSize: 1024,
    availability: "AVAILABLE",
    scanState: "CLEAN",
  },
];

describe("person file attachments", () => {
  beforeEach(() => {
    executeBrowser.mockReset();
    refresh.mockReset();
  });

  it("attaches an existing workspace file with an optional label", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        attachPersonFile: {
          attachment: { id: "attachment-1" },
          issues: [],
        },
      },
    });

    render(<PersonFileAttachmentPanel personId="person-1" files={files} />);
    await user.type(screen.getByLabelText("Label (optional)"), "Interview");
    await user.click(screen.getByRole("button", { name: "Attach file" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(AttachPersonFileDocument, {
      input: {
        personId: "person-1",
        fileId: files[0].id,
        label: "Interview",
        idempotencyKey: expect.any(String),
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent("File attached.");
  });

  it("keeps detach conflicts visible", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        archivePersonFile: {
          attachment: null,
          issues: [{ message: "The attachment changed." }],
        },
      },
    });

    render(
      <PersonFileDetachButton
        attachmentId="attachment-1"
        expectedVersion={2}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Detach" }));

    expect(await screen.findByText("The attachment changed.")).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();
    expect(executeBrowser).toHaveBeenCalledWith(ArchivePersonFileDocument, {
      input: {
        id: "attachment-1",
        expectedVersion: 2,
        idempotencyKey: expect.any(String),
      },
    });
  });
});
