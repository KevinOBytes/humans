"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  GraphFilterInput,
  GraphRelationshipState,
  Sensitivity,
} from "@/graphql/generated/graphql";
import type { GraphResult } from "@/modules/graph/types";

import type { RelationshipTypeOption } from "./relationship-editor";

const RELATIONSHIP_STATES = [
  "ASSERTED",
  "CORROBORATED",
  "DISPROVEN",
  "DISPUTED",
  "INACTIVE",
  "INFERRED",
] as const satisfies readonly GraphRelationshipState[];
const SENSITIVITIES = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
] as const satisfies readonly Sensitivity[];

type TemporalMode = "ALL" | "AT" | "RANGE";

function dateTimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function utc(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function toggle<T extends string>(
  current: readonly T[],
  value: T,
  checked: boolean,
) {
  return checked
    ? [...new Set([...current, value])].sort()
    : current.filter((item) => item !== value);
}

export function GraphFilterControls({
  catalogTruncated = false,
  disabled,
  onApply,
  relationshipTypes = [],
  result,
}: {
  catalogTruncated?: boolean;
  disabled?: boolean;
  onApply: (filter: GraphFilterInput) => Promise<void> | void;
  relationshipTypes?: readonly RelationshipTypeOption[];
  result: GraphResult;
}) {
  const normalized = result.normalizedFilter;
  const [selectedTypes, setSelectedTypes] = useState<readonly string[]>(
    normalized.relationshipTypeIds,
  );
  const [selectedStates, setSelectedStates] = useState<
    readonly GraphRelationshipState[]
  >(
    normalized.relationshipStates.map(
      (state) => state.toUpperCase() as GraphRelationshipState,
    ),
  );
  const [selectedSensitivities, setSelectedSensitivities] = useState<
    readonly string[]
  >(normalized.sensitivities.map((value) => value.toUpperCase()));
  const [minimumConfidence, setMinimumConfidence] = useState(
    normalized.minimumConfidence === null
      ? ""
      : String(normalized.minimumConfidence),
  );
  const [temporalMode, setTemporalMode] = useState<TemporalMode>(
    normalized.at
      ? "AT"
      : normalized.from || normalized.until
        ? "RANGE"
        : "ALL",
  );
  const [at, setAt] = useState(dateTimeLocal(normalized.at));
  const [from, setFrom] = useState(dateTimeLocal(normalized.from));
  const [until, setUntil] = useState(dateTimeLocal(normalized.until));
  const [pending, setPending] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [expanded, setExpanded] = useState(false);

  const typeOptions = useMemo(() => {
    const options = new Map(
      relationshipTypes.map((option) => [option.id, option]),
    );
    if (expanded) {
      for (const edge of result.edges) {
        if (!options.has(edge.relationshipTypeId)) {
          options.set(edge.relationshipTypeId, {
            id: edge.relationshipTypeId,
            label: edge.forwardLabel,
          });
        }
      }
    }
    return [...options.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    );
  }, [expanded, relationshipTypes, result.edges]);

  async function apply() {
    if (pending || disabled) return;
    const confidence = minimumConfidence.trim()
      ? Number(minimumConfidence)
      : undefined;
    const atUtc = temporalMode === "AT" ? utc(at) : undefined;
    const fromUtc = temporalMode === "RANGE" ? utc(from) : undefined;
    const untilUtc = temporalMode === "RANGE" ? utc(until) : undefined;
    if (
      confidence !== undefined &&
      (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      setValidationError(
        "Minimum confidence must be a number from 0 through 1.",
      );
      return;
    }
    if (temporalMode === "AT" && !atUtc) {
      setValidationError("Choose a valid instant for the time filter.");
      return;
    }
    if (temporalMode === "RANGE" && !fromUtc && !untilUtc) {
      setValidationError("Choose at least one valid range boundary.");
      return;
    }
    if (fromUtc && untilUtc && fromUtc > untilUtc) {
      setValidationError("The range start must not be after the range end.");
      return;
    }
    setValidationError("");
    setPending(true);
    try {
      await onApply({
        mode: normalized.mode,
        rootPersonIds: normalized.rootPersonIds,
        depth: normalized.depth,
        relationshipTypeIds: [...selectedTypes],
        relationshipStates: [...selectedStates],
        sensitivities: selectedSensitivities as Sensitivity[],
        minimumConfidence: confidence,
        at: atUtc,
        from: fromUtc,
        until: untilUtc,
        nodeLimit: normalized.nodeLimit,
        edgeLimit: normalized.edgeLimit,
        includeIsolates: normalized.includeIsolates,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      className="border-border mt-4 rounded-xl border p-4"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        Relationship and time filters
      </summary>
      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <fieldset>
          <legend className="text-sm font-semibold">Relationship types</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {typeOptions.map((option) => (
              <label
                key={option.id}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selectedTypes.includes(option.id)}
                  onChange={(event) =>
                    setSelectedTypes((current) =>
                      toggle(current, option.id, event.target.checked),
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
          {catalogTruncated ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Showing the first 25 active catalog types plus every type in this
              authorized graph. Additional catalog types are not silently
              selected.
            </p>
          ) : null}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold">Relationship states</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {RELATIONSHIP_STATES.map((state) => (
              <label
                key={state}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selectedStates.includes(state)}
                  onChange={(event) =>
                    setSelectedStates((current) =>
                      toggle(current, state, event.target.checked),
                    )
                  }
                />
                {state.toLocaleLowerCase()}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold">Sensitivity</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {SENSITIVITIES.map((sensitivity) => (
              <label
                key={sensitivity}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selectedSensitivities.includes(sensitivity)}
                  onChange={(event) =>
                    setSelectedSensitivities((current) =>
                      toggle(current, sensitivity, event.target.checked),
                    )
                  }
                />
                {sensitivity.toLocaleLowerCase()}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <Label htmlFor="graph-minimum-confidence">Minimum confidence</Label>
          <Input
            id="graph-minimum-confidence"
            className="mt-2"
            type="number"
            min="0"
            max="1"
            step="0.001"
            value={minimumConfidence}
            onChange={(event) => setMinimumConfidence(event.target.value)}
            placeholder="Any confidence"
          />
          <p className="text-muted-foreground mt-2 text-xs">
            Enter a value from 0 through 1. This filters the generated
            authorized graph before it is displayed.
          </p>
        </div>
        <fieldset className="lg:col-span-2">
          <legend className="text-sm font-semibold">Time overlap</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {(["ALL", "AT", "RANGE"] as const).map((mode) => (
              <label
                key={mode}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="graph-temporal-mode"
                  value={mode}
                  checked={temporalMode === mode}
                  onChange={() => setTemporalMode(mode)}
                />
                {mode === "ALL"
                  ? "All times"
                  : mode === "AT"
                    ? "At instant"
                    : "Overlapping range"}
              </label>
            ))}
          </div>
          {temporalMode === "AT" ? (
            <div className="mt-3 max-w-md">
              <Label htmlFor="graph-filter-at">At</Label>
              <Input
                id="graph-filter-at"
                className="mt-2"
                type="datetime-local"
                required
                value={at}
                onChange={(event) => setAt(event.target.value)}
              />
            </div>
          ) : temporalMode === "RANGE" ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="graph-filter-from">From</Label>
                <Input
                  id="graph-filter-from"
                  className="mt-2"
                  type="datetime-local"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="graph-filter-until">Until</Label>
                <Input
                  id="graph-filter-until"
                  className="mt-2"
                  type="datetime-local"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </div>
            </div>
          ) : null}
        </fieldset>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || pending} onClick={apply}>
          {pending ? "Applying…" : "Apply generated graph filters"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || pending}
          onClick={() => {
            setValidationError("");
            setSelectedTypes([]);
            setSelectedStates([]);
            setSelectedSensitivities([]);
            setMinimumConfidence("");
            setTemporalMode("ALL");
            setAt("");
            setFrom("");
            setUntil("");
          }}
        >
          Clear filter fields
        </Button>
      </div>
      <p
        role={validationError ? "alert" : "status"}
        aria-live="polite"
        className="text-destructive mt-3 min-h-5 text-sm"
      >
        {validationError}
      </p>
    </details>
  );
}
