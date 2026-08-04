"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import {
  parseFactDraft,
  supportedFactValueType,
} from "@/components/facts/fact-value";
import {
  MutationFeedback,
  fieldMutationIssue,
  mutationFeedback,
  mutationIssues,
  transportMutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CreateFactDocument,
  SelectPersonFieldDocument,
  type FactValueType,
} from "@/graphql/generated/graphql";

export type FactDefinitionOption = {
  id: string;
  label: string;
  valueType: FactValueType;
  sensitivity: "CONFIDENTIAL" | "INTERNAL" | "PUBLIC" | "RESTRICTED";
};

export function FactForm({
  definitions,
  personId,
}: {
  definitions: readonly FactDefinitionOption[];
  personId: string;
}) {
  const router = useRouter();
  const supported = useMemo(
    () => definitions.filter((item) => supportedFactValueType(item.valueType)),
    [definitions],
  );
  const [definitionId, setDefinitionId] = useState(supported[0]?.id ?? "");
  const selected =
    supported.find((item) => item.id === definitionId) ?? supported[0];
  const [sensitivity, setSensitivity] = useState<
    FactDefinitionOption["sensitivity"]
  >(selected?.sensitivity ?? "INTERNAL");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !selected) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const parsed = parseFactDraft(selected.valueType, {
      value: String(form.get("value") ?? ""),
      valueEnd: String(form.get("valueEnd") ?? ""),
      unit: String(form.get("unit") ?? ""),
    });
    if ("error" in parsed) {
      setFeedback(
        mutationFeedback({
          code: "CLIENT_VALIDATION",
          fallback: "Review the fact value and try again.",
          issues: [
            {
              code: "INVALID_FACT_DRAFT",
              message: parsed.error,
              path: [parsed.field],
            },
          ],
        }),
      );
      return;
    }
    const confidence = Number(form.get("confidence"));
    setPending(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(CreateFactDocument, {
      input: {
        personId,
        definitionId: selected.id,
        value: parsed.value,
        state: String(form.get("state")) as
          "ASSERTED" | "DISPUTED" | "DISPROVEN" | "UNKNOWN",
        sensitivity,
        ...(Number.isFinite(confidence) ? { confidence } : {}),
      },
    });
    setPending(false);
    if (!result.ok) {
      setFeedback(
        transportMutationFeedback(
          result.errors,
          "The fact could not be saved.",
        ),
      );
      return;
    }
    const payload = result.data.createFact;
    if (!payload?.fact) {
      setFeedback(
        mutationFeedback({
          code: payload?.code ?? "SAVE_FAILED",
          currentVersion: payload?.currentVersion,
          fallback: "The fact could not be saved. Your draft is still here.",
          issues: mutationIssues(payload?.issues),
          requestId: result.requestId,
        }),
      );
      return;
    }
    formElement.reset();
    router.refresh();
  }

  if (!selected)
    return (
      <div className="border-border bg-card rounded-2xl border p-5 text-sm">
        <p className="text-muted-foreground">
          An administrator must create a supported fact definition before facts
          can be added.
        </p>
        {definitions.length ? (
          <p className="text-muted-foreground mt-2">
            {definitions.length} reference-based definition
            {definitions.length === 1 ? " is" : "s are"} unavailable until a
            verified resource picker is provided.
          </p>
        ) : null}
      </div>
    );

  const valueIssue = fieldMutationIssue(
    feedback,
    "value",
    "text",
    "boolean",
    "decimal",
    "dateStart",
    "json",
    "timestamp",
  );
  const valueEndIssue = fieldMutationIssue(feedback, "valueEnd", "dateEnd");
  const unitIssue = fieldMutationIssue(feedback, "unit");
  const confidenceIssue = fieldMutationIssue(feedback, "confidence");

  return (
    <form
      aria-label="Add fact"
      className="border-border bg-card grid gap-4 rounded-2xl border p-5"
      onSubmit={submit}
    >
      <h2 className="font-semibold">Add a fact claim</h2>
      {feedback ? (
        <MutationFeedback
          feedback={feedback}
          title="The fact was not saved"
          onReload={
            feedback.code === "CONFLICT" ? () => router.refresh() : undefined
          }
        />
      ) : null}
      {definitions.length > supported.length ? (
        <p className="text-muted-foreground text-sm">
          {definitions.length - supported.length} reference-based field
          {definitions.length - supported.length === 1 ? " is" : "s are"} hidden
          until a verified resource picker is available.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="fact-definition">Field</Label>
          <select
            id="fact-definition"
            name="definitionId"
            value={selected.id}
            onChange={(event) => {
              const next = supported.find(
                (definition) => definition.id === event.target.value,
              );
              if (!next) return;
              setDefinitionId(next.id);
              setSensitivity(next.sensitivity);
              setFeedback(null);
            }}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            {supported.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.label} ({definition.valueType.toLowerCase()})
              </option>
            ))}
          </select>
        </div>
        <FactValueEditor
          key={selected.id}
          valueType={selected.valueType}
          valueIssue={valueIssue?.message}
          valueEndIssue={valueEndIssue?.message}
          unitIssue={unitIssue?.message}
        />
        <div className="space-y-2">
          <Label htmlFor="fact-state">Claim state</Label>
          <select
            id="fact-state"
            name="state"
            defaultValue="ASSERTED"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option>ASSERTED</option>
            <option>DISPUTED</option>
            <option>DISPROVEN</option>
            <option>UNKNOWN</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="fact-sensitivity">Sensitivity</Label>
          <select
            id="fact-sensitivity"
            name="sensitivity"
            value={sensitivity}
            onChange={(event) =>
              setSensitivity(
                event.target.value as FactDefinitionOption["sensitivity"],
              )
            }
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option>PUBLIC</option>
            <option>INTERNAL</option>
            <option>CONFIDENTIAL</option>
            <option>RESTRICTED</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="fact-confidence">Confidence (0–1)</Label>
          <Input
            id="fact-confidence"
            name="confidence"
            type="number"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.5"
            aria-describedby={
              confidenceIssue ? "fact-confidence-error" : undefined
            }
            aria-invalid={Boolean(confidenceIssue)}
          />
          {confidenceIssue ? (
            <p id="fact-confidence-error" className="text-destructive text-sm">
              {confidenceIssue.message}
            </p>
          ) : null}
        </div>
      </div>
      <div>
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Add fact"}
        </Button>
      </div>
    </form>
  );
}

