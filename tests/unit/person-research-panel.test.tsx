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

import { PersonResearchPanel } from "@/components/people/person-research-panel";
import {
  PersonWebResearchDocument,
  UpdatePersonDocument,
} from "@/graphql/generated/graphql";

const person = {
  id: "8aca7f8d-4c04-4777-94fd-bb12592b2494",
  displayName: "Ada Researcher",
  preferredName: "Ada",
  sortName: "Researcher, Ada",
  biography: "Original biography",
  version: 3,
};

const researchResult = {
  personId: person.id,
  runId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
  provider: "openai-compatible",
  model: "research-model",
  sources: [
    {
      title: "Ada profile",
      url: "https://example.com/ada",
      snippet: "A public profile.",
    },
  ],
  suggestions: [
    {
      field: "displayName",
      value: "Ada Lovelace",
      sourceUrls: ["https://example.com/ada"],
    },
    {
      field: "biography",
      value: "Mathematician and writer.",
      sourceUrls: ["https://example.com/ada"],
    },
  ],
};

async function runResearch(user: ReturnType<typeof userEvent.setup>) {
  executeBrowser.mockResolvedValueOnce({
    ok: true,
    data: { personWebResearch: researchResult },
    requestId: "request-research",
  });
  await user.click(
    screen.getByRole("checkbox", {
      name: /I understand and want to search public web sources/i,
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Research this person" }),
  );
  await screen.findByDisplayValue("Ada Lovelace");
}

describe("PersonResearchPanel", () => {
  beforeEach(() => {
    executeBrowser.mockReset();
    refresh.mockReset();
  });

  it("discloses external processing and keeps every suggestion unchecked", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);

    expect(screen.getByText(/never sends contacts, addresses/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Research this person" }),
    ).toBeDisabled();

    await runResearch(user);

    expect(
      screen.getByText(/Provenance recorded as research run/),
    ).toHaveTextContent(researchResult.runId);

    expect(executeBrowser).toHaveBeenCalledWith(PersonWebResearchDocument, {
      personId: person.id,
      consent: true,
    });
    expect(
      screen.getByRole("checkbox", { name: "Apply Display name" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Apply Biography" }),
    ).not.toBeChecked();
    expect(screen.getByRole("link", { name: "Ada profile" })).toHaveAttribute(
      "href",
      "https://example.com/ada",
    );
    expect(
      screen.getByRole("button", { name: "Apply selected fields" }),
    ).toBeDisabled();
  });

  it("applies only checked, edited fields with the current version", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    await runResearch(user);

    const displayName = screen.getByLabelText("Display name suggestion");
    await user.clear(displayName);
    await user.type(displayName, "Augusta Ada King");
    await user.click(
      screen.getByRole("checkbox", { name: "Apply Display name" }),
    );
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        updatePerson: {
          person: { ...person, displayName: "Augusta Ada King", version: 4 },
          code: null,
          currentVersion: null,
          issues: [],
        },
      },
      requestId: "request-update",
    });

    await user.click(
      screen.getByRole("button", { name: "Apply selected fields" }),
    );

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(executeBrowser).toHaveBeenLastCalledWith(UpdatePersonDocument, {
      input: {
        id: person.id,
        expectedVersion: 3,
        displayName: "Augusta Ada King",
      },
    });
  });

  it("lets the reviewer accept all auto-filled fields in one check", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    await runResearch(user);

    const acceptAll = screen.getByRole("checkbox", {
      name: "Accept all suggested fields",
    });
    expect(acceptAll).not.toBeChecked();
    await user.click(acceptAll);

    expect(
      screen.getByRole("checkbox", { name: "Apply Display name" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Apply Biography" }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Apply selected fields" }),
    ).toBeEnabled();

    await user.click(acceptAll);
    expect(
      screen.getByRole("checkbox", { name: "Apply Display name" }),
    ).not.toBeChecked();
  });

  it("preserves edited selections and reports a version conflict", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    await runResearch(user);

    const biography = screen.getByLabelText("Biography suggestion");
    await user.clear(biography);
    await user.type(biography, "Edited research draft");
    await user.click(screen.getByRole("checkbox", { name: "Apply Biography" }));
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        updatePerson: {
          person: null,
          code: "CONFLICT",
          currentVersion: 4,
          issues: [],
        },
      },
      requestId: "request-conflict",
    });

    await user.click(
      screen.getByRole("button", { name: "Apply selected fields" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("CONFLICT");
    expect(screen.getByLabelText("Biography suggestion")).toHaveValue(
      "Edited research draft",
    );
    expect(
      screen.getByRole("checkbox", { name: "Apply Biography" }),
    ).toBeChecked();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the panel usable when a provider request throws", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    executeBrowser.mockRejectedValueOnce(new Error("network unavailable"));

    await user.click(
      screen.getByRole("checkbox", {
        name: /I understand and want to search public web sources/i,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Research this person" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Web research could not be completed.",
    );
    expect(
      screen.getByRole("button", { name: "Research this person" }),
    ).toBeEnabled();
  });
});
