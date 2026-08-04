import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppError from "@/app/(app)/error";
import AppLoading from "@/app/(app)/loading";
import DashboardError from "@/app/(app)/dashboard/error";
import DashboardLoading from "@/app/(app)/dashboard/loading";

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

  it("gives the dashboard one named loading status and a retryable error", () => {
    const loading = render(<DashboardLoading />);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Loading research dashboard",
    );
    loading.unmount();

    const reset = vi.fn();
    render(
      <DashboardError
        error={new Error("secret upstream detail")}
        reset={reset}
      />,
    );
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The research dashboard could not be loaded",
    );
    expect(screen.queryByText("secret upstream detail")).toBeNull();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(reset).toHaveBeenCalledOnce();
  });
});
