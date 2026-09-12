"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ResearchAssignmentQueue } from "@/components/cases/research-assignment-queue";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CaseTimelineDocument,
  type CaseTimelineQuery,
  type ResearchCasesQuery,
} from "@/graphql/generated/graphql";

export function CaseWorkspace({
  cases,
}: {
  cases: ResearchCasesQuery["researchCases"];
}) {
  const [caseId, setCaseId] = useState("");
  const [timeline, setTimeline] = useState<
    CaseTimelineQuery["caseTimeline"] | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const visibleCases = (cases?.nodes ?? []).filter(
    (row) => row.id && row.title,
  );
  const selected = visibleCases.find((row) => row.id === caseId);
  async function load(id: string, after?: string) {
    const request = ++generation.current;
    setCaseId(id);
    setTimeline(null);
    setError("");
    setBusy(Boolean(id));
    if (!id) return;
    try {
      const response = await executeBrowserGraphQL(CaseTimelineDocument, {
        caseId: id,
        first: 25,
        ...(after ? { after } : {}),
      });
      if (request !== generation.current) return;
      if (response.ok && response.data.caseTimeline)
        setTimeline(response.data.caseTimeline);
      else
        setError(
          "Case resources are unavailable. Check current membership and permissions.",
        );
    } catch {
      if (request === generation.current)
        setError(
          "Case resources are unavailable. Check current membership and permissions.",
        );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-5" aria-labelledby="case-workspace-heading">
      <h1 id="case-workspace-heading" className="text-3xl font-semibold">
        Case workspace
      </h1>
      <p className="text-muted-foreground text-sm">
        Only cases returned by the server for your active membership appear
        here. The timeline contains linked resources, not a workspace-wide
        search. Opening a resource rechecks its permissions; it does not carry
        case authority to other pages.
      </p>
      <div>
        <Label htmlFor="research-case">Research case</Label>
        <select
          id="research-case"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3"
          value={caseId}
          onChange={(event) => void load(event.target.value)}
        >
          <option value="">Choose an authorized case</option>
          {visibleCases.map((row) => (
            <option key={row.id} value={row.id!}>
              {row.title}
            </option>
          ))}
        </select>
      </div>
      {cases?.pageInfo?.hasNextPage && cases.pageInfo.endCursor ? (
        <Link
          href={`/cases?after=${encodeURIComponent(cases.pageInfo.endCursor ?? "")}`}
          className="text-primary underline"
        >
          Next cases
        </Link>
      ) : null}
      {selected ? (
        <div className="border-border bg-card rounded-xl border p-4">
          <h2 className="font-semibold">{selected.title}</h2>
          <p>Purpose: {selected.purpose}</p>
          <p>State: {selected.state}</p>
        </div>
      ) : null}
      {busy ? <p role="status">Loading authorized case resources…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {timeline ? (
        <>
          <h2 className="text-xl font-semibold">Case timeline</h2>
          <ul className="space-y-3">
            {(timeline.nodes ?? [])
              .filter((row) => row.id && row.resourceId && row.resourceKind)
              .map((row) => (
                <li
                  key={row.id}
                  className="border-border rounded-xl border p-4"
                >
                  <p>
                    {row.resourceKind} ·{" "}
                    <time dateTime={row.observedAt ?? undefined}>
                      {row.observedAt ?? "Unknown time"}
                    </time>
                  </p>
                  {row.resourceKind?.toLowerCase() === "person" ? (
                    <Link
                      className="text-primary underline"
                      href={`/people/${encodeURIComponent(row.resourceId!)}`}
                    >
                      Open person {row.resourceId}
                    </Link>
                  ) : (
                    <p className="font-mono text-sm">{row.resourceId}</p>
                  )}
                </li>
              ))}
          </ul>
          {(timeline.nodes ?? []).length === 0 ? (
            <p>No linked resources are visible in this case.</p>
          ) : null}
          {timeline.pageInfo?.hasNextPage && timeline.pageInfo.endCursor ? (
            <Button
              onClick={() =>
                void load(caseId, timeline.pageInfo?.endCursor ?? undefined)
              }
            >
              Next resources
            </Button>
          ) : null}
        </>
      ) : null}
      {selected?.id ? (
        <ResearchAssignmentQueue key={selected.id} caseId={selected.id} />
      ) : null}
    </section>
  );
}
