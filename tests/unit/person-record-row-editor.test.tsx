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
  PersonEventRowEditor,
  PersonNameRowEditor,
} from "@/components/people/person-record-row-editor";
import {
  ArchivePersonEventDocument,
  UpdatePersonNameDocument,
  type PersonEventSummaryFragment,
  type PersonNameSummaryFragment,
} from "@/graphql/generated/graphql";

const name = {
  id: "8aca7f8d-4c04-4777-94fd-bb12592b2494",
  personId: "7aca7f8d-4c04-4777-94fd-bb12592b2494",
  kind: "ALIAS",
  fullName: "Ada Researcher",
  givenName: null,
  middleName: null,
  familyName: null,
  prefix: null,
  suffix: null,
  script: null,
  language: null,
  validFrom: null,
  validUntil: null,
  temporalSemantics: "UNKNOWN",
  temporalPrecision: "UNKNOWN",
  confidence: 1,
  sensitivity: "INTERNAL",
  state: "ASSERTED",
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as PersonNameSummaryFragment;

const event = {
  id: "9aca7f8d-4c04-4777-94fd-bb12592b2494",
  personId: name.personId,
  eventKind: "career",
  title: "Researcher",
  description: null,
  placeId: null,
  earliestAt: null,
  latestAt: null,
  temporalSemantics: "UNKNOWN",
  temporalPrecision: "UNKNOWN",
  confidence: 1,
  sensitivity: "INTERNAL",
  state: "ASSERTED",
  version: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as PersonEventSummaryFragment;

describe("person record row editors", () => {
  beforeEach(() => {
    executeBrowser.mockReset();
    refresh.mockReset();
  });

  it("updates a name with its optimistic version", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: { updatePersonName: { name: { id: name.id }, code: null } },
      requestId: "request-name-update",
    });
    render(
      <PersonNameRowEditor
        name={name}
        canUpdate
        canDelete={false}
        dateLabel=""
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Edit Ada Researcher/ }),
    );
    await user.clear(screen.getByLabelText("Full name"));
    await user.type(screen.getByLabelText("Full name"), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(UpdatePersonNameDocument, {
      input: {
        id: name.id,
        expectedVersion: 2,
        fullName: "Ada Lovelace",
        kind: "ALIAS",
      },
    });
  });

  it("archives an event only when the delete permission is present", async () => {
    const user = userEvent.setup();
    render(
      <PersonEventRowEditor
        event={event}
        canUpdate={false}
        canDelete={false}
        dateLabel="Date unknown"
      />,
    );
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();

    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: { archivePersonEvent: { event: { id: event.id }, code: null } },
      requestId: "request-event-archive",
    });
    render(
      <PersonEventRowEditor
        event={event}
        canUpdate={false}
        canDelete
        dateLabel="Date unknown"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Archive Researcher/ }),
    );

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(ArchivePersonEventDocument, {
      input: { id: event.id, expectedVersion: 4 },
    });
  });
});
