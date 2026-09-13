"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CollaborationCreateInvestigationDocument,
  type CollaborationInvestigationsQuery,
} from "@/graphql/generated/graphql";

type Investigation = NonNullable<
  NonNullable<CollaborationInvestigationsQuery["investigations"]>["nodes"]
>[number];

export function InvestigationList({
  investigations,
  canCreate = true,
}: {
  investigations: NonNullable<
    CollaborationInvestigationsQuery["investigations"]
  >;
  canCreate?: boolean;
}) {
  const [nodes, setNodes] = useState<readonly Investigation[]>(
    investigations.nodes ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      CollaborationCreateInvestigationDocument,
      {
        title: String(data.get("title") ?? ""),
        objective: String(data.get("objective") ?? ""),
        purpose: String(data.get("purpose") ?? ""),
        ...(String(data.get("slug") ?? "").trim()
          ? { slug: String(data.get("slug")) }
          : {}),
        sensitivity: String(data.get("sensitivity") ?? "internal"),
        idempotencyKey: crypto.randomUUID(),
      },
    );
    setBusy(false);
    if (!result.ok || !result.data.createInvestigation) {
      setFeedback("The investigation could not be created.");
      return;
    }
    setNodes((current) => [result.data.createInvestigation!, ...current]);
    setFeedback("Investigation created.");
    form.reset();
  }

  return (
    <div className="space-y-6">
      {canCreate ? (
        <form
          onSubmit={create}
          aria-label="Create investigation"
          className="border-border bg-card grid gap-4 rounded-2xl border p-5 md:grid-cols-2"
        >
          <div className="space-y-2">
            <Label htmlFor="investigation-title">Title</Label>
            <Input
              id="investigation-title"
              name="title"
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="investigation-slug">Slug (optional)</Label>
            <Input id="investigation-slug" name="slug" maxLength={96} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="investigation-objective">Objective</Label>
            <textarea
              id="investigation-objective"
              name="objective"
              required
              maxLength={4000}
              className="border-input bg-background focus-visible:ring-ring/25 min-h-24 w-full rounded-xl border px-3.5 py-3 text-sm outline-none focus-visible:ring-2"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="investigation-purpose">Purpose</Label>
            <Input
              id="investigation-purpose"
              name="purpose"
              required
              maxLength={2000}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="investigation-sensitivity">Sensitivity</Label>
            <select
              id="investigation-sensitivity"
              name="sensitivity"
              defaultValue="internal"
              className="border-input bg-background min-h-11 w-full rounded-xl border px-3.5 text-sm"
            >
              <option value="public">Public</option>
              <option value="internal">Internal</option>
              <option value="confidential">Confidential</option>
              <option value="restricted">Restricted</option>
            </select>
          </div>
          <div className="flex items-end gap-3 md:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create investigation"}
            </Button>
            {feedback ? (
              <p
                role={
                  feedback.endsWith(".") &&
                  feedback !== "Investigation created."
                    ? "alert"
                    : "status"
                }
                className="text-muted-foreground text-sm"
              >
                {feedback}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}

      {nodes.length === 0 ? (
        <p className="border-border bg-muted/40 text-muted-foreground rounded-2xl border p-6">
          No investigations have been created in this workspace.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2" aria-label="Investigations">
          {nodes.map((investigation) => {
            const id = investigation.id;
            if (!id) return null;
            return (
              <article
                key={id}
                className="border-border bg-card rounded-2xl border p-5 transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-muted-foreground text-xs font-semibold tracking-[0.16em] uppercase">
                      {investigation.number
                        ? `INV-${String(investigation.number).padStart(3, "0")}`
                        : "Investigation"}
                    </p>
                    <h2 className="mt-2 text-xl font-semibold">
                      <Link
                        href={`/investigations/${id}`}
                        className="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
                      >
                        {investigation.title ?? "Untitled investigation"}
                      </Link>
                    </h2>
                  </div>
                  <Badge>{investigation.state ?? "unknown"}</Badge>
                </div>
                <p className="text-muted-foreground mt-4 line-clamp-3 text-sm leading-6">
                  {investigation.objective ?? "No objective recorded."}
                </p>
                <div className="text-muted-foreground mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                  <span>Purpose: {investigation.purpose ?? "—"}</span>
                  <span>Sensitivity: {investigation.sensitivity ?? "—"}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
