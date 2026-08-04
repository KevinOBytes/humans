// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useEphemeralHashParam } from "@/components/auth/use-location-search";

describe("ephemeral reset token state", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("captures once and scrubs URL/history before exposing the token", async () => {
    window.history.replaceState(
      null,
      "",
      "/reset-password#token=one-time-reset-secret",
    );
    const { result, unmount } = renderHook(() =>
      useEphemeralHashParam("token"),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.value).toBe("one-time-reset-secret");
    expect(window.location.href).not.toContain("one-time-reset-secret");
    expect(window.location.hash).toBe("");

    unmount();
    expect(window.location.hash).toBe("");
  });

  it("scrubs malformed and empty fragments without exposing a value", async () => {
    window.history.replaceState(null, "", "/reset-password#token=");
    const { result } = renderHook(() => useEphemeralHashParam("token"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.value).toBeNull();
    expect(window.location.hash).toBe("");
  });
});
