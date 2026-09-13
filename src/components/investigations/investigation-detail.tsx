"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CollaborationLinkCaseToInvestigationDocument,
  type CollaborationInvestigationCasesQuery,
  type CollaborationInvestigationQuery,
} from "@/graphql/generated/graphql";

type Investigation = NonNullable<
  CollaborationInvestigationQuery["investigation"]
>;
type CaseLink = NonNullable<
  NonNullable<
    CollaborationInvestigationCasesQuery["investigationCases"]
  >["nodes"]
>[number];

export function InvestigationDetail({
  investigation,
  initialCases,
  canEdit = true,
}: {
  investigation: Investigation;
  initialCases: NonNullable<
    CollaborationInvestigationCasesQuery["investigationCases"]
  >;
  canEdit?: boolean;
}) {
  const [cases, setCases] = useState<readonly CaseLink[]>(
    initialCases.nodes ?? [],
  );
  const [caseId, setCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function linkCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !caseId.trim()) return;
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      CollaborationLinkCaseToInvestigationDocument,
      {
        investigationId: investigation.id ?? "",
        caseId: caseId.trim(),
        idempotencyKey: crypto.randomUUID(),
      },
    );
    setBusy(false);
    if (!result.ok || !result.data.linkCaseToInvestigation) {
      setFeedback("The case could not be linked.");
      return;
    }
    setCases((current) => [result.data.linkCaseToInvestigation!, ...current]);
    setCaseId("");
    setFeedback("Case linked to investigation.");
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/investigations"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← All investigations
          </Link>
          <p className="text-primary mt-5 text-sm font-semibold">
            {investigation.number
              ? `INV-${String(investigation.number).padStart(3, "0")}`
              : "Investigation"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {investigation.title ?? "Untitled investigation"}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
            {investigation.objective ?? "No objective recorded."}
          </p>
        </div>
        <Badge>{investigation.state ?? "unknown"}</Badge>
      </div>

      <section className="border-border bg-card rounded-2xl border p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Investigation record</h2>
        <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground text-xs uppercase">Purpose</dt>
            <dd className="mt-1 text-sm">{investigation.purpose ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              Sensitivity
            </dt>
            <dd className="mt-1 text-sm">{investigation.sensitivity ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              Lead principal
            </dt>
            <dd
              className="mt-1 truncate text-sm"
              title={investigation.leadPrincipalId ?? undefined}
            >
              {investigation.leadPrincipalId ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">Slug</dt>
            <dd className="mt-1 text-sm">{investigation.slug ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="border-border bg-card rounded-2xl border p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Linked cases</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Only cases authorized for your current workspace and case membership
          can be linked or displayed.
        </p>
        {canEdit ? (
          <form
            onSubmit={linkCase}
            className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="investigation-case-id">Case ID</Label>
              <Input
                id="investigation-case-id"
                value={caseId}
                onChange={(event) => setCaseId(event.target.value)}
                placeholder="Workspace-scoped case UUID"
                required
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Linking…" : "Link case"}
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground mt-5 text-sm">
            Case linking is read-only for your role.
          </p>
        )}
        {feedback ? (
          <p
            role={
              feedback === "Case linked to investigation." ? "status" : "alert"
            }
            className="text-muted-foreground mt-3 text-sm"
          >
            {feedback}
          </p>
        ) : null}
        {cases.length === 0 ? (
          <p className="text-muted-foreground mt-6 text-sm">
            No authorized cases are linked yet.
          </p>
        ) : (
          <ul className="divide-border border-border mt-6 divide-y rounded-xl border">
            {cases.map((link) => (
              <li
                key={link.id ?? link.caseId}
                className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
              >
                <Link
                  href={`/cases?case=${link.caseId ?? ""}`}
                  className="text-primary font-medium hover:underline"
                >
                  Open case
                </Link>
                <span
                  className="text-muted-foreground truncate font-mono text-xs"
                  title={link.caseId ?? undefined}
                >
                  {link.caseId ?? "Unknown case"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
