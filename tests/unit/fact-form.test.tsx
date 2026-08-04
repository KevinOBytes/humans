import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FactForm,
  FactSelectionButton,
  type FactDefinitionOption,
} from "@/components/facts/fact-form";

const refresh = vi.fn();
const execute = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

function definition(valueType: FactDefinitionOption["valueType"]) {
  return {
    id: `definition-${valueType}`,
    label: valueType,
    sensitivity: "INTERNAL" as const,
    valueType,
  };
}

describe("FactForm", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
  });

  it("keeps invalid JSON as a draft and never submits it", async () => {
    const user = userEvent.setup();
    render(<FactForm definitions={[definition("JSON")]} personId="person-a" />);
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: '{"open":' },
    });

    await user.click(screen.getByRole("button", { name: "Add fact" }));

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Value")).toHaveValue('{"open":');
    expect(screen.getByRole("alert")).toHaveTextContent("Enter valid JSON");
  });

  it("submits both bounds for a valid date range", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: { createFact: { fact: { id: "fact-a" }, issues: [], code: null } },
      requestId: "request-date",
    });
    render(
      <FactForm definitions={[definition("DATE_RANGE")]} personId="person-a" />,
    );
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "1815-12-10" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "1815-12-12" },
    });

    await user.click(screen.getByRole("button", { name: "Add fact" }));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      input: { value: { dateStart: "1815-12-10", dateEnd: "1815-12-12" } },
    });
  });

  it("maps a literal payload issue and request ID to the value control", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createFact: {
          fact: null,
          code: "VALIDATION_FAILED",
          currentVersion: null,
          issues: [
            {
              code: "INVALID_FACT_VALUE",
              message: "The value is not permitted.",
              path: ["input", "value", "text"],
            },
          ],
        },
      },
      requestId: "request-fact-issue",
    });
    render(<FactForm definitions={[definition("TEXT")]} personId="person-a" />);
    await user.type(screen.getByLabelText("Value"), "draft value");
    await user.click(screen.getByRole("button", { name: "Add fact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "request-fact-issue",
    );
    expect(screen.getByLabelText("Value")).toHaveValue("draft value");
    expect(screen.getByLabelText("Value")).toHaveAttribute(
      "aria-describedby",
      "fact-value-error",
    );
  });

  it("shows reload recovery for a real selection conflict payload", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    execute.mockResolvedValue({
      ok: true,
      data: {
        selectPersonField: {
          selection: null,
          code: "CONFLICT",
          currentVersion: 9,
          issues: [],
        },
      },
      requestId: "request-selection-conflict",
    });
    render(
      <FactSelectionButton
        factId="fact-a"
        fieldKey="date_of_birth"
        namespace="person"
        personId="person-a"
        selected={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Select for presentation" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "request-selection-conflict",
    );
    await user.click(
      screen.getByRole("button", { name: "Reload current data" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
});
