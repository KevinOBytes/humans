import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PeopleTable } from "@/components/people/people-table";

const person = {
  id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d0",
  displayName: "Ada Researcher",
  preferredName: "Ada",
  status: "ACTIVE",
  sensitivity: "INTERNAL",
  updatedAt: "2026-07-31T13:00:00.000Z",
  version: 2,
};

describe("PeopleTable", () => {
  it("renders a semantic, captioned table and cursor pagination", () => {
    render(
      <PeopleTable
        people={[person]}
        hasFilters={false}
        nextHref="/people?after=opaque-cursor"
      />,
    );
    const table = screen.getByRole("table", {
      name: "People in this workspace",
    });
    expect(table).toBeVisible();
    for (const header of ["Name", "Status", "Sensitivity", "Updated", "Open"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeVisible();
    }
    expect(
      screen.getByRole("link", { name: "Open Ada Researcher" }),
    ).toHaveAttribute("href", `/people/${person.id}`);
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/people?after=opaque-cursor",
    );
  });

  it("distinguishes an empty workspace from empty filtered results", () => {
    const { rerender } = render(
      <PeopleTable people={[]} hasFilters={false} nextHref={null} />,
    );
    expect(screen.getByText(/no people have been added/i)).toBeVisible();

    rerender(<PeopleTable people={[]} hasFilters nextHref={null} />);
    expect(screen.getByText(/no people match these filters/i)).toBeVisible();
  });
});
