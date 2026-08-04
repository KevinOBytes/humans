import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PersonProfile } from "@/components/people/person-profile";
import { personWithContradictoryFacts } from "../fixtures/person";

describe("PersonProfile", () => {
  it("keeps contradictory facts independently visible and marks selection separately", () => {
    render(<PersonProfile person={personWithContradictoryFacts} />);

    expect(
      screen.getAllByRole("article", { name: /date of birth/i }),
    ).toHaveLength(2);
    expect(screen.getByText("Asserted")).toBeVisible();
    expect(screen.getByText("Disputed")).toBeVisible();
    expect(screen.getByText("Selected for presentation")).toBeVisible();
    expect(screen.getAllByText(/confidence/i)).toHaveLength(2);
  });

  it("renders revision provenance and linked evidence without HTML interpretation", () => {
    const unsafe = {
      ...personWithContradictoryFacts,
      facts: personWithContradictoryFacts.facts.map((fact, index) =>
        index === 0 ? { ...fact, value: "<img src=x onerror=alert(1)>" } : fact,
      ),
    };
    const { container } = render(<PersonProfile person={unsafe} />);
    expect(screen.getByText("Source transcription corrected")).toBeVisible();
    expect(screen.getByText("Archive register")).toBeVisible();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
  });
});
