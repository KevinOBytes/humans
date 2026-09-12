import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PersonPrivacyPanel } from "@/components/people/person-privacy-panel";
import {
  CreatePrivacyRequestDocument,
  PrivacyRetentionDocument,
  PrivacyRequestDocument,
} from "@/graphql/generated/graphql";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL: execute }));
beforeEach(() => execute.mockReset());
const personId = "018f0000-0000-7000-8000-000000000001";

it("creates a person-scoped privacy request with an explicit purpose and deadline", async () => {
  const user = userEvent.setup();
  const request = {
    id: "018f0000-0000-7000-8000-000000000006",
    requestType: "ACCESS",
    state: "requested",
    version: 1,
    dueAt: "2030-01-15T23:59:59.000Z",
    executeAfter: "2029-12-15T00:00:00.000Z",
    completedAt: null,
    auditReference: null,
  };
  execute.mockResolvedValue({
    ok: true,
    data: { createPrivacyRequest: request },
  });
  render(<PersonPrivacyPanel personId={personId} />);

  await user.selectOptions(screen.getByLabelText("Request type"), "ACCESS");
  await user.type(
    screen.getByLabelText("Purpose"),
    "Respond to a subject access request",
  );
  await user.clear(screen.getByLabelText("Due date"));
  await user.type(screen.getByLabelText("Due date"), "2030-01-15");
  await user.click(
    screen.getByRole("button", { name: "Create privacy request" }),
  );

  expect(execute).toHaveBeenCalledWith(
    CreatePrivacyRequestDocument,
    expect.objectContaining({
      input: expect.objectContaining({
        requestType: "ACCESS",
        personIds: [personId],
        purpose: "Respond to a subject access request",
        dueAt: "2030-01-15T23:59:59.000Z",
      }),
    }),
  );
  const variables = execute.mock.calls[0]?.[1] as {
    input: { idempotencyKey?: string };
  };
  expect(variables.input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await screen.findByRole("status")).toHaveTextContent(request.id);
});

it("does not disclose provider or server details when request creation fails", async () => {
  const user = userEvent.setup();
  execute.mockResolvedValue({
    ok: false,
    errors: [{ message: "private database details" }],
  });
  render(<PersonPrivacyPanel personId={personId} />);
  await user.type(screen.getByLabelText("Purpose"), "Subject access review");
  await user.click(
    screen.getByRole("button", { name: "Create privacy request" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Privacy request could not be created",
  );
  expect(screen.queryByText("private database details")).toBeNull();
});

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
