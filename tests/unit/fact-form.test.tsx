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

  it("offers workspace people for person-reference facts and submits the selected ID", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createFact: { fact: { id: "fact-person" }, issues: [], code: null },
      },
      requestId: "request-person",
    });
    const personId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d1";
    render(
      <FactForm
        definitions={[definition("PERSON_REFERENCE")]}
        personId={personId}
        personOptions={[
          { id: personId, displayName: "Ada Lovelace" },
          {
            id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d2",
            displayName: "Grace Hopper",
          },
        ]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Value"), personId);
    await user.click(screen.getByRole("button", { name: "Add fact" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      input: { value: { referencedPersonId: personId } },
    });
  });

  it("submits temporal, confidence, language, and same-person supersession metadata", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createFact: { fact: { id: "fact-new" }, issues: [], code: null },
      },
      requestId: "request-metadata",
    });
    render(
      <FactForm
        definitions={[definition("TEXT")]}
        personId="person-a"
        supersededFactOptions={[
          {
            id: "fact-old",
            label: "Previous biography",
            assertedAt: "2025-01-02T00:00:00.000Z",
          },
        ]}
      />,
    );
    await user.type(screen.getByLabelText("Value"), "Updated source claim");
    await user.selectOptions(
      screen.getByLabelText("Temporal interpretation"),
      "BETWEEN",
    );
    await user.selectOptions(
      screen.getByLabelText("Temporal precision"),
      "RANGE",
    );
    fireEvent.change(screen.getByLabelText("Valid earliest"), {
      target: { value: "2024-01-01T09:30" },
    });
    fireEvent.change(screen.getByLabelText("Valid latest"), {
      target: { value: "2024-01-03T17:45" },
    });
    fireEvent.change(screen.getByLabelText("Observed at"), {
      target: { value: "2024-01-04T12:00" },
    });
    await user.type(screen.getByLabelText("Language"), "en");
    await user.type(
      screen.getByLabelText("Confidence method"),
      "source comparison",
    );
    await user.type(
      screen.getByLabelText("Confidence explanation"),
      "Two independent records agree.",
    );
    expect(
      screen.getByRole("option", { name: /Previous biography/ }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Supersedes an existing claim"),
      "fact-old",
    );
    await user.click(screen.getByRole("button", { name: "Add fact" }));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      input: {
        value: { text: "Updated source claim" },
        temporalSemantics: "BETWEEN",
        temporalPrecision: "RANGE",
        validEarliestAt: "2024-01-01T09:30:00.000Z",
        validLatestAt: "2024-01-03T17:45:00.000Z",
        observedAt: "2024-01-04T12:00:00.000Z",
        language: "en",
        confidenceMethod: "source comparison",
        confidenceExplanation: "Two independent records agree.",
        supersedesFactId: "fact-old",
      },
    });
  });

  it("preserves the draft and blocks an invalid validity range", async () => {
    const user = userEvent.setup();
    render(<FactForm definitions={[definition("TEXT")]} personId="person-a" />);
    await user.type(screen.getByLabelText("Value"), "Keep this draft");
    fireEvent.change(screen.getByLabelText("Valid earliest"), {
      target: { value: "2025-01-03T00:00" },
    });
    fireEvent.change(screen.getByLabelText("Valid latest"), {
      target: { value: "2025-01-02T00:00" },
    });

    await user.click(screen.getByRole("button", { name: "Add fact" }));

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Value")).toHaveValue("Keep this draft");
    expect(screen.getByLabelText("Valid earliest")).toHaveValue(
      "2025-01-03T00:00",
    );
    expect(screen.getByLabelText("Valid latest")).toHaveValue(
      "2025-01-02T00:00",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Earliest validity must be before latest validity",
    );
  });

  it("blocks incompatible temporal semantics before submitting", async () => {
    const user = userEvent.setup();
    render(<FactForm definitions={[definition("TEXT")]} personId="person-a" />);
    await user.type(screen.getByLabelText("Value"), "Keep this draft");
    await user.selectOptions(
      screen.getByLabelText("Temporal interpretation"),
      "BETWEEN",
    );
    await user.selectOptions(
      screen.getByLabelText("Temporal precision"),
      "DAY",
    );
    fireEvent.change(screen.getByLabelText("Valid earliest"), {
      target: { value: "2025-01-01T00:00" },
    });
    fireEvent.change(screen.getByLabelText("Valid latest"), {
      target: { value: "2025-01-02T00:00" },
    });

    await user.click(screen.getByRole("button", { name: "Add fact" }));

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Value")).toHaveValue("Keep this draft");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "compatible temporal bounds and precision",
    );
  });

  it("does not expose a self-approval control for new facts", () => {
    render(<FactForm definitions={[definition("TEXT")]} personId="person-a" />);

    expect(screen.queryByLabelText(/review state/i)).not.toBeInTheDocument();
    expect(screen.getByText(/start unreviewed/i)).toBeInTheDocument();
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
