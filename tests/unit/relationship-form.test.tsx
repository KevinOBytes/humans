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
    await user.clear(screen.getByLabelText("Confidence"));
    await user.type(screen.getByLabelText("Confidence"), "0.72");
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
        creationMethod: "import",
        explicitConfirmed: true,
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
