import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UploadPanel } from "@/components/files/upload-panel";

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
});
