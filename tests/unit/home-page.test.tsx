import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("home page", () => {
  it("identifies the product and its purpose", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", {
        name: "Map the people, claims, and sources behind a story.",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/connect people, facts, relationships, and evidence/i),
    ).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: /sign in/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /open the graph workspace/i }),
    ).toHaveAttribute("href", "/graph");
  });
});
