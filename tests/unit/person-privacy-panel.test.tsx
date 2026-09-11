import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PersonPrivacyPanel } from "@/components/people/person-privacy-panel";
import {
  PrivacyRetentionDocument,
  PrivacyRequestDocument,
} from "@/graphql/generated/graphql";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL: execute }));
beforeEach(() => execute.mockReset());
const personId = "018f0000-0000-7000-8000-000000000001";

it("requests person-scoped retention/hold metadata without exposing authority details", async () => {
  const user = userEvent.setup();
  execute.mockResolvedValue({
    ok: true,
    data: {
      retentionDecision: {
        state: "hold",
        reason: "LEGAL_HOLD",
        policyId: null,
      },
      privacyLegalHolds: [
        {
          id: "hold-a",
          state: "active",
          version: 2,
          auditReference: null,
          authority: "PRIVATE AUTHORITY",
        },
      ],
    },
  });
  render(<PersonPrivacyPanel personId={personId} />);
  await user.click(
    screen.getByRole("button", { name: "Load privacy posture" }),
  );
  expect(execute).toHaveBeenCalledWith(PrivacyRetentionDocument, {
    resourceKind: "PERSON",
    resourceId: personId,
    first: 25,
  });
  expect(await screen.findByText("active")).toBeInTheDocument();
  expect(screen.queryByText("PRIVATE AUTHORITY")).toBeNull();
});

it("clears stale request details on edits and masks lookup failures", async () => {
  const user = userEvent.setup();
  const id = "018f0000-0000-7000-8000-000000000005";
  execute
    .mockResolvedValueOnce({
      ok: true,
      data: {
        privacyRequest: {
          id,
          requestType: "DELETION",
          state: "reviewing",
          version: 1,
          dueAt: "2026-10-01T00:00:00Z",
          executeAfter: "2026-10-01T00:00:00Z",
          completedAt: null,
          auditReference: null,
        },
        privacyProcessorPropagations: [],
      },
    })
    .mockResolvedValueOnce({
      ok: false,
      errors: [{ message: "SECRET REQUEST DETAILS" }],
    });
  render(<PersonPrivacyPanel personId={personId} />);
  await user.type(screen.getByLabelText("Privacy request ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up request" }));
  expect(execute).toHaveBeenCalledWith(PrivacyRequestDocument, { id });
  expect(await screen.findByText("DELETION")).toBeInTheDocument();
  await user.clear(screen.getByLabelText("Privacy request ID"));
  expect(screen.queryByText("DELETION")).toBeNull();
  await user.type(screen.getByLabelText("Privacy request ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up request" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Privacy request is unavailable",
  );
  expect(screen.queryByText("SECRET REQUEST DETAILS")).toBeNull();
});
