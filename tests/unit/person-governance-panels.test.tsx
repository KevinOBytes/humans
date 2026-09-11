import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PersonGovernancePanels } from "@/components/people/person-governance-panels";
import { ConsentCoverageDocument } from "@/graphql/generated/graphql";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL: execute }));
beforeEach(() => execute.mockReset());

it("requires explicit purpose and clears stale coverage when purpose changes", async () => {
  const user = userEvent.setup();
  execute.mockResolvedValue({
    ok: true,
    data: { consentCoverage: { allowed: true, reason: "COVERED" } },
  });
  render(
    <PersonGovernancePanels personId="018f0000-0000-7000-8000-000000000001" />,
  );
  expect(screen.getByRole("button", { name: "Check coverage" })).toBeDisabled();
  await user.type(
    screen.getByLabelText("Research purpose"),
    "Fictional archive review",
  );
  await user.click(screen.getByRole("button", { name: "Check coverage" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Covered for this request",
  );
  expect(execute).toHaveBeenCalledWith(
    ConsentCoverageDocument,
    expect.objectContaining({
      purpose: "Fictional archive review",
      scope: "READ",
    }),
  );
  await user.type(screen.getByLabelText("Research purpose"), " changed");
  expect(screen.queryByText(/Covered for this request/)).toBeNull();
});

it("shows a bounded withdrawal explanation and never echoes server error values", async () => {
  const user = userEvent.setup();
  execute
    .mockResolvedValueOnce({
      ok: true,
      data: { consentCoverage: { allowed: false, reason: "WITHDRAWN" } },
    })
    .mockResolvedValueOnce({
      ok: false,
      errors: [{ message: "RESTRICTED RAW VALUE" }],
    });
  render(
    <PersonGovernancePanels personId="018f0000-0000-7000-8000-000000000001" />,
  );
  await user.type(
    screen.getByLabelText("Research purpose"),
    "Fictional archive review",
  );
  await user.click(screen.getByRole("button", { name: "Check coverage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/withdrawn/i);
  expect(
    screen.getByRole("link", { name: "Consent and purpose administration" }),
  ).toHaveAttribute("href", "/settings/policies");
  await user.click(screen.getByRole("button", { name: "Check coverage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Coverage could not be verified",
  );
  expect(screen.queryByText("RESTRICTED RAW VALUE")).toBeNull();
});
