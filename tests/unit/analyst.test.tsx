import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Analyst,
  type AnalystAdapter,
  type AnalystRun,
} from "@/components/ai/analyst";
import { AppShell } from "@/components/app-shell";

const RUN_ID = "018f0000-0000-7000-8000-000000000001";
const PERSON_ID = "018f0000-0000-7000-8000-000000000011";
const EVIDENCE_ID = "018f0000-0000-7000-8000-000000000012";

function run(overrides: Partial<AnalystRun> = {}): AnalystRun {
  return {
    answer: null,
    citations: [],
    completedAt: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    errorCode: null,
    id: RUN_ID,
    model: "research-model",
    provider: "OLLAMA",
    startedAt: null,
    state: "pending",
    toolCalls: [],
    ...overrides,
  };
}

function adapter(overrides: Partial<AnalystAdapter> = {}): AnalystAdapter {
  return {
    cancel: vi.fn().mockResolvedValue(run({ state: "cancelled" })),
    read: vi.fn().mockResolvedValue(run({ state: "running" })),
    start: vi.fn().mockResolvedValue(run()),
    ...overrides,
  };
}

function analyst(
  analystAdapter: AnalystAdapter,
  props: Partial<Parameters<typeof Analyst>[0]> = {},
) {
  return (
    <Analyst
      adapter={analystAdapter}
      canCancel
      canStart
      pollDelayMs={10}
      workspaceIdentity="workspace-alpha"
      {...props}
    />
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Analyst", () => {
  it("creates one cryptographic key for a deliberate bounded submission and blocks duplicates", async () => {
    const user = userEvent.setup();
    let resolveStart!: (value: AnalystRun) => void;
    const start = vi.fn().mockReturnValue(
      new Promise<AnalystRun>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const randomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("018f0000-0000-7000-8000-000000000099");
    render(analyst(adapter({ start })));

    await user.type(
      screen.getByLabelText("Question"),
      "  What evidence supports this person?  ",
    );
    await user.type(screen.getByLabelText("Person scope UUIDs"), PERSON_ID);
    await user.type(screen.getByLabelText("Evidence scope UUIDs"), EVIDENCE_ID);
    await user.click(screen.getByRole("button", { name: "Start analysis" }));

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      {
        idempotencyKey: "018f0000-0000-7000-8000-000000000099",
        question: "What evidence supports this person?",
        scope: { evidenceIds: [EVIDENCE_ID], personIds: [PERSON_ID] },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Starting analysis…" }),
    ).toBeDisabled();

    await user.keyboard("{Enter}");
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => resolveStart(run()));
    expect(await screen.findByText("Queued")).toBeVisible();
  });

  it("validates UTF-8 question bytes and a closed UUID scope before creating a key", async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    render(analyst(adapter({ start })));

    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "😀".repeat(2_001) },
    });
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "8,000 UTF-8 bytes or fewer",
    );
    expect(start).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Question"));
    await user.type(screen.getByLabelText("Question"), "Find the source");
    await user.type(screen.getByLabelText("Person scope UUIDs"), "not-a-uuid");
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid UUIDs");
    expect(start).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it("polls active runs, announces progress politely, and renders only safe terminal fields", async () => {
    const start = vi.fn().mockResolvedValue(run());
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        run({
          state: "running",
          startedAt: "2026-08-04T12:00:01.000Z",
          toolCalls: [
            {
              completedAt: null,
              inputSummary: { personCount: 1 },
              name: "getPerson",
              resultSummary: null,
              startedAt: "2026-08-04T12:00:02.000Z",
              state: "running",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        run({
          answer: "The record is supported by one first-party source.",
          citations: [
            {
              claimText: "The person record confirms the identity.",
              locator: "Profile",
              resourceId: PERSON_ID,
              resourceKind: "person",
            },
            {
              claimText: "The evidence item supports the claim.",
              locator: "Page 2",
              resourceId: EVIDENCE_ID,
              resourceKind: "evidence",
            },
          ],
          completedAt: "2026-08-04T12:00:04.000Z",
          state: "completed",
          toolCalls: [
            {
              completedAt: "2026-08-04T12:00:03.000Z",
              inputSummary: { personCount: 1 },
              name: "getPerson",
              resultSummary: { resultCount: 1, truncated: false },
              startedAt: "2026-08-04T12:00:02.000Z",
              state: "completed",
            },
          ],
        }),
      );
    const user = userEvent.setup();
    render(analyst(adapter({ read, start })));
    await user.type(
      screen.getByLabelText("Question"),
      "Summarize the evidence",
    );
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Running")).toBeVisible();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    expect(
      await screen.findByRole("heading", { name: "Cited answer" }),
    ).toHaveFocus();
    expect(
      screen.getByText(/supported by one first-party source/u),
    ).toBeVisible();
    expect(screen.getByText("OLLAMA · research-model")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /person record confirms/u }),
    ).toHaveAttribute("href", `/people/${PERSON_ID}`);
    expect(
      screen.queryByRole("link", { name: /evidence item supports/u }),
    ).toBeNull();
    expect(screen.getByText(/Evidence resource .*Page 2/u)).toBeVisible();
    const trace = screen.getByRole("list", { name: "Tool activity" });
    expect(within(trace).getByText("getPerson")).toBeVisible();
    expect(within(trace).getByText(/Input: 1 person/u)).toBeVisible();
    expect(
      within(trace).getByText(/Result: 1 result, not truncated/u),
    ).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps increasing and caps polling delays across fresh active run projections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pollTimes: number[] = [];
    const read = vi.fn().mockImplementation(async () => {
      pollTimes.push(Date.now());
      return run({ state: "running" });
    });
    render(analyst(adapter({ read }), { pollDelayMs: 10 }));
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Keep a bounded polling cadence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start analysis" }));
    await act(async () => undefined);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await act(async () => vi.advanceTimersToNextTimerAsync());
    }

    expect(pollTimes).toEqual([
      10, 30, 70, 150, 310, 630, 1_270, 2_550, 5_110, 10_230, 18_230, 26_230,
    ]);
  });

  it("cancels an active run and stops polling", async () => {
    const cancel = vi.fn().mockResolvedValue(run({ state: "cancelled" }));
    const read = vi.fn().mockImplementation(
      () =>
        new Promise<AnalystRun>(() => {
          // Keep the read in flight so cancellation must abort it.
        }),
    );
    const user = userEvent.setup();
    render(analyst(adapter({ cancel, read })));
    await user.type(screen.getByLabelText("Question"), "Stop this run");
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(read).toHaveBeenCalled());
    const pollSignal = read.mock.calls[0]?.[1].signal as AbortSignal;
    await user.click(screen.getByRole("button", { name: "Cancel analysis" }));

    expect(cancel).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText("Cancelled")).toBeVisible();
    expect(pollSignal.aborted).toBe(true);
    const calls = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it("resumes polling after cancellation cannot be confirmed without accepting the aborted read", async () => {
    let resolveAbortedRead!: (value: AnalystRun) => void;
    let resolveResumedRead!: (value: AnalystRun) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AnalystRun>((resolve) => {
            resolveAbortedRead = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<AnalystRun>((resolve) => {
            resolveResumedRead = resolve;
          }),
      );
    const cancel = vi.fn().mockRejectedValue(
      Object.assign(new Error("private upstream cancellation detail"), {
        code: "NETWORK_ERROR",
      }),
    );
    const user = userEvent.setup();
    render(analyst(adapter({ cancel, read })));
    await user.type(
      screen.getByLabelText("Question"),
      "Keep watching this run",
    );
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const abortedSignal = read.mock.calls[0]?.[1].signal as AbortSignal;

    await user.click(screen.getByRole("button", { name: "Cancel analysis" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Analysis is temporarily unavailable",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /private|upstream/u,
    );
    expect(abortedSignal.aborted).toBe(true);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveAbortedRead(
        run({
          answer: "This stale result must not render.",
          completedAt: "2026-08-04T12:00:03.000Z",
          state: "completed",
        }),
      );
    });
    expect(screen.queryByText("This stale result must not render.")).toBeNull();

    await act(async () => {
      resolveResumedRead(
        run({
          answer: "The resumed poll returned this result.",
          completedAt: "2026-08-04T12:00:04.000Z",
          state: "completed",
        }),
      );
    });
    expect(
      await screen.findByText("The resumed poll returned this result."),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    const calls = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it("reuses a failed start key only for an explicit retry and never renders private errors", async () => {
    const user = userEvent.setup();
    const randomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("018f0000-0000-7000-8000-000000000099");
    const start = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("secret prompt api-key base-url upstream"), {
          code: "PROVIDER_UNAVAILABLE",
        }),
      )
      .mockResolvedValueOnce(run());
    render(analyst(adapter({ start })));

    await user.type(screen.getByLabelText("Question"), "private prompt");
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Analysis is temporarily unavailable",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /secret|private prompt|api-key|base-url|upstream/u,
    );
    expect(window.location.search).toBe("");
    expect(window.localStorage?.length ?? 0).toBe(0);
    expect(window.sessionStorage?.length ?? 0).toBe(0);

    await user.click(screen.getByRole("button", { name: "Retry submission" }));
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]?.[0]).toEqual(start.mock.calls[1]?.[0]);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("aborts stale work and clears run state when the workspace changes", async () => {
    const user = userEvent.setup();
    let startSignal: AbortSignal | undefined;
    const start = vi.fn((_input, options) => {
      startSignal = options.signal;
      return new Promise<AnalystRun>(() => undefined);
    });
    const { rerender } = render(analyst(adapter({ start })));
    await user.type(
      screen.getByLabelText("Question"),
      "Workspace one question",
    );
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    expect(startSignal?.aborted).toBe(false);

    rerender(
      analyst(adapter(), {
        workspaceIdentity: "workspace-beta",
      }),
    );
    expect(startSignal?.aborted).toBe(true);
    expect(screen.getByLabelText("Question")).toHaveValue("");
    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("shows an uncited completion and stable failed guidance", async () => {
    const user = userEvent.setup();
    const start = vi
      .fn()
      .mockResolvedValueOnce(
        run({
          answer: "No supported citation was returned.",
          state: "completed",
        }),
      )
      .mockResolvedValueOnce(
        run({ errorCode: "provider_timeout", state: "failed" }),
      );
    render(analyst(adapter({ start })));
    await user.type(screen.getByLabelText("Question"), "First question");
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    expect(
      await screen.findByText("No validated citations were returned."),
    ).toBeVisible();

    await user.clear(screen.getByLabelText("Question"));
    await user.type(screen.getByLabelText("Question"), "Second question");
    await user.click(screen.getByRole("button", { name: "Start analysis" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The model provider timed out. You can submit a new analysis.",
    );
  });

  it("gates analyst navigation and starting controls by permission", () => {
    const shellProps = {
      activeWorkspace: { id: "workspace-a", name: "Archive desk" },
      organizations: [{ id: "workspace-a", name: "Archive desk" }],
      viewer: {
        displayName: "Ada Analyst",
        email: "ada@example.test",
        permissions: ["analysis:read"],
        role: "viewer",
      },
    } as const;
    const { rerender } = render(
      <AppShell {...shellProps}>Research content</AppShell>,
    );
    expect(screen.getByRole("link", { name: "Analyst" })).toHaveAttribute(
      "href",
      "/analyst",
    );

    rerender(
      <AppShell
        {...shellProps}
        viewer={{ ...shellProps.viewer, permissions: [] }}
      >
        Research content
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "Analyst" })).toBeNull();

    rerender(analyst(adapter(), { canCancel: false, canStart: false }));
    expect(screen.queryByLabelText("Question")).toBeNull();
    expect(
      screen.getByText(/permission to read prior runs, but not to start/u),
    ).toBeVisible();
  });
});
