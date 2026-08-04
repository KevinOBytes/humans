// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runJobsContinuously } from "@/worker/run-continuous";

describe("continuous worker resilience", () => {
  it("keeps running with bounded dependency backoff", async () => {
    const controller = new AbortController();
    const runOnce = vi
      .fn<(input: { signal: AbortSignal }) => Promise<{ claimed: number }>>()
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockRejectedValueOnce(new Error("postgres unavailable"))
      .mockImplementationOnce(async () => {
        controller.abort();
        return { claimed: 0 };
      });
    const waits: number[] = [];

    await expect(
      runJobsContinuously({
        runOnce,
        signal: controller.signal,
        sleep: async (milliseconds) => void waits.push(milliseconds),
      }),
    ).resolves.toBeUndefined();

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("refreshes the heartbeat independently while work is active", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: string[] = [];
    let finishPass!: () => void;
    const activePass = new Promise<void>((resolve) => {
      finishPass = resolve;
    });
    const runOnce = vi.fn(async () => {
      await activePass;
      return { claimed: 1 };
    });

    const running = runJobsContinuously({
      heartbeat: {
        refresh: async () => void events.push("refresh"),
        remove: async () => void events.push("remove"),
      },
      heartbeatIntervalMs: 50,
      runOnce,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(160);
    expect(events).toEqual(["refresh", "refresh", "refresh", "refresh"]);

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual(["refresh", "refresh", "refresh", "refresh"]);
    finishPass();
    await running;

    expect(events).toEqual([
      "refresh",
      "refresh",
      "refresh",
      "refresh",
      "remove",
    ]);
    vi.useRealTimers();
  });

  it("aborts the active bounded pass and starts no new pass during drain", async () => {
    const controller = new AbortController();
    const runOnce = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { claimed: 1 };
    });

    const running = runJobsContinuously({
      runOnce,
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(runOnce).toHaveBeenCalledOnce();
    controller.abort();
    await running;

    expect(runOnce).toHaveBeenCalledOnce();
    expect(runOnce.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("clears the hard-exit timer when a deadline-aborted handler settles", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const hardExit = vi.fn();
    const runOnce = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { claimed: 1 };
    });

    const running = runJobsContinuously({
      heartbeat: {
        refresh: async () => void events.push("refresh"),
        remove: async () => void events.push("remove"),
      },
      heartbeatIntervalMs: 25,
      hardExit,
      hardExitGraceMs: 50,
      passTimeLimitMs: 100,
      runOnce,
    });
    const outcome = expect(running).rejects.toMatchObject({
      code: "time_limit",
    });
    await vi.advanceTimersByTimeAsync(160);

    await outcome;
    expect(runOnce).toHaveBeenCalledOnce();
    expect(hardExit).not.toHaveBeenCalled();
    expect(events).toEqual([
      "refresh",
      "refresh",
      "refresh",
      "refresh",
      "remove",
    ]);
    vi.useRealTimers();
  });

  it("hard-exits a non-cooperative deadline while the pass remains owned", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const hardExit = vi.fn();
    let finishPass!: () => void;
    const activePass = new Promise<void>((resolve) => {
      finishPass = resolve;
    });
    let passSignal: AbortSignal | undefined;
    const runOnce = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      passSignal = signal;
      await activePass;
      return { claimed: 1 };
    });

    const running = runJobsContinuously({
      heartbeat: {
        refresh: async () => void events.push("refresh"),
        remove: async () => void events.push("remove"),
      },
      hardExit,
      hardExitGraceMs: 50,
      heartbeatIntervalMs: 25,
      passTimeLimitMs: 100,
      runOnce,
    });
    const outcome = expect(running).rejects.toMatchObject({
      code: "time_limit",
    });
    await vi.advanceTimersByTimeAsync(149);
    expect(passSignal?.aborted).toBe(true);
    expect(hardExit).not.toHaveBeenCalled();
    expect(events).not.toContain("remove");

    await vi.advanceTimersByTimeAsync(1);
    expect(hardExit).toHaveBeenCalledOnce();
    expect(hardExit).toHaveBeenCalledWith(1);
    expect(events).not.toContain("remove");

    finishPass();
    await outcome;
    expect(runOnce).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("remove");
    vi.useRealTimers();
  });

  it("leaves an external non-cooperative drain to the Compose grace boundary", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const hardExit = vi.fn();
    let finishPass!: () => void;
    const activePass = new Promise<void>((resolve) => {
      finishPass = resolve;
    });
    const runOnce = vi.fn(async () => {
      await activePass;
      return { claimed: 1 };
    });

    const running = runJobsContinuously({
      hardExit,
      hardExitGraceMs: 25,
      passTimeLimitMs: 50,
      runOnce,
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(runOnce).toHaveBeenCalledOnce();
    controller.abort();
    await vi.advanceTimersByTimeAsync(200);
    expect(hardExit).not.toHaveBeenCalled();

    finishPass();
    await expect(running).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
