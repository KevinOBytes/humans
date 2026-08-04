import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PersonForm,
  type PersonFormResult,
} from "@/components/people/person-form";

describe("PersonForm", () => {
  it("maps payload issues to a focused summary and preserves the draft", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({
      code: "VALIDATION_FAILED",
      requestId: "request-person-validation",
      issues: [
        {
          code: "INVALID",
          message: "Display name is required.",
          path: ["displayName"],
        },
      ],
      person: null,
    });
    render(<PersonForm submit={submit} />);

    await user.type(screen.getByLabelText("Display name"), "   ");
    await user.type(screen.getByLabelText("Biography"), "Draft biography");
    await user.click(screen.getByRole("button", { name: "Create person" }));

    const summary = await screen.findByRole("alert", {
      name: "Fix form errors",
    });
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent("VALIDATION_FAILED");
    expect(summary).toHaveTextContent("request-person-validation");
    expect(screen.getByLabelText("Biography")).toHaveValue("Draft biography");
    expect(screen.getByLabelText("Display name")).toHaveAttribute(
      "aria-describedby",
      "displayName-error",
    );
  });

  it("prevents duplicate submissions and navigates only after success", async () => {
    const user = userEvent.setup();
    let resolve!: (value: PersonFormResult) => void;
    const submit = vi.fn(
      () => new Promise<PersonFormResult>((next) => (resolve = next)),
    );
    const onSaved = vi.fn();
    render(<PersonForm submit={submit} onSaved={onSaved} />);
    await user.type(screen.getByLabelText("Display name"), "Ada Researcher");

    const button = screen.getByRole("button", { name: "Create person" });
    await user.click(button);
    expect(button).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);
    resolve({ person: { id: "person-a", version: 1 }, issues: [], code: null });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("person-a"));
  });

  it("shows a reload action for optimistic conflicts", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    render(
      <PersonForm
        initial={{ displayName: "Ada Researcher" }}
        submit={vi.fn().mockResolvedValue({
          code: "CONFLICT",
          currentVersion: 4,
          issues: [],
          person: null,
        })}
        onReload={onReload}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create person" }));
    await user.click(
      await screen.findByRole("button", { name: "Reload current data" }),
    );
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("associates every field issue with its control", async () => {
    const user = userEvent.setup();
    render(
      <PersonForm
        submit={vi.fn().mockResolvedValue({
          code: "VALIDATION_FAILED",
          currentVersion: null,
          issues: [
            "preferredName",
            "sortName",
            "biography",
            "status",
            "sensitivity",
          ].map((field) => ({
            code: "INVALID",
            message: `${field} is invalid.`,
            path: [field],
          })),
          person: null,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create person" }));
    for (const [label, id] of [
      ["Preferred name", "preferredName"],
      ["Sort name", "sortName"],
      ["Biography", "biography"],
      ["Status", "status"],
      ["Sensitivity", "sensitivity"],
    ] as const) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-describedby",
        `${id}-error`,
      );
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    }
  });
});
