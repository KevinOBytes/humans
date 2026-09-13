import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import { PersonIdentifierEditor } from "@/components/people/person-identifier-editor";
import {
  CreatePersonIdentifierDocument,
  UpdatePersonIdentifierDocument,
  ArchivePersonIdentifierDocument,
  type PersonIdentifierSummaryFragment,
} from "@/graphql/generated/graphql";
const identifier: PersonIdentifierSummaryFragment = {
  id: "019fe224-a0cd-76e4-92ac-9d28795c2cca",
  personId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
  namespace: "registry",
  identifierType: "profile",
  issuer: "Synthetic registry",
  validFrom: null,
  validUntil: null,
  sensitivity: "CONFIDENTIAL",
  verificationState: "UNVERIFIED",
  value: null,
  redacted: true,
  version: 3,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};
describe("identifier profile controls", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
  });
  it("creates through a generated operation and preserves the retry key after a transport failure", async () => {
    const user = userEvent.setup();
    execute.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      ok: true,
      data: {
        createPersonIdentifier: {
          identifier: { id: identifier.id },
          issues: [],
          code: null,
        },
      },
    });
    render(
      <PersonIdentifierEditor
        personId={identifier.personId}
        canUpdate
        canDelete={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add identifier" }));
    await user.type(screen.getByLabelText("Namespace"), "registry");
    await user.type(screen.getByLabelText("Identifier type"), "profile");
    await user.type(screen.getByLabelText("Value"), "Synthetic-42");
    await user.click(screen.getByRole("button", { name: "Save identifier" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save identifier" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]![0]).toBe(CreatePersonIdentifierDocument);
    expect(execute.mock.calls[1]![1]).toEqual(execute.mock.calls[0]![1]);
    expect(execute.mock.calls[0]![1].input).toMatchObject({
      sensitivity: "INTERNAL",
      value: "Synthetic-42",
      idempotencyKey: expect.any(String),
    });
  });
  it("edits protected metadata without retrieving or submitting an existing value", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        updatePersonIdentifier: {
          identifier: { id: identifier.id },
          code: null,
          issues: [],
        },
      },
    });
    render(
      <PersonIdentifierEditor
        personId={identifier.personId}
        identifier={identifier}
        canUpdate
        canDelete
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Edit profile identifier" }),
    );
    expect(screen.getByLabelText("Replacement value")).toHaveValue("");
    await user.type(screen.getByLabelText("Issuer"), " edited");
    await user.click(screen.getByRole("button", { name: "Save identifier" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]![0]).toBe(UpdatePersonIdentifierDocument);
    expect(execute.mock.calls[0]![1].input).toMatchObject({
      id: identifier.id,
      expectedVersion: 3,
      issuer: "Synthetic registry edited",
    });
    expect(execute.mock.calls[0]![1].input).not.toHaveProperty("value");
  });
  it("archives with an optimistic version and surfaces a conflict without a refresh", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: false,
      errors: [{ code: "CONFLICT", requestId: "identifier-conflict" }],
    });
    render(
      <PersonIdentifierEditor
        personId={identifier.personId}
        identifier={identifier}
        canUpdate={false}
        canDelete
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Archive profile identifier" }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]![0]).toBe(ArchivePersonIdentifierDocument);
    expect(execute.mock.calls[0]![1].input).toMatchObject({
      id: identifier.id,
      expectedVersion: 3,
      idempotencyKey: expect.any(String),
    });
  });
  it("does not show mutation controls to a read-only viewer", () => {
    render(
      <PersonIdentifierEditor
        personId={identifier.personId}
        identifier={identifier}
        canUpdate={false}
        canDelete={false}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
