import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserGraphQL = vi.hoisted(() => ({ execute: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: browserGraphQL.execute,
}));

import { ApiKeyAdministration } from "@/components/settings/api-key-administration";

describe("API-key administration", () => {
  beforeEach(() => {
    browserGraphQL.execute.mockReset();
    router.refresh.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a newly-created plaintext key only in transient client state", async () => {
    const user = userEvent.setup();
    browserGraphQL.execute.mockResolvedValue({
      ok: true,
      data: {
        createOrganizationApiKey: {
          actionId: "ak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          code: "APPLIED",
          requestId: "019893aa-99a0-7000-8000-000000000001",
          secret: "hum_plaintext-returned-once",
        },
      },
    });

    render(
      <ApiKeyAdministration
        allowedScopes={["person:read", "fact:read"]}
        apiKeys={[]}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Export worker");
    await user.click(screen.getByRole("button", { name: "Create API key" }));

    expect(screen.getByText("Save this API key now")).toBeVisible();
    expect(screen.getByLabelText("New API key")).toHaveValue(
      "hum_plaintext-returned-once",
    );
    expect(screen.getByText(/shown only once/u)).toBeVisible();
    expect(router.refresh).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "I saved it" }));
    expect(screen.queryByLabelText("New API key")).toBeNull();
  });

  it("sends a durable idempotency key when revoking an API key", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    browserGraphQL.execute.mockResolvedValue({
      ok: true,
      data: {
        revokeOrganizationApiKey: {
          actionId: "ak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          code: "APPLIED",
          requestId: "019893aa-99a0-7000-8000-000000000002",
        },
      },
    });

    render(
      <ApiKeyAdministration
        allowedScopes={["person:read"]}
        apiKeys={[
          {
            actionId: "ak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "Export worker",
            fingerprint: "hum_••••••••••••••••",
            state: "active",
            scopes: ["person:read"],
            createdAt: "2026-09-12T12:00:00.000Z",
            updatedAt: "2026-09-12T12:00:00.000Z",
            expiresAt: null,
            lastUsedAt: null,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(browserGraphQL.execute).toHaveBeenCalledOnce();
    expect(browserGraphQL.execute.mock.calls[0]?.[1]).toEqual({
      input: {
        actionId: "ak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      },
    });
  });
});
