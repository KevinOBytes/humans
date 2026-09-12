"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  AssignResearchAssignmentDocument,
  CreateResearchAssignmentDocument,
  EscalateResearchAssignmentDocument,
  ResearchAssignmentsDocument,
  TransitionResearchAssignmentDocument,
  type ResearchAssignmentQueueKind,
  type ResearchAssignmentFieldsFragment,
  type ResearchAssignmentStatus,
} from "@/graphql/generated/graphql";

const queueKinds: { value: ResearchAssignmentQueueKind; label: string }[] = [
  { value: "REVIEW", label: "Review" },
  { value: "VERIFICATION", label: "Verification" },
  { value: "CONSENT_FOLLOW_UP", label: "Consent follow-up" },
  { value: "SOURCE_RECONCILIATION", label: "Source reconciliation" },
  { value: "PRIVACY_REQUEST", label: "Privacy request" },
];
const statuses: { value: ResearchAssignmentStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "BLOCKED", label: "Blocked" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];
const transitions: Record<
  ResearchAssignmentStatus,
  { status: ResearchAssignmentStatus; label: string }[]
> = {
  OPEN: [
    { status: "IN_PROGRESS", label: "Start" },
    { status: "BLOCKED", label: "Block" },
    { status: "CANCELLED", label: "Cancel" },
  ],
  IN_PROGRESS: [
    { status: "OPEN", label: "Reopen" },
    { status: "BLOCKED", label: "Block" },
    { status: "COMPLETED", label: "Complete" },
    { status: "CANCELLED", label: "Cancel" },
  ],
  BLOCKED: [
    { status: "OPEN", label: "Reopen" },
    { status: "IN_PROGRESS", label: "Resume" },
    { status: "CANCELLED", label: "Cancel" },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

function idempotencyKey() {
  return crypto.randomUUID();
}

export function ResearchAssignmentQueue({ caseId }: { caseId: string }) {
  const [rows, setRows] = useState<ResearchAssignmentFieldsFragment[]>([]);
  const [page, setPage] = useState<{
    hasNextPage: boolean;
    endCursor: string | null;
  }>({ hasNextPage: false, endCursor: null });
  const [status, setStatus] = useState<ResearchAssignmentStatus | "">("");
  const [queueKind, setQueueKind] = useState<ResearchAssignmentQueueKind | "">(
    "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    title: "",
    description: "",
    queueKind: "REVIEW" as ResearchAssignmentQueueKind,
    priority: "0",
    assigneePrincipalId: "",
    dueAt: "",
  });

  const load = useCallback(
    async (after?: string, append = false) => {
      setBusy(true);
      setError("");
      try {
        const result = await executeBrowserGraphQL(
          ResearchAssignmentsDocument,
          {
            caseId,
            first: 25,
            status: status || undefined,
            queueKind: queueKind || undefined,
            ...(after ? { after } : {}),
          },
        );
        if (!result.ok || !result.data.researchAssignments)
          throw new Error("unavailable");
        const connection = result.data.researchAssignments;
        const next = connection.nodes as ResearchAssignmentFieldsFragment[];
        setRows((current) => (append ? [...current, ...next] : next));
        setPage({
          hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
          endCursor: connection.pageInfo?.endCursor ?? null,
        });
      } catch {
        setRows([]);
        setPage({ hasNextPage: false, endCursor: null });
        setError(
          "Assignments are unavailable. Check current case membership and permissions.",
        );
      } finally {
        setBusy(false);
      }
    },
    [caseId, queueKind, status],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function mutate(
    request: () => ReturnType<typeof executeBrowserGraphQL>,
  ) {
    setBusy(true);
    setError("");
    try {
      const result = await request();
      if (!result.ok) throw new Error("denied");
      await load();
      return true;
    } catch {
      setError(
        "The assignment could not be saved. Refresh to check current access and state.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.title.trim()) return;
    const saved = await mutate(() =>
      executeBrowserGraphQL(CreateResearchAssignmentDocument, {
        input: {
          caseId,
          queueKind: form.queueKind,
          title: form.title,
          description: form.description || null,
          priority: Number(form.priority),
          assigneePrincipalId: form.assigneePrincipalId || null,
          dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
          idempotencyKey: idempotencyKey(),
        },
      }),
    );
    if (saved)
      setForm({
        title: "",
        description: "",
        queueKind: "REVIEW",
        priority: "0",
        assigneePrincipalId: "",
        dueAt: "",
      });
  }

  return (
    <section
      aria-labelledby="assignment-queue-heading"
      className="border-border mt-8 space-y-5 rounded-xl border p-4"
    >
      <div>
        <h2 id="assignment-queue-heading" className="text-xl font-semibold">
          Research assignments
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          This queue is limited to the selected case. A row records work state
          only; it never grants access to case resources.
        </p>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="assignment-status-filter">Status</Label>
          <select
            id="assignment-status-filter"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as ResearchAssignmentStatus | "")
            }
          >
            <option value="">All statuses</option>
            {statuses.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="assignment-kind-filter">Kind</Label>
          <select
            id="assignment-kind-filter"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3"
            value={queueKind}
            onChange={(e) =>
              setQueueKind(e.target.value as ResearchAssignmentQueueKind | "")
            }
          >
            <option value="">All kinds</option>
            {queueKinds.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <form
        className="grid gap-3 border-t pt-5"
        onSubmit={(event) => void create(event)}
      >
        <h3 className="font-semibold">Create assignment</h3>
        <div>
          <Label htmlFor="assignment-title">Assignment title</Label>
          <Input
            id="assignment-title"
            maxLength={200}
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="assignment-description">Description</Label>
          <textarea
            id="assignment-description"
            className="border-input bg-background min-h-24 w-full rounded-xl border p-3"
            maxLength={4000}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="assignment-kind">Kind</Label>
            <select
              id="assignment-kind"
              className="border-input bg-background min-h-11 w-full rounded-xl border px-3"
              value={form.queueKind}
              onChange={(e) =>
                setForm({
                  ...form,
                  queueKind: e.target.value as ResearchAssignmentQueueKind,
                })
              }
            >
              {queueKinds.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="assignment-priority">Priority (0–100)</Label>
            <Input
              id="assignment-priority"
              type="number"
              min="0"
              max="100"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="assignment-assignee">
              Assignee principal ID (optional)
            </Label>
            <Input
              id="assignment-assignee"
              value={form.assigneePrincipalId}
              onChange={(e) =>
                setForm({ ...form, assigneePrincipalId: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="assignment-due">Due date (optional)</Label>
            <Input
              id="assignment-due"
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
            />
          </div>
        </div>
        <Button disabled={busy} type="submit">
          Create assignment
        </Button>
      </form>
      {busy ? <p role="status">Loading assignment queue…</p> : null}
      <ul className="space-y-3" aria-label="Assignments">
        {rows.map((row) => (
          <li key={row.id} className="border-border rounded-xl border p-4">
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="font-semibold">{row.title}</h3>
              <span>{row.status?.replaceAll("_", " ")}</span>
            </div>
            <p className="text-muted-foreground text-sm">
              {row.queueKind?.replaceAll("_", " ")} · Priority{" "}
              {row.priority ?? 0} · Escalations {row.escalationCount ?? 0}
            </p>
            {row.description ? (
              <p className="mt-2 text-sm">{row.description}</p>
            ) : null}
            <Label
              className="mt-3 block"
              htmlFor={`assignment-reason-${row.id}`}
            >
              Reason for {row.title}
            </Label>
            <Input
              id={`assignment-reason-${row.id}`}
              maxLength={2000}
              value={reason[row.id ?? ""] ?? ""}
              onChange={(e) =>
                setReason({ ...reason, [row.id ?? ""]: e.target.value })
              }
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {row.status
                ? transitions[row.status].map((next) => (
                    <Button
                      key={next.status}
                      type="button"
                      variant="outline"
                      disabled={busy || !reason[row.id ?? ""]?.trim()}
                      onClick={() =>
                        void mutate(() =>
                          executeBrowserGraphQL(
                            TransitionResearchAssignmentDocument,
                            {
                              input: {
                                id: row.id!,
                                expectedVersion: row.version!,
                                status: next.status,
                                reason: reason[row.id!]!,
                                idempotencyKey: idempotencyKey(),
                              },
                            },
                          ),
                        )
                      }
                    >
                      {next.label}
                    </Button>
                  ))
                : null}
              {row.status &&
              !["COMPLETED", "CANCELLED"].includes(row.status) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !reason[row.id ?? ""]?.trim()}
                  onClick={() =>
                    void mutate(() =>
                      executeBrowserGraphQL(
                        EscalateResearchAssignmentDocument,
                        {
                          input: {
                            id: row.id!,
                            expectedVersion: row.version!,
                            reason: reason[row.id!]!,
                            idempotencyKey: idempotencyKey(),
                          },
                        },
                      ),
                    )
                  }
                >
                  Escalate
                </Button>
              ) : null}
            </div>
            <div className="mt-3">
              <Label htmlFor={`assignment-assignee-${row.id}`}>
                Assign principal ID
              </Label>
              <Input
                id={`assignment-assignee-${row.id}`}
                value={reason[`assignee-${row.id}`] ?? ""}
                onChange={(e) =>
                  setReason({
                    ...reason,
                    [`assignee-${row.id}`]: e.target.value,
                  })
                }
              />
              <Button
                className="mt-2"
                type="button"
                variant="outline"
                disabled={busy || !reason[row.id ?? ""]?.trim()}
                onClick={() =>
                  void mutate(() =>
                    executeBrowserGraphQL(AssignResearchAssignmentDocument, {
                      input: {
                        id: row.id!,
                        expectedVersion: row.version!,
                        assigneePrincipalId:
                          reason[`assignee-${row.id}`] || null,
                        reason: reason[row.id!]!,
                        idempotencyKey: idempotencyKey(),
                      },
                    }),
                  )
                }
              >
                Save assignee
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!busy && !rows.length ? (
        <p>No assignments are visible for this case.</p>
      ) : null}
      {page.hasNextPage && page.endCursor ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void load(page.endCursor!, true)}
        >
          Next assignments
        </Button>
      ) : null}
    </section>
  );
}
