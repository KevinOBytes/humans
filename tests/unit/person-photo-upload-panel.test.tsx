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
vi.mock("@/components/files/upload-panel", () => ({
  UploadPanel: ({
    onCompleted,
  }: {
    onCompleted(file: { id: string }): void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onCompleted({ id: "018f0000-0000-7000-8000-000000000402" })
      }
    >
      Upload verified photo
    </button>
  ),
}));

import { PersonPhotoUploadPanel } from "@/components/people/person-photo-upload-panel";
import { SelectPersonPresentationDocument } from "@/graphql/generated/graphql";

describe("PersonPhotoUploadPanel", () => {
  beforeEach(() => {
    executeBrowser.mockReset();
    refresh.mockReset();
  });

  it("attaches a verified upload with the current person version", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        selectPersonPresentation: {
          person: { id: "person-1" },
          issues: [],
        },
      },
    });

    render(
      <PersonPhotoUploadPanel
        expectedVersion={7}
        maxBytes={8 * 1024 * 1024}
        personId="person-1"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Upload verified photo" }),
    );

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(
      SelectPersonPresentationDocument,
      {
        input: {
          personId: "person-1",
          expectedVersion: 7,
          primaryPhotoFileId: "018f0000-0000-7000-8000-000000000402",
          idempotencyKey: expect.any(String),
        },
      },
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Profile photo attached.",
    );
  });

  it("keeps the uploaded-file attachment failure visible", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        selectPersonPresentation: {
          person: null,
          issues: [{ message: "The person was changed by another request." }],
        },
      },
    });

    render(
      <PersonPhotoUploadPanel
        expectedVersion={7}
        maxBytes={8 * 1024 * 1024}
        personId="person-1"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Upload verified photo" }),
    );

    expect(
      await screen.findByText("The person was changed by another request."),
    ).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();
  });
});
