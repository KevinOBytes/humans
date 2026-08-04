import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UploadPanel,
  UploadRecoveryControl,
} from "@/components/files/upload-panel";

const execute = vi.fn();

vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("UploadPanel completion state", () => {
  beforeEach(() => {
    execute.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a scan-error upload quarantined and does not expose it as completed", async () => {
    const user = userEvent.setup();
    const onCompleted = vi.fn();
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: {
          createUploadSession: {
            issues: [],
            session: { id: "018f0000-0000-7000-8000-000000000401" },
            grant: {
              method: "PUT",
              url: "https://storage.example.test/upload",
              headers: {},
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          completeUpload: {
            issues: [],
            file: {
              id: "018f0000-0000-7000-8000-000000000402",
              originalName: "people.csv",
              availability: "QUARANTINED",
              scanState: "ERROR",
            },
          },
        },
      });
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upload);

    render(<UploadPanel purpose="CSV_IMPORT" onCompleted={onCompleted} />);
    await user.upload(
      screen.getByLabelText("Choose file"),
      new File(["name\nAda\n"], "people.csv", { type: "text/csv" }),
    );

    expect(
      await screen.findByText(
        /people\.csv was verified but remains quarantined because scanning is unavailable/i,
      ),
    ).toBeInTheDocument();
    expect(upload).toHaveBeenCalledOnce();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("regrants only after the exact abandoned local file is selected", async () => {
    const user = userEvent.setup();
    const onCompleted = vi.fn();
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: {
          regrantUploadSession: {
            issues: [],
            session: { id: "018f0000-0000-7000-8000-000000000403" },
            grant: {
              method: "PUT",
              url: "https://storage.example.test/regrant",
              headers: {},
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          completeUpload: {
            issues: [],
            file: {
              id: "018f0000-0000-7000-8000-000000000404",
              originalName: "abandoned.txt",
              availability: "AVAILABLE",
              scanState: "NOT_REQUIRED",
            },
          },
        },
      });
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upload);

    render(
      <UploadRecoveryControl
        session={{
          id: "018f0000-0000-7000-8000-000000000403",
          originalName: "abandoned.txt",
          byteSize: 9,
          checksumSha256:
            "sha256:4967117e0ea125c324ca3d05a15ee769b1c3b590d647647387a5af7b04cc3aef",
        }}
        onCompleted={onCompleted}
      />,
    );
    await user.upload(
      screen.getByLabelText("Resume abandoned.txt"),
      new File(["different"], "abandoned.txt", { type: "text/plain" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /does not match the pending upload/i,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
