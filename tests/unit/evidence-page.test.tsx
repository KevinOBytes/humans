import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appContext = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/app-session", () => ({ getAppContext: appContext }));
vi.mock("@/graphql/server-client", () => ({ executeServerGraphQL: execute }));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));

import EvidencePage from "@/app/(app)/evidence/page";

describe("evidence page", () => {
  beforeEach(() => {
    appContext.mockReset();
    execute.mockReset();
  });

  it("does not request owned upload sessions for a file-read-only viewer", async () => {
    appContext.mockResolvedValue({
      viewer: { permissions: ["file:read"] },
    });
    execute.mockImplementationOnce(() =>
      Promise.resolve({
        files: {
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      }),
    );

    render(await EvidencePage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", { name: "Workspace files" }),
    ).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Pending uploads")).toBeNull();
  });
});
