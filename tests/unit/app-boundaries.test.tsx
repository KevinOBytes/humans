import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppError from "@/app/(app)/error";
import AppLoading from "@/app/(app)/loading";

describe("protected app boundaries", () => {
  it("does not nest a second main landmark in loading or error children", () => {
    const loading = render(<AppLoading />);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Loading research workspace",
    );
    loading.unmount();

    render(<AppError error={new Error("failed")} reset={vi.fn()} />);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This research view could not be loaded",
    );
  });
});
