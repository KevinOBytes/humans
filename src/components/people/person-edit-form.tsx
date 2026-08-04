"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  PersonForm,
  type PersonFormInput,
} from "@/components/people/person-form";
import { Button } from "@/components/ui/button";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  MutationIssueFragmentDoc,
  PersonSummaryFragmentDoc,
  UpdatePersonDocument,
  type PersonStatus,
} from "@/graphql/generated/graphql";

export type PersonEditProjection = {
  biography?: string | null;
  displayName: string;
  id: string;
  preferredName?: string | null;
  sensitivity: PersonFormInput["sensitivity"];
  sortName?: string | null;
  status: PersonStatus;
  version: number;
};

export function PersonEditForm({ person }: { person: PersonEditProjection }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const editableStatus =
    person.status === "ARCHIVED" || person.status === "MERGED"
      ? null
      : person.status;

  if (!editableStatus) return null;

  if (!editing) {
    return (
      <Button type="button" variant="outline" onClick={() => setEditing(true)}>
        Edit overview
      </Button>
    );
  }

  return (
    <div className="border-border mt-6 border-t pt-6">
      <PersonForm
        initial={{
          biography: person.biography ?? undefined,
          displayName: person.displayName,
          preferredName: person.preferredName ?? undefined,
          sensitivity: person.sensitivity,
          sortName: person.sortName ?? undefined,
          status: editableStatus,
        }}
        submitLabel="Save overview"
        cancelLabel="Cancel editing"
        submit={async (input: PersonFormInput) => {
          const result = await executeBrowserGraphQL(UpdatePersonDocument, {
            input: {
              id: person.id,
              expectedVersion: person.version,
              ...input,
            },
          });
          if (!result.ok) {
            const first = result.errors[0];
            return {
              code: first?.code,
              issues: result.errors.map((error) => ({
                code: error.code,
                message: error.message,
                path: [],
              })),
              person: null,
              requestId: first?.requestId,
            };
          }
          const payload = result.data.updatePerson;
          const updatedPerson = readFragment(
            PersonSummaryFragmentDoc,
            payload.person,
          );
          const issues = readFragment(MutationIssueFragmentDoc, payload.issues);
          return {
            code: payload.code,
            currentVersion: payload.currentVersion,
            issues,
            person: updatedPerson
              ? { id: updatedPerson.id, version: updatedPerson.version }
              : null,
            requestId: result.requestId,
          };
        }}
        onCancel={() => setEditing(false)}
        onReload={() => {
          setEditing(false);
          router.refresh();
        }}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
      />
    </div>
  );
}
