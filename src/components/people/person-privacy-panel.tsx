"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  CreatePrivacyRequestDocument,
  PrivacyRetentionDocument,
  PrivacyRequestDocument,
  PrivacyRequestFieldsFragmentDoc,
  type PrivacyRequestType,
  type PrivacyRetentionQuery,
  type PrivacyRequestQuery,
} from "@/graphql/generated/graphql";

function dateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function defaultDueDate() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return dateInputValue(date);
}

function dueAtForDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59)).toISOString();
}

export function PersonPrivacyPanel({ personId }: { personId: string }) {
  const [posture, setPosture] = useState<PrivacyRetentionQuery | null>(null);
  const [postureError, setPostureError] = useState("");
  const [postureBusy, setPostureBusy] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [result, setResult] = useState<PrivacyRequestQuery | null>(null);
  const [requestError, setRequestError] = useState("");
  const [creationError, setCreationError] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestType, setRequestType] = useState<PrivacyRequestType>("ACCESS");
  const [purpose, setPurpose] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueDate);
  const [minimumDueDate] = useState(() =>
    dateInputValue(new Date(Date.now() + 86_400_000)),
  );
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const generation = useRef(0);
  const request = readFragment(
    PrivacyRequestFieldsFragmentDoc,
    result?.privacyRequest,
  );
  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestBusy || !purpose.trim() || !dueDate) return;
    setRequestBusy(true);
    setCreationError("");
    setCreatedRequestId(null);
    try {
      const response = await executeBrowserGraphQL(
        CreatePrivacyRequestDocument,
        {
          input: {
            requestType,
            personIds: [personId],
            purpose: purpose.trim(),
            dueAt: dueAtForDate(dueDate),
            idempotencyKey: crypto.randomUUID(),
          },
        },
      );
      if (!response.ok || !response.data.createPrivacyRequest) {
        setCreationError(
          "Privacy request could not be created. Check current privacy permissions and purpose coverage.",
        );
        return;
      }
      const created = readFragment(
        PrivacyRequestFieldsFragmentDoc,
        response.data.createPrivacyRequest,
      );
      if (!created.id) {
        setCreationError("Privacy request could not be created.");
        return;
      }
      setCreatedRequestId(created.id);
      setRequestId(created.id);
      setPurpose("");
    } catch {
      setCreationError("Privacy request could not be created.");
    } finally {
      setRequestBusy(false);
    }
  }
  async function loadPosture() {
    setPosture(null);
    setPostureError("");
    setPostureBusy(true);
    try {
      const response = await executeBrowserGraphQL(PrivacyRetentionDocument, {
        resourceKind: "PERSON",
        resourceId: personId,
        first: 25,
      });
      if (response.ok && response.data.retentionDecision)
        setPosture(response.data);
      else
        setPostureError(
          "Privacy posture is unavailable. Current privacy permissions are required.",
        );
    } catch {
      setPostureError(
        "Privacy posture is unavailable. Current privacy permissions are required.",
      );
    } finally {
      setPostureBusy(false);
    }
  }
  async function lookup() {
    const current = ++generation.current;
    setResult(null);
    setRequestError("");
    setRequestBusy(true);
    try {
      const response = await executeBrowserGraphQL(PrivacyRequestDocument, {
        id: requestId.trim(),
      });
      if (current !== generation.current) return;
      if (response.ok && response.data.privacyRequest) setResult(response.data);
      else
        setRequestError(
          "Privacy request is unavailable. Check the identifier and current privacy permissions.",
        );
    } catch {
      if (current === generation.current)
        setRequestError(
          "Privacy request is unavailable. Check the identifier and current privacy permissions.",
        );
    } finally {
      if (current === generation.current) setRequestBusy(false);
    }
  }
  return (
    <section
      className="border-border bg-card space-y-6 rounded-2xl border p-6"
      aria-labelledby="person-privacy-heading"
    >
      <div>
        <h2 id="person-privacy-heading" className="text-xl font-semibold">
          Privacy Requests
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Review this person’s retention and legal-hold metadata. These
          read-only checks never approve a request, lift a hold or claim
          external processor completion.
        </p>
      </div>
      <form
        aria-label="Create person privacy request"
        className="border-border bg-muted/30 space-y-4 rounded-xl border p-4"
        onSubmit={(event) => void createRequest(event)}
      >
        <div>
          <h3 className="font-semibold">Create a request for this person</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Requests are workspace-scoped and audited. A reviewer must verify
            and approve them before any fulfillment or deletion work occurs.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="privacy-request-type">Request type</Label>
          <select
            id="privacy-request-type"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as PrivacyRequestType)
            }
            disabled={requestBusy}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="ACCESS">Access</option>
            <option value="CORRECTION">Correction</option>
            <option value="EXPORT">Export</option>
            <option value="RESTRICTION">Restriction</option>
            <option value="CONSENT_WITHDRAWAL">Consent withdrawal</option>
            <option value="DELETION">Deletion</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="privacy-request-purpose">Purpose</Label>
          <Input
            id="privacy-request-purpose"
            value={purpose}
            required
            maxLength={200}
            onChange={(event) => setPurpose(event.target.value)}
            disabled={requestBusy}
            placeholder="Why is this request needed?"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="privacy-request-due-date">Due date</Label>
          <Input
            id="privacy-request-due-date"
            type="date"
            value={dueDate}
            required
            min={minimumDueDate}
            onChange={(event) => setDueDate(event.target.value)}
            disabled={requestBusy}
          />
          <p className="text-muted-foreground text-xs">
            The server validates the deadline and keeps it within the governed
            request window.
          </p>
        </div>
        <Button disabled={requestBusy || !purpose.trim() || !dueDate}>
          {requestBusy ? "Creating…" : "Create privacy request"}
        </Button>
        {createdRequestId ? (
          <p role="status" className="text-sm">
            Privacy request created. Request ID: {createdRequestId}. It is ready
            for authorized review.
          </p>
        ) : null}
      </form>
      {creationError ? <p role="alert">{creationError}</p> : null}
      <Button onClick={() => void loadPosture()} disabled={postureBusy}>
        Load privacy posture
      </Button>
      {postureError ? <p role="alert">{postureError}</p> : null}
      {posture ? (
        <div className="space-y-3">
          <h3 className="font-semibold">Person retention and holds</h3>
          <p>
            Retention state: {posture.retentionDecision?.state ?? "Unavailable"}
          </p>
          <ul>
            {(posture.privacyLegalHolds ?? []).map((hold) => (
              <li key={hold.id}>{hold.state ?? "Unknown hold state"}</li>
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            Showing up to 25 returned hold records. An empty list does not
            establish permission to delete or process data.
          </p>
        </div>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (requestId.trim() && !requestBusy) void lookup();
        }}
      >
        <h3 className="font-semibold">Authorized request lookup</h3>
        <p className="text-muted-foreground text-sm">
          The API does not expose a person-filtered request list. Look up a
          known request ID; this lookup is workspace-authorized and does not
          establish that the request belongs to this person.
        </p>
        <Label htmlFor="privacy-request-id">Privacy request ID</Label>
        <Input
          id="privacy-request-id"
          value={requestId}
          required
          onChange={(event) => {
            generation.current += 1;
            setRequestId(event.target.value);
            setResult(null);
            setRequestError("");
            setRequestBusy(false);
          }}
        />
        <Button type="submit" disabled={!requestId.trim() || requestBusy}>
          Look up request
        </Button>
      </form>
      {requestError ? <p role="alert">{requestError}</p> : null}
      {request ? (
        <div className="space-y-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt>Request type</dt>
              <dd>{request.requestType}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{request.state}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{request.dueAt}</dd>
            </div>
            <div>
              <dt>Completion recorded</dt>
              <dd>{request.completedAt ?? "Not recorded"}</dd>
            </div>
          </dl>
          <h3 className="font-semibold">Processor propagation</h3>
          <ul>
            {(result?.privacyProcessorPropagations ?? []).map((row) => (
              <li key={row.id}>
                {row.processor}: {row.state} · attempts: {row.attempts}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            Only returned processor records are shown. No rows does not mean
            that every processor has completed the request.
          </p>
        </div>
      ) : null}
      <Link
        href="/settings/audit?resourceKind=privacy_request"
        className="text-primary text-sm underline"
      >
        Privacy audit administration
      </Link>
    </section>
  );
}
