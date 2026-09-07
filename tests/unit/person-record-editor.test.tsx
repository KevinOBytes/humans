import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeBrowser = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => executeBrowser(...args),
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { PersonRecordEditor } from "@/components/people/person-record-editor";
import {
  CreatePersonEventDocument,
  CreatePersonNameDocument,
} from "@/graphql/generated/graphql";

const personId = "8aca7f8d-4c04-4777-94fd-bb12592b2494";

describe("PersonRecordEditor", () => {
  beforeEach(() => {
    executeBrowser.mockReset();
    refresh.mockReset();
  });

  it("creates an alternate name with the selected kind", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        createPersonName: { name: { id: "name-1" }, code: null, issues: [] },
      },
      requestId: "request-name",
    });
    render(<PersonRecordEditor personId={personId} />);

    await user.type(screen.getByLabelText("Full name"), "Ada Lovelace");
    await user.selectOptions(screen.getByLabelText("Kind"), "ALIAS");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(CreatePersonNameDocument, {
      input: { personId, fullName: "Ada Lovelace", kind: "ALIAS" },
    });
  });

  it("creates a timeline event and normalizes local date inputs", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        createPersonEvent: { event: { id: "event-1" }, code: null, issues: [] },
      },
      requestId: "request-event",
    });
    render(<PersonRecordEditor personId={personId} />);

    await user.type(screen.getByLabelText("Event kind"), "education");
    await user.type(screen.getByLabelText("Title"), "University");
    await user.type(screen.getByLabelText("Starts"), "2020-01-02T10:30");
    await user.type(screen.getByLabelText("Description"), "Studied history");
    await user.click(screen.getByRole("button", { name: "Save event" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(CreatePersonEventDocument, {
      input: {
        personId,
        eventKind: "education",
        title: "University",
        description: "Studied history",
        earliestAt: new Date("2020-01-02T10:30").toISOString(),
      },
    });
  });
});
