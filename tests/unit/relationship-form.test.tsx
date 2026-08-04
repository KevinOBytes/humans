import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RelationshipForm } from "@/components/relationships/relationship-form";

const execute = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("RelationshipForm", () => {
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
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "request-relationship",
    );
    expect(screen.getByLabelText("Related person")).toHaveAttribute(
      "aria-describedby",
      "relationship-target-error",
    );
  });
});
