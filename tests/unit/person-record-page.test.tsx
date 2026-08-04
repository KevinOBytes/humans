import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appContext = vi.hoisted(() => vi.fn());
const executeServer = vi.hoisted(() => vi.fn());
const executeBrowser = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/app-session", () => ({ getAppContext: appContext }));
vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: executeServer,
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => executeBrowser(...args),
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
  useRouter: () => ({ refresh }),
}));

vi.mock("@/components/facts/facts-section", () => ({
  FactsSection: () => <section>Facts</section>,
}));
vi.mock("@/components/relationships/relationships-section", () => ({
  RelationshipsSection: () => <section>Relationships</section>,
}));
vi.mock("@/components/evidence/evidence-section", () => ({
  EvidenceSection: () => <section>Evidence</section>,
}));
vi.mock("@/components/notes/notes-section", () => ({
  NotesSection: () => <section>Notes</section>,
}));
vi.mock("@/components/activity/activity-section", () => ({
  ActivitySection: () => <section>Activity</section>,
}));
vi.mock("@/components/locations/contacts-places-section", () => ({
  ContactsPlacesSection: () => <section>Contacts</section>,
}));

import { PersonRecordPage } from "@/components/people/person-record-page";
import { UpdatePersonDocument } from "@/graphql/generated/graphql";

const person = {
  id: "8aca7f8d-4c04-4777-94fd-bb12592b2494",
  displayName: "Ada Researcher",
  preferredName: "Ada",
  sortName: "Researcher, Ada",
  biography: "Original biography",
  status: "ACTIVE" as const,
  sensitivity: "INTERNAL" as const,
  version: 3,
};

async function renderPage(permissions: string[]) {
  appContext.mockResolvedValue({ viewer: { permissions } });
  executeServer.mockResolvedValue({ person });
  render(
    await PersonRecordPage({
      params: Promise.resolve({ personId: person.id }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe("PersonRecordPage overview editing", () => {
  beforeEach(() => {
    appContext.mockReset();
    executeServer.mockReset();
    executeBrowser.mockReset();
    refresh.mockReset();
  });

  it("does not expose overview editing without person:update", async () => {
    await renderPage(["person:read"]);

    expect(screen.queryByRole("button", { name: "Edit overview" })).toBeNull();
  });

  it("initializes the authorized editor and refreshes after success", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValue({
      ok: true,
      data: {
        updatePerson: {
          person: { ...person, displayName: "Ada Lovelace", version: 4 },
          code: null,
          currentVersion: null,
          issues: [],
        },
      },
      requestId: "request-update-success",
    });
    await renderPage(["person:read", "person:update"]);

    await user.click(screen.getByRole("button", { name: "Edit overview" }));
    expect(screen.getByLabelText("Display name")).toHaveValue("Ada Researcher");
    expect(screen.getByLabelText("Preferred name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Sort name")).toHaveValue("Researcher, Ada");
    expect(screen.getByLabelText("Biography")).toHaveValue(
      "Original biography",
    );
    expect(screen.getByLabelText("Status")).toHaveValue("ACTIVE");
    expect(screen.getByLabelText("Sensitivity")).toHaveValue("INTERNAL");

    await user.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(screen.queryByRole("form", { name: "Person form" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit overview" }));

    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Save overview" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenCalledWith(UpdatePersonDocument, {
      input: {
        id: person.id,
        expectedVersion: 3,
        displayName: "Ada Lovelace",
        preferredName: "Ada",
        sortName: "Researcher, Ada",
        biography: "Original biography",
        status: "ACTIVE",
        sensitivity: "INTERNAL",
      },
    });
  });

  it("preserves a conflicted draft until explicit reload recovery", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValue({
      ok: true,
      data: {
        updatePerson: {
          person: null,
          code: "CONFLICT",
          currentVersion: 4,
          issues: [],
        },
      },
      requestId: "request-update-conflict",
    });
    await renderPage(["person:read", "person:update"]);

    await user.click(screen.getByRole("button", { name: "Edit overview" }));
    await user.clear(screen.getByLabelText("Biography"));
    await user.type(screen.getByLabelText("Biography"), "Conflicted draft");
    await user.click(screen.getByRole("button", { name: "Save overview" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("CONFLICT");
    expect(screen.getByLabelText("Biography")).toHaveValue("Conflicted draft");
    expect(refresh).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Reload current data" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
});
