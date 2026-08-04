import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  MutationFeedback,
  fieldMutationIssue,
  mutationFeedback,
} from "@/components/research/mutation-feedback";

describe("MutationFeedback", () => {
  it("preserves payload codes, request IDs, and field-level issues", () => {
    const feedback = mutationFeedback({
      code: "VALIDATION_FAILED",
      currentVersion: null,
      fallback: "The fact could not be saved.",
      issues: [
        {
          code: "INVALID_FACT_VALUE",
          message: "The end date must follow the start date.",
          path: ["input", "value", "dateEnd"],
        },
      ],
      requestId: "request-123",
    });

    expect(fieldMutationIssue(feedback, "dateEnd")?.code).toBe(
      "INVALID_FACT_VALUE",
    );
    render(<MutationFeedback feedback={feedback} title="Fact not saved" />);
    expect(screen.getByRole("alert")).toHaveTextContent("VALIDATION_FAILED");
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("request-123");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The end date must follow the start date.",
    );
  });

  it("offers an explicit reload for optimistic conflicts", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    render(
      <MutationFeedback
        feedback={mutationFeedback({
          code: "CONFLICT",
          currentVersion: 7,
          fallback: "Selection not changed.",
          issues: [],
          requestId: "request-456",
        })}
        onReload={onReload}
        title="Selection not changed"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Reload current data" }),
    );
    expect(onReload).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("current version 7");
  });
});
