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
          replayed: false,
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
    expect(browserGraphQL.execute.mock.calls[0]?.[1]).toEqual({
      input: expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      }),
    });

    await user.click(screen.getByRole("button", { name: "I saved it" }));
    expect(screen.queryByLabelText("New API key")).toBeNull();
  });

  it("reuses one create idempotency key after a transport failure and explains a secretless replay", async () => {
    const user = userEvent.setup();
    browserGraphQL.execute
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          createOrganizationApiKey: {
            actionId: "ak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            code: "APPLIED",
            replayed: true,
            requestId: "019893aa-99a0-7000-8000-000000000002",
            secret: null,
          },
        },
      });

    render(
      <ApiKeyAdministration allowedScopes={["person:read"]} apiKeys={[]} />,
    );
    await user.type(screen.getByLabelText("Name"), "Retry-safe worker");
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await user.click(screen.getByRole("button", { name: "Create API key" }));

    expect(browserGraphQL.execute).toHaveBeenCalledTimes(2);
    const firstKey =
      browserGraphQL.execute.mock.calls[0]?.[1]?.input?.idempotencyKey;
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(
      browserGraphQL.execute.mock.calls[1]?.[1]?.input?.idempotencyKey,
    ).toBe(firstKey);
    expect(screen.queryByLabelText("New API key")).toBeNull();
    expect(
      screen.getByText(/was applied, but its one-time secret is unavailable/u),
    ).toBeVisible();
    expect(router.refresh).toHaveBeenCalledOnce();
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

  it("sends a durable idempotency key when rotating an API key", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    browserGraphQL.execute.mockResolvedValue({
      ok: true,
      data: {
        rotateOrganizationApiKey: {
          actionId: "ak_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          code: "APPLIED",
          replayed: false,
          requestId: "019893aa-99a0-7000-8000-000000000003",
          secret: "hum_rotated-plaintext-returned-once",
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
            fingerprint: "hum_aaaaaa",
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
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await user.click(
      screen.getByRole("button", { name: "Create replacement and revoke" }),
    );

    expect(browserGraphQL.execute.mock.calls[0]?.[1]).toEqual({
      input: expect.objectContaining({
        actionId: "ak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      }),
    });
  });
});
