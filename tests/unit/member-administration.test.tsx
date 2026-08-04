import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemberAdministration } from "@/components/settings/member-administration";

const execute = vi.fn();
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("member administration", () => {
  beforeEach(() => execute.mockReset());

  it("threads an abort signal through the directory request and aborts on disposal", async () => {
    execute.mockImplementation(
      (
        _document: unknown,
        _variables: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        const signal = options?.signal;
        if (!signal)
          return Promise.resolve({
            ok: false,
            errors: [{ code: "NETWORK_ERROR", message: "missing signal" }],
          });
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                ok: false,
                errors: [{ code: "NETWORK_ERROR", message: "aborted" }],
              }),
            { once: true },
          );
        });
      },
    );
    const view = render(<MemberAdministration />);

    await waitFor(() =>
      expect(execute.mock.calls.some((call) => call[2]?.signal)).toBe(true),
    );
    const signal = execute.mock.calls.find((call) => call[2]?.signal)?.[2]
      ?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
