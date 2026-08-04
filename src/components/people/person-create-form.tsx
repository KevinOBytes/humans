"use client";

import { useRouter } from "next/navigation";

import {
  PersonForm,
  type PersonFormInput,
} from "@/components/people/person-form";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  CreatePersonDocument,
  MutationIssueFragmentDoc,
  PersonSummaryFragmentDoc,
} from "@/graphql/generated/graphql";

export function PersonCreateForm() {
  const router = useRouter();
  return (
    <PersonForm
      submit={async (input: PersonFormInput) => {
        const result = await executeBrowserGraphQL(CreatePersonDocument, {
          input,
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
        const payload = result.data.createPerson;
        const person = readFragment(PersonSummaryFragmentDoc, payload.person);
        const issues = readFragment(MutationIssueFragmentDoc, payload.issues);
        return {
          code: payload.code,
          currentVersion: payload.currentVersion,
          issues,
          person: person ? { id: person.id, version: person.version } : null,
          requestId: result.requestId,
        };
      }}
      onReload={() => router.refresh()}
      onSaved={(personId) => {
        router.push(`/people/${personId}`);
        router.refresh();
      }}
    />
  );
}
