import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportWizard } from "@/components/imports/import-wizard";

const execute = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));
vi.mock("@/components/files/upload-panel", () => ({
  UploadPanel: () => <div>Upload fixture</div>,
}));

describe("ImportWizard mapping controls", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
    execute.mockResolvedValue({
      ok: true,
      data: {
        saveImportMapping: {
          issues: [],
          mapping: {
            id: "018f0000-0000-7000-8000-000000000101",
            name: "People import",
            format: "CSV",
            definition: {},
            version: 1,
          },
        },
      },
    });
  });

  it("submits the expanded person fields and typed fact mapping", async () => {
    const user = userEvent.setup();
    render(<ImportWizard initialMappings={[]} />);

    await user.type(screen.getByLabelText(/Biography source/), "biography");
    await user.type(
      screen.getByLabelText(/Preferred name source/),
      "preferred_name",
    );
    await user.type(screen.getByLabelText(/Sort name source/), "sort_name");
    await user.type(
      screen.getByLabelText(/Fact definition UUID/),
      "018f0000-0000-7000-8000-000000000201",
    );
    await user.type(screen.getByLabelText(/Fact value source/), "birth_date");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({
      input: {
        name: "People import",
        format: "CSV",
        definition: {
          version: 1,
          recordKind: "PERSON",
          rowKeySource: "external_id",
          person: {
            displayNameSource: "name",
            primaryNameKind: "legal",
            fields: [
              { field: "biography", source: "biography" },
              { field: "preferredName", source: "preferred_name" },
              { field: "sortName", source: "sort_name" },
            ],
          },
          facts: [
            {
              definitionId: "018f0000-0000-7000-8000-000000000201",
              source: "birth_date",
            },
          ],
          defaults: { sensitivity: "internal", status: "active" },
        },
      },
    });
    expect(
      await screen.findByText(
        "Mapping saved. You can now prepare the preview.",
      ),
    ).toBeInTheDocument();
  });

  it("submits relationship endpoints including a prior-import external key", async () => {
    const user = userEvent.setup();
    render(<ImportWizard initialMappings={[]} />);

    await user.selectOptions(
      screen.getByLabelText("Record kind"),
      "RELATIONSHIP",
    );
    await user.type(
      screen.getByLabelText("Relationship type UUID"),
      "018f0000-0000-7000-8000-000000000301",
    );
    await user.selectOptions(
      screen.getByLabelText("Source endpoint kind"),
      "EXTERNAL_KEY",
    );
    await user.type(
      screen.getByLabelText("Source person import UUID"),
      "018f0000-0000-7000-8000-000000000302",
    );
    await user.type(
      screen.getByLabelText(/Relationship label source/),
      "relationship_label",
    );
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(execute.mock.calls[0]?.[1]).toEqual({
      input: {
        name: "People import",
        format: "CSV",
        definition: {
          version: 1,
          recordKind: "RELATIONSHIP",
          rowKeySource: "external_id",
          relationship: {
            typeId: "018f0000-0000-7000-8000-000000000301",
            sourcePerson: {
              kind: "EXTERNAL_KEY",
              personImportId: "018f0000-0000-7000-8000-000000000302",
              source: "source_person_id",
            },
            targetPerson: {
              kind: "PERSON_ID",
              source: "target_person_id",
            },
            fields: [{ field: "labelOverride", source: "relationship_label" }],
          },
          defaults: { sensitivity: "internal", state: "asserted" },
        },
      },
    });
  });
});
