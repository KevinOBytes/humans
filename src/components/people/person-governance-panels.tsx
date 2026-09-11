"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  ConsentCoverageDocument,
  type ConsentCoverageQuery,
  type GovernanceScope,
} from "@/graphql/generated/graphql";

const reasons: Record<string, string> = {
  MISSING_CONSENT: "No consent covers this request.",
  EXPIRED: "Consent has expired.",
  WITHDRAWN: "Consent has been withdrawn; processing is blocked.",
  FIELD_NOT_PERMITTED: "This field is not permitted.",
  CASE_NOT_PERMITTED: "This case is not permitted.",
  LEGAL_HOLD: "A legal hold restricts this operation.",
};

export function PersonGovernancePanels({ personId }: { personId: string }) {
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState<GovernanceScope>("READ");
  const [fieldDefinitionId, setFieldDefinitionId] = useState("");
  const [caseReference, setCaseReference] = useState("");
  const [coverage, setCoverage] = useState<
    ConsentCoverageQuery["consentCoverage"] | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  function invalidate() {
    generation.current += 1;
    setCoverage(null);
    setError("");
    setBusy(false);
  }
  async function check() {
    const request = ++generation.current;
    setBusy(true);
    setCoverage(null);
    setError("");
    try {
      const result = await executeBrowserGraphQL(ConsentCoverageDocument, {
        personId,
        purpose: purpose.trim(),
        scope,
        ...(fieldDefinitionId.trim()
          ? { fieldDefinitionId: fieldDefinitionId.trim() }
          : {}),
        ...(caseReference.trim()
          ? { caseReference: caseReference.trim() }
          : {}),
      });
      if (generation.current !== request) return;
      if (result.ok && result.data.consentCoverage)
        setCoverage(result.data.consentCoverage);
      else
        setError("Coverage could not be verified. No access has been granted.");
    } catch {
      if (generation.current === request)
        setError("Coverage could not be verified. No access has been granted.");
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="governance-heading"
      className="border-border bg-card space-y-5 rounded-2xl border p-6"
    >
      <div>
        <h2 id="governance-heading" className="text-xl font-semibold">
          Consent & Purpose
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Coverage is specific to actor, purpose, operation, field and case.
          This check does not grant access or authorize later operations; the
          server rechecks each request.
        </p>
      </div>
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (purpose.trim() && !busy) void check();
        }}
      >
        <div>
          <Label htmlFor="governance-purpose">Research purpose</Label>
          <Input
            id="governance-purpose"
            required
            maxLength={500}
            value={purpose}
            onChange={(event) => {
              invalidate();
              setPurpose(event.target.value);
            }}
          />
        </div>
        <div>
          <Label htmlFor="governance-scope">Operation</Label>
          <select
            id="governance-scope"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3"
            value={scope}
            onChange={(event) => {
              invalidate();
              setScope(event.target.value as GovernanceScope);
            }}
          >
            <option value="READ">Read</option>
            <option value="RESTRICTED_READ">Restricted read</option>
            <option value="WRITE">Write</option>
            <option value="EXPORT">Export</option>
            <option value="AI_OPERATION">AI operation</option>
          </select>
        </div>
        <div>
          <Label htmlFor="governance-field">
            Field definition ID (optional)
          </Label>
          <Input
            id="governance-field"
            value={fieldDefinitionId}
            onChange={(event) => {
              invalidate();
              setFieldDefinitionId(event.target.value);
            }}
          />
        </div>
        <div>
          <Label htmlFor="governance-case">Case reference (optional)</Label>
          <Input
            id="governance-case"
            value={caseReference}
            onChange={(event) => {
              invalidate();
              setCaseReference(event.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={!purpose.trim() || busy}>
          Check coverage
        </Button>
      </form>
      {coverage?.allowed ? (
        <p role="status">
          Covered for this request. Revalidation is required at the time of
          processing.
        </p>
      ) : coverage ? (
        <p role="alert">
          {reasons[coverage.reason ?? ""] ??
            "Processing is blocked for this request."}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Link
        className="text-primary block text-sm underline"
        href="/settings/policies"
      >
        Consent and purpose administration
      </Link>
      <Link className="text-primary block text-sm underline" href="/cases">
        Open research cases
      </Link>
    </section>
  );
}
