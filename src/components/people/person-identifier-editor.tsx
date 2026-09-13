"use client";
import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  MutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL, type GraphQLResult } from "@/graphql/client";
import {
  CreatePersonIdentifierDocument,
  UpdatePersonIdentifierDocument,
  ArchivePersonIdentifierDocument,
  type CreatePersonIdentifierMutation,
  type UpdatePersonIdentifierMutation,
  type ArchivePersonIdentifierMutation,
  type PersonIdentifierSummaryFragment,
  type Sensitivity,
  type PersonIdentifierVerificationState,
} from "@/graphql/generated/graphql";

export function PersonIdentifierEditor({
  personId,
  identifier,
  canUpdate,
  canDelete,
}: {
  personId: string;
  identifier?: PersonIdentifierSummaryFragment;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  const retryKey = useRef<string | null>(null);
  const archiveKey = useRef<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  function close() {
    setEditing(false);
    retryKey.current = null;
    setFeedback(null);
    trigger.current?.focus();
  }
  function finish(
    result: GraphQLResult<
      | CreatePersonIdentifierMutation
      | UpdatePersonIdentifierMutation
      | ArchivePersonIdentifierMutation
    >,
  ) {
    if (!result.ok) {
      setFeedback({
        code: result.errors[0]?.code ?? "SAVE_FAILED",
        fallback: "The identifier could not be saved.",
        issues: [],
        requestId: result.errors[0]?.requestId,
      });
      return;
    }
    const data = result.data;
    const payload =
      "createPersonIdentifier" in data
        ? data.createPersonIdentifier
        : "updatePersonIdentifier" in data
          ? data.updatePersonIdentifier
          : data.archivePersonIdentifier;
    if (!payload.identifier) {
      setFeedback({
        code: payload.code ?? "SAVE_FAILED",
        fallback: "The identifier could not be saved.",
        issues: payload.issues,
        requestId: result.requestId,
      });
      return;
    }
    close();
    archiveKey.current = null;
    router.refresh();
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !canUpdate) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    const data = new FormData(event.currentTarget);
    const value = String(data.get("value") ?? "");
    const fields = {
      namespace: String(data.get("namespace") ?? ""),
      identifierType: String(data.get("identifierType") ?? ""),
      issuer: String(data.get("issuer") ?? "") || null,
      sensitivity: String(data.get("sensitivity")) as Sensitivity,
      verificationState: String(
        data.get("verificationState"),
      ) as PersonIdentifierVerificationState,
      validFrom: String(data.get("validFrom") ?? "") || null,
      validUntil: String(data.get("validUntil") ?? "") || null,
      idempotencyKey: (retryKey.current ??= crypto.randomUUID()),
    };
    try {
      finish(
        identifier
          ? await executeBrowserGraphQL(UpdatePersonIdentifierDocument, {
              input: {
                ...fields,
                ...(value ? { value } : {}),
                id: identifier.id,
                expectedVersion: identifier.version,
              },
            })
          : await executeBrowserGraphQL(CreatePersonIdentifierDocument, {
              input: { ...fields, value, personId },
            }),
      );
    } catch {
      setFeedback({
        code: "SAVE_FAILED",
        fallback:
          "The identifier could not be saved. You can retry this request.",
        issues: [],
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function archive() {
    if (busy.current || !canDelete || !identifier) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    try {
      finish(
        await executeBrowserGraphQL(ArchivePersonIdentifierDocument, {
          input: {
            id: identifier.id,
            expectedVersion: identifier.version,
            idempotencyKey: (archiveKey.current ??= crypto.randomUUID()),
          },
        }),
      );
    } catch {
      setFeedback({
        code: "SAVE_FAILED",
        fallback:
          "The identifier could not be archived. You can retry this request.",
        issues: [],
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (!canUpdate && !canDelete) return null;
  return (
    <div className="mt-3 min-w-0 space-y-3 [overflow-wrap:anywhere]">
      {feedback ? (
        <MutationFeedback
          feedback={feedback}
          title="Identifier update failed"
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canUpdate ? (
          <Button
            ref={trigger}
            type="button"
            variant="outline"
            disabled={pending}
            aria-expanded={editing}
            aria-controls={`${id}-form`}
            aria-label={
              identifier
                ? `Edit ${identifier.identifierType} identifier`
                : "Add identifier"
            }
            onClick={() => {
              setEditing(true);
              retryKey.current = null;
              setFeedback(null);
            }}
          >
            {identifier ? "Edit" : "Add identifier"}
          </Button>
        ) : null}
        {identifier && canDelete ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            aria-label={`Archive ${identifier.identifierType} identifier`}
            onClick={() => void archive()}
          >
            {pending ? "Working…" : "Archive"}
          </Button>
        ) : null}
      </div>
      {editing && canUpdate ? (
        <form
          id={`${id}-form`}
          onSubmit={(event) => void submit(event)}
          onChange={() => {
            retryKey.current = null;
          }}
          className="space-y-3"
          aria-label={identifier ? "Edit identifier" : "Add identifier"}
        >
          <fieldset
            disabled={pending}
            className="grid min-w-0 gap-3 sm:grid-cols-2"
          >
            <legend className="mb-3 font-semibold">
              {identifier ? "Edit identifier" : "New identifier"}
            </legend>
            {(
              [
                ["namespace", "Namespace", identifier?.namespace ?? "", 64],
                [
                  "identifierType",
                  "Identifier type",
                  identifier?.identifierType ?? "",
                  100,
                ],
                ["issuer", "Issuer", identifier?.issuer ?? "", 300],
              ] as const
            ).map(([name, label, value, max]) => (
              <div key={name}>
                <Label htmlFor={`${id}-${name}`}>{label}</Label>
                <Input
                  id={`${id}-${name}`}
                  name={name}
                  defaultValue={value}
                  required={name !== "issuer"}
                  maxLength={max}
                  className="mt-2"
                />
              </div>
            ))}
            <div>
              <Label htmlFor={`${id}-value`}>
                {identifier ? "Replacement value" : "Value"}
              </Label>
              <Input
                id={`${id}-value`}
                name="value"
                defaultValue=""
                required={!identifier}
                maxLength={256}
                autoComplete="off"
                aria-describedby={`${id}-value-help`}
                className="mt-2"
              />
              <p
                id={`${id}-value-help`}
                className="text-muted-foreground mt-2 text-sm"
              >
                {identifier
                  ? "Leave blank to keep the existing value. Protected values are never loaded. Supply a replacement to change a protected namespace or sensitivity."
                  : "Non-public values are encrypted and remain redacted in the profile."}
              </p>
            </div>
            <div>
              <Label htmlFor={`${id}-sensitivity`}>Sensitivity</Label>
              <select
                id={`${id}-sensitivity`}
                name="sensitivity"
                defaultValue={identifier?.sensitivity ?? "INTERNAL"}
                className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-base"
              >
                {["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value.toLowerCase()}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div>
              <Label htmlFor={`${id}-verificationState`}>
                Verification state
              </Label>
              <select
                id={`${id}-verificationState`}
                name="verificationState"
                defaultValue={identifier?.verificationState ?? "UNVERIFIED"}
                className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-base"
              >
                {[
                  "UNVERIFIED",
                  "VERIFIED",
                  "DISPUTED",
                  "REVOKED",
                  "UNKNOWN",
                ].map((value) => (
                  <option key={value} value={value}>
                    {value.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            {(["validFrom", "validUntil"] as const).map((name) => (
              <div key={name}>
                <Label htmlFor={`${id}-${name}`}>
                  {name === "validFrom"
                    ? "Valid from (UTC)"
                    : "Valid until (UTC)"}
                </Label>
                <Input
                  id={`${id}-${name}`}
                  name={name}
                  defaultValue={identifier?.[name] ?? ""}
                  placeholder="2026-09-13T00:00:00.000Z"
                  className="mt-2"
                />
              </div>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save identifier"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
