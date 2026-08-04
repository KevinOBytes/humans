import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("home page", () => {
  it("identifies the product and its purpose", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Humans" })).toBeVisible();
    expect(screen.getByText(/evidence-backed social networks/i)).toBeVisible();
  });
});
