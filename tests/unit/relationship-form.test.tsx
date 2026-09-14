import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RelationshipForm } from "@/components/relationships/relationship-form";
import { CreateRelationshipDocument } from "@/graphql/generated/graphql";

const execute = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("RelationshipForm", () => {
  beforeEach(() => execute.mockReset());

  it("defaults new relationships to an analyst hypothesis and does not offer unsupported documentation", () => {
    render(
      <RelationshipForm
        people={[{ id: "person-b", name: "Grace Collaborator" }]}
        relationshipTypes={[{ id: "type-a", label: "Knows" }]}
        sourcePersonId="person-a"
      />,
    );

    expect(screen.getByLabelText("Evidence status")).toHaveValue(
      "ANALYST_HYPOTHESIS",
    );
    expect(
      screen
        .getByLabelText("Evidence status")
        .querySelector('option[value="DOCUMENTED"]'),
    ).toBeNull();
  });

  it("submits bounded temporal and provenance fields through the generated operation", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createRelationship: {
          relationship: { id: "relationship-a" },
          code: null,
          currentVersion: null,
          issues: [],
        },
      },
      requestId: "request-created",
    });
    render(
      <RelationshipForm
        people={[{ id: "person-b", name: "Grace Collaborator" }]}
        relationshipTypes={[{ id: "type-a", label: "Knows" }]}
        sourcePersonId="person-a"
      />,
    );

    await user.selectOptions(screen.getByLabelText("Claim state"), "INFERRED");
    await user.selectOptions(
      screen.getByLabelText("Evidence status"),
      "ANALYST_HYPOTHESIS",
    );
    await user.clear(screen.getByLabelText("Confidence"));
    await user.type(screen.getByLabelText("Confidence"), "0.72");
    await user.type(screen.getByLabelText("Strength (optional)"), "0.35");
    await user.selectOptions(
      screen.getByLabelText("Temporal meaning"),
      "APPROXIMATE",
    );
    await user.selectOptions(screen.getByLabelText("Date precision"), "YEAR");
    await user.type(screen.getByLabelText("Valid from"), "2012-01-01");
    await user.type(screen.getByLabelText("Valid until"), "2014-12-31");
    await user.type(screen.getByLabelText("Observed on"), "2026-09-12");
    await user.selectOptions(screen.getByLabelText("Origin"), "IMPORT");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    expect(execute).toHaveBeenCalledWith(CreateRelationshipDocument, {
      input: {
        confidence: 0.72,
        strength: 0.35,
        creationMethod: "import",
        explicitConfirmed: true,
        epistemicStatus: "ANALYST_HYPOTHESIS",
        governancePurpose: "research",
        observedAt: "2026-09-12T00:00:00.000Z",
        relationshipTypeId: "type-a",
        sensitivity: "INTERNAL",
        sourcePersonId: "person-a",
        state: "inferred",
        targetPersonId: "person-b",
        temporalPrecision: "YEAR",
        temporalSemantics: "APPROXIMATE",
        validFrom: "2012-01-01T00:00:00.000Z",
        validUntil: "2014-12-31T00:00:00.000Z",
      },
    });
    expect(
      screen.getByLabelText("Origin").querySelector('option[value="AI"]'),
    ).toBeNull();
  });

  it.each([
    ["", null],
    ["0", 0],
  ])(
    "preserves an unknown or zero strength (%s) without borrowing confidence",
    async (draft, expected) => {
      const user = userEvent.setup();
      execute.mockResolvedValue({
        ok: false,
        errors: [{ code: "CONFLICT", message: "Retry after review." }],
      });
      render(
        <RelationshipForm
          people={[{ id: "person-b", name: "Grace Collaborator" }]}
          relationshipTypes={[{ id: "type-a", label: "Knows" }]}
          sourcePersonId="person-a"
        />,
      );
      const strength = screen.getByLabelText("Strength (optional)");
      if (draft) await user.type(strength, draft);
      await user.click(screen.getByRole("checkbox"));
      await user.click(
        screen.getByRole("button", { name: "Add relationship" }),
      );
      expect(execute).toHaveBeenCalledWith(
        CreateRelationshipDocument,
        expect.objectContaining({
          input: expect.objectContaining({ strength: expected, confidence: 1 }),
        }),
      );
      expect(strength).toHaveValue(draft === "" ? null : 0);
      expect(strength).toHaveAccessibleDescription(/not confidence/);
    },
  );

  it.each(["-0.1", "1.1"])(
    "rejects out-of-range strength %s before sending",
    async (value) => {
      const user = userEvent.setup();
      render(
        <RelationshipForm
          people={[{ id: "person-b", name: "Grace Collaborator" }]}
          relationshipTypes={[{ id: "type-a", label: "Knows" }]}
          sourcePersonId="person-a"
        />,
      );
      await user.type(screen.getByLabelText("Strength (optional)"), value);
      await user.click(screen.getByRole("checkbox"));
      await user.click(
        screen.getByRole("button", { name: "Add relationship" }),
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("associates server strength validation with its retained draft", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createRelationship: {
          relationship: null,
          code: "VALIDATION_FAILED",
          currentVersion: null,
          issues: [
            {
              code: "INVALID_VALUE",
              message: "Review the relationship strength.",
              path: ["strength"],
            },
          ],
        },
      },
      requestId: "strength-validation",
    });
    render(
      <RelationshipForm
        people={[{ id: "person-b", name: "Grace Collaborator" }]}
        relationshipTypes={[{ id: "type-a", label: "Knows" }]}
        sourcePersonId="person-a"
      />,
    );
    const strength = screen.getByLabelText("Strength (optional)");
    await user.type(strength, "0.125");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add relationship" }));
    expect(strength).toHaveValue(0.125);
    expect(strength).toHaveAttribute("aria-invalid", "true");
    expect(strength).toHaveAccessibleDescription(
      /Review the relationship strength/,
    );
  });

  it("keeps the temporal draft and confirmation after a transport validation failure", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: false,
      errors: [{ code: "VALIDATION_FAILED", message: "Invalid interval." }],
    });
    render(
      <RelationshipForm
        people={[{ id: "person-b", name: "Grace Collaborator" }]}
        relationshipTypes={[{ id: "type-a", label: "Knows" }]}
        sourcePersonId="person-a"
      />,
    );
    await user.type(screen.getByLabelText("Valid from"), "2030-01-01");
    await user.type(screen.getByLabelText("Valid until"), "2029-01-01");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid interval.",
    );
    expect(screen.getByLabelText("Valid from")).toHaveValue("2030-01-01");
    expect(screen.getByLabelText("Valid until")).toHaveValue("2029-01-01");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("canonicalizes year-only bounds to the complete UTC year", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createRelationship: {
          relationship: { id: "relationship-year" },
          code: null,
          currentVersion: null,
          issues: [],
        },
      },
      requestId: "request-year",
    });
    render(
      <RelationshipForm
        people={[{ id: "person-b", name: "Grace Collaborator" }]}
        relationshipTypes={[{ id: "type-a", label: "Knows" }]}
        sourcePersonId="person-a"
      />,
    );
    await user.selectOptions(
      screen.getByLabelText("Temporal meaning"),
      "YEAR_ONLY",
    );
    await user.selectOptions(screen.getByLabelText("Date precision"), "YEAR");
    await user.type(screen.getByLabelText("Valid from"), "1840-01-01");
    await user.type(screen.getByLabelText("Valid until"), "1840-12-31");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    expect(execute).toHaveBeenCalledWith(
      CreateRelationshipDocument,
      expect.objectContaining({
        input: expect.objectContaining({
          temporalPrecision: "YEAR",
          temporalSemantics: "YEAR_ONLY",
          validFrom: "1840-01-01T00:00:00.000Z",
          validUntil: "1840-12-31T23:59:59.999Z",
        }),
      }),
    );
  });

  it("maps typed payload issues and request IDs to the related-person field", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createRelationship: {
          relationship: null,
          code: "VALIDATION_FAILED",
          currentVersion: null,
          issues: [
            {
              code: "INVALID_TARGET",
              message: "Choose another visible person.",
              path: ["input", "targetPersonId"],
            },
          ],
        },
      },
      requestId: "request-relationship",
    });
    render(
      <RelationshipForm
        people={[{ id: "person-b", name: "Grace Collaborator" }]}
        relationshipTypes={[{ id: "type-a", label: "Knows" }]}
        sourcePersonId="person-a"
      />,
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "request-relationship",
    );
    expect(screen.getByLabelText("Related person")).toHaveAttribute(
      "aria-describedby",
      "relationship-target-error",
    );
    expect(screen.getByLabelText("Related person")).toHaveValue("person-b");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
