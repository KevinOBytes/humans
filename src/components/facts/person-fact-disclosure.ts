import type { FactView } from "@/components/research/types";
export const WITHHELD_FACT_VALUE =
  "Value withheld: field-level consent coverage has not been verified for this request.";

// The current person page has no operation-bound field disclosure context.
// Never turn a previous client coverage check into authority to reveal values.
export function redactUngovernedFact(fact: FactView): FactView {
  if (fact.sensitivity.toUpperCase() === "PUBLIC") return fact;
  return {
    id: fact.id,
    namespace: fact.namespace,
    fieldKey: fact.fieldKey,
    label: fact.label,
    state: fact.state,
    reviewState: fact.reviewState,
    sensitivity: fact.sensitivity,
    value: WITHHELD_FACT_VALUE,
    confidence: null,
    temporalLabel: null,
    version: fact.version,
    selected: false,
    selectionVerified: false,
    selectionVersion: null,
    revisions: [],
    evidence: [],
    revisionNextHref: null,
    revisionResetHref: null,
    evidenceNextHref: null,
    evidenceResetHref: null,
  };
}
