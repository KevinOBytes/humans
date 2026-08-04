import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PersonCreateForm } from "@/components/people/person-create-form";

const execute = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("PersonCreateForm", () => {
  beforeEach(() => {
    execute.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  it("preserves transport error code and request ID", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: false,
      errors: [
        {
          code: "UNAUTHENTICATED",
          message: "Your session has expired.",
          requestId: "request-person-transport",
        },
      ],
    });
    render(<PersonCreateForm />);

    await user.type(screen.getByLabelText("Display name"), "Ada Researcher");
    await user.click(screen.getByRole("button", { name: "Create person" }));

    const alert = await screen.findByRole("alert", {
      name: "Fix form errors",
    });
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent("UNAUTHENTICATED");
    expect(alert).toHaveTextContent("request-person-transport");
    expect(alert).toHaveTextContent("Your session has expired.");
    expect(screen.getByLabelText("Display name")).toHaveValue("Ada Researcher");
  });

  it("preserves successful-response payload metadata and typed issues", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createPerson: {
          person: null,
          code: "CONFLICT",
          currentVersion: 8,
          issues: [
            {
              code: "DISPLAY_NAME_CONFLICT",
              message: "That display name changed elsewhere.",
              path: ["input", "displayName"],
            },
          ],
        },
      },
      requestId: "request-person-payload",
    });
    render(<PersonCreateForm />);

    await user.type(screen.getByLabelText("Display name"), "Ada Researcher");
    await user.click(screen.getByRole("button", { name: "Create person" }));

    const alert = await screen.findByRole("alert", {
      name: "Fix form errors",
    });
    expect(alert).toHaveTextContent("CONFLICT");
    expect(alert).toHaveTextContent("request-person-payload");
    expect(alert).toHaveTextContent("current version 8");
    expect(screen.getByLabelText("Display name")).toHaveAttribute(
      "aria-describedby",
      "displayName-error",
    );
    expect(document.getElementById("displayName-error")).toHaveTextContent(
      "That display name changed elsewhere.",
    );
  });
});
