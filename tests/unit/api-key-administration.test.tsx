import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
