"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  BreakGlassAccessRequestsDocument,
  ReviewBreakGlassAccessDocument,
  RevokeBreakGlassAccessDocument,
  type BreakGlassAccessRequestsQuery,
  type BreakGlassState,
} from "@/graphql/generated/graphql";

type BreakGlassRequest = NonNullable<
  NonNullable<
    NonNullable<
      BreakGlassAccessRequestsQuery["breakGlassAccessRequests"]
    >["nodes"]
  >[number]
>;

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type Feedback = { kind: "error" | "success"; message: string } | null;

function requestLabel(id: string | null): string {
  return id ? `${id.slice(0, 8)}…` : "unavailable";
}

function displayDate(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function stateLabel(value: BreakGlassState | null): string {
  return (value ?? "REQUESTED").toLowerCase();
}

function stateBadgeClass(value: BreakGlassState | null): string {
  if (value === "APPROVED") return "bg-emerald-100 text-emerald-900";
  if (value === "REJECTED" || value === "REVOKED") {
    return "bg-muted text-muted-foreground";
  }
  return "bg-amber-100 text-amber-950";
}

export function BreakGlassAdministration({
  initialRequests,
  initialPageInfo,
}: {
  initialRequests: readonly BreakGlassRequest[];
  initialPageInfo: PageInfo;
}) {
  const [requests, setRequests] =
    useState<readonly BreakGlassRequest[]>(initialRequests);
  const [pageInfo, setPageInfo] = useState<PageInfo>(initialPageInfo);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function load(after: string | null = null) {
    if (loading) return;
    setLoading(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      BreakGlassAccessRequestsDocument,
      { first: 10, after },
    );
    setLoading(false);
    if (!result.ok) {
      setFeedback({
        kind: "error",
        message: "Break-glass requests could not be loaded.",
      });
      return;
    }
    const connection = result.data.breakGlassAccessRequests;
    setRequests(
      (connection?.nodes ?? []).filter(
        (request): request is BreakGlassRequest => request !== null,
      ),
    );
    setPageInfo({
      hasNextPage: connection?.pageInfo?.hasNextPage === true,
      endCursor: connection?.pageInfo?.endCursor ?? null,
    });
  }

  function readReason(id: string | null): string {
    return (id ? reasons[id] : "")?.trim() ?? "";
  }

  async function review(
    request: BreakGlassRequest,
    state: "APPROVED" | "REJECTED",
  ) {
    if (!request.id || request.version == null || busyId) return;
    const reason = readReason(request.id);
    if (reason.length < 20) {
      setFeedback({
        kind: "error",
        message: "Enter at least 20 characters explaining this review.",
      });
      return;
    }
    setBusyId(request.id);
    setFeedback(null);
    const result = await executeBrowserGraphQL(ReviewBreakGlassAccessDocument, {
      id: request.id,
      expectedVersion: request.version,
      state,
      reason,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusyId(null);
    if (!result.ok || !result.data.reviewBreakGlassAccess) {
      setFeedback({
        kind: "error",
        message:
          "The request could not be reviewed. It may have changed; reload and try again.",
      });
      return;
    }
    setFeedback({
      kind: "success",
      message: `Request ${state === "APPROVED" ? "approved" : "rejected"}.`,
    });
    await load();
  }

  async function revoke(request: BreakGlassRequest) {
    if (!request.id || request.version == null || busyId) return;
    const reason = readReason(request.id);
    if (reason.length < 20) {
      setFeedback({
        kind: "error",
        message: "Enter at least 20 characters explaining this revocation.",
      });
      return;
    }
    setBusyId(request.id);
    setFeedback(null);
    const result = await executeBrowserGraphQL(RevokeBreakGlassAccessDocument, {
      id: request.id,
      expectedVersion: request.version,
      reason,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusyId(null);
    if (!result.ok || !result.data.revokeBreakGlassAccess) {
      setFeedback({
        kind: "error",
        message:
          "The approval could not be revoked. It may have changed; reload and try again.",
      });
      return;
    }
    setFeedback({ kind: "success", message: "Approval revoked." });
    await load();
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Break-glass access requests</h2>
        <p className="text-muted-foreground mt-1 text-sm leading-6">
          Review exceptional, time-limited access requests. Every decision and
          revocation is audited; an approver cannot approve their own request.
        </p>
      </div>

      {feedback ? (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={
            feedback.kind === "error"
              ? "text-destructive text-sm"
              : "text-sm text-emerald-700 dark:text-emerald-300"
          }
        >
          {feedback.message}
        </p>
      ) : null}

      <ol className="grid gap-4" aria-label="Break-glass access requests">
        {requests.map((request) => {
          const state = request.state;
          const canReview = state === "REQUESTED";
          const canRevoke = state === "APPROVED";
          const id = request.id ?? "unknown";
          const busy = busyId === request.id;
          return (
            <li key={id} className="border-border rounded-xl border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">
                    {request.purpose || "Unspecified purpose"}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Request {requestLabel(request.id)} · requester{" "}
                    {requestLabel(request.requesterPrincipalId)}
                  </p>
                </div>
                <Badge className={stateBadgeClass(state)}>
                  {stateLabel(state)}
                </Badge>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Justification</dt>
                  <dd className="mt-1 break-words whitespace-pre-wrap">
                    {request.justification || "Unavailable"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Case reference</dt>
                  <dd className="mt-1 break-words">
                    {request.caseReference || "None provided"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd className="mt-1">{displayDate(request.expiresAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="mt-1">{displayDate(request.createdAt)}</dd>
                </div>
              </dl>
              <div className="mt-4">
                <p className="text-muted-foreground text-sm font-medium">
                  Explicit resources
                </p>
                <ul className="mt-2 grid gap-1 text-sm">
                  {(request.resources ?? []).map((resource, index) => (
                    <li
                      key={`${resource.resourceKind ?? "resource"}-${resource.resourceId ?? index}`}
                    >
                      {resource.resourceKind ?? "resource"} ·{" "}
                      {requestLabel(resource.resourceId)}
                    </li>
                  ))}
                  {(request.resources ?? []).length === 0 ? (
                    <li className="text-muted-foreground">None listed</li>
                  ) : null}
                </ul>
              </div>
              {canReview || canRevoke ? (
                <div className="border-border mt-4 grid gap-3 border-t pt-4">
                  <label className="grid gap-1 text-sm font-medium">
                    Review reason
                    <textarea
                      aria-label="Review reason"
                      value={reasons[id] ?? ""}
                      onChange={(event) =>
                        setReasons((current) => ({
                          ...current,
                          [id]: event.target.value,
                        }))
                      }
                      minLength={20}
                      maxLength={4000}
                      rows={3}
                      disabled={busy || loading}
                      className="border-input bg-background focus-visible:ring-ring min-h-20 rounded-lg border px-3 py-2 font-normal outline-none focus-visible:ring-2"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {canReview ? (
                      <>
                        <Button
                          type="button"
                          disabled={busy || loading}
                          onClick={() => void review(request, "APPROVED")}
                        >
                          {busy ? "Working…" : "Approve request"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy || loading}
                          onClick={() => void review(request, "REJECTED")}
                        >
                          {busy ? "Working…" : "Reject request"}
                        </Button>
                      </>
                    ) : null}
                    {canRevoke ? (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busy || loading}
                        onClick={() => void revoke(request)}
                      >
                        {busy ? "Working…" : "Revoke approval"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {requests.length === 0 ? (
          <li className="text-muted-foreground py-4 text-sm">
            No break-glass access requests are recorded for this workspace.
          </li>
        ) : null}
      </ol>
      {pageInfo.hasNextPage && pageInfo.endCursor ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void load(pageInfo.endCursor)}
          >
            {loading ? "Loading…" : "Next requests"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