function FactValueEditor({
  unitIssue,
  valueEndIssue,
  valueIssue,
  valueType,
}: {
  unitIssue?: string;
  valueEndIssue?: string;
  valueIssue?: string;
  valueType: FactValueType;
}) {
  const valueProps = {
    "aria-describedby": valueIssue ? "fact-value-error" : undefined,
    "aria-invalid": Boolean(valueIssue),
  } as const;
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="fact-value">
          {valueType === "DATE_RANGE" ? "Start date" : "Value"}
        </Label>
        {valueType === "BOOLEAN" ? (
          <select
            id="fact-value"
            name="value"
            defaultValue=""
            required
            {...valueProps}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="" disabled>
              Choose true or false
            </option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        ) : valueType === "JSON" || valueType === "RICH_TEXT" ? (
          <textarea
            id="fact-value"
            name="value"
            required
            rows={valueType === "JSON" ? 5 : 4}
            {...valueProps}
            className="border-input bg-background w-full rounded-xl border px-3 py-2 text-sm"
          />
        ) : (
          <Input
            id="fact-value"
            name="value"
            required
            type={
              valueType === "DATE" || valueType === "DATE_RANGE"
                ? "date"
                : valueType === "TIMESTAMP"
                  ? "datetime-local"
                  : valueType === "URI"
                    ? "url"
                    : "text"
            }
            inputMode={
              ["DECIMAL", "DURATION", "INTEGER", "QUANTITY"].includes(valueType)
                ? "decimal"
                : undefined
            }
            {...valueProps}
          />
        )}
        {valueIssue ? (
          <p id="fact-value-error" className="text-destructive text-sm">
            {valueIssue}
          </p>
        ) : null}
      </div>
      {valueType === "DATE_RANGE" ? (
        <div className="space-y-2">
          <Label htmlFor="fact-value-end">End date</Label>
          <Input
            id="fact-value-end"
            name="valueEnd"
            type="date"
            required
            aria-describedby={
              valueEndIssue ? "fact-value-end-error" : undefined
            }
            aria-invalid={Boolean(valueEndIssue)}
          />
          {valueEndIssue ? (
            <p id="fact-value-end-error" className="text-destructive text-sm">
              {valueEndIssue}
            </p>
          ) : null}
        </div>
      ) : null}
      {valueType === "DURATION" || valueType === "QUANTITY" ? (
        <div className="space-y-2">
          <Label htmlFor="fact-unit">Unit</Label>
          <Input
            id="fact-unit"
            name="unit"
            required
            aria-describedby={unitIssue ? "fact-unit-error" : undefined}
            aria-invalid={Boolean(unitIssue)}
          />
          {unitIssue ? (
            <p id="fact-unit-error" className="text-destructive text-sm">
              {unitIssue}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FactSelectionButton({
  expectedVersion,
  factId,
  fieldKey,
  namespace,
  personId,
  selected,
}: {
  expectedVersion?: number | null;
  factId: string;
  fieldKey: string;
  namespace: string;
  personId: string;
  selected: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  if (selected) return null;
  async function select() {
    if (
      !window.confirm(
        "Select this claim for presentation while keeping competing claims visible?",
      )
    )
      return;
    setPending(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(SelectPersonFieldDocument, {
      input: {
        personId,
        factId,
        namespace,
        fieldKey,
        expectedVersion: expectedVersion ?? undefined,
        selectionReason: "Selected from person profile",
      },
    });
    setPending(false);
    if (!result.ok) {
      setFeedback(
        transportMutationFeedback(
          result.errors,
          "The presentation selection could not be changed.",
        ),
      );
      return;
    }
    const payload = result.data.selectPersonField;
    if (!payload?.selection) {
      setFeedback(
        mutationFeedback({
          code: payload?.code ?? "SAVE_FAILED",
          currentVersion: payload?.currentVersion,
          fallback:
            "The presentation selection could not be changed. Competing claims remain unchanged.",
          issues: mutationIssues(payload?.issues),
          requestId: result.requestId,
        }),
      );
      return;
    }
    router.refresh();
  }
  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void select()}
      >
        {pending ? "Selecting…" : "Select for presentation"}
      </Button>
      {feedback ? (
        <div className="mt-3">
          <MutationFeedback
            feedback={feedback}
            title="Selection not changed"
            onReload={
              feedback.code === "CONFLICT" ? () => router.refresh() : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
