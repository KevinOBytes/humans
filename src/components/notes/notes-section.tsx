import { notFound } from "next/navigation";

import { NoteForm, TagForm } from "@/components/research/research-record-forms";
import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  PersonNotesDocument,
  PersonTagsDocument,
  WorkspaceTagsDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import {
  cursorParam,
  type SearchState,
  stringParam,
} from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

export async function NotesSection({
  canApplyTag,
  canCreateNote,
  canCreateTag,
  personId,
  search,
}: {
  canApplyTag: boolean;
  canCreateNote: boolean;
  canCreateTag: boolean;
  personId: string;
  search: SearchState;
}) {
  const noteAfter = cursorParam(search, "noteAfter");
  const tagAfter = cursorParam(search, "tagAfter");
  const tagOptionAfter = cursorParam(search, "tagOptionAfter");
  const tagSearch = stringParam(search, "tagSearch")?.trim().slice(0, 100);
  const [noteData, tagData, tagOptions] = await Promise.all([
    executeServerGraphQL(PersonNotesDocument, {
      id: personId,
      first: 10,
      after: noteAfter,
    }),
    executeServerGraphQL(PersonTagsDocument, {
      id: personId,
      first: 10,
      after: tagAfter,
    }),
    canApplyTag
      ? executeServerGraphQL(WorkspaceTagsDocument, {
          first: 25,
          after: tagOptionAfter,
          filter: tagSearch ? { normalizedNamePrefix: tagSearch } : undefined,
        })
      : Promise.resolve(null),
  ]);
  if (!noteData.person || !tagData.person) notFound();
  const notes = noteData.person.notes?.nodes ?? [];
  const tags = tagData.person.tags?.nodes ?? [];
  const existingTags = (tagOptions?.tags?.nodes ?? []).flatMap((tag) =>
    tag?.id && tag.name && tag.normalizedName
      ? [
          {
            id: tag.id,
            name: tag.name,
            normalizedName: tag.normalizedName,
            color: tag.color,
          },
        ]
      : [],
  );
  const notePage = readFragment(
    PageDetailsFragmentDoc,
    noteData.person.notes?.pageInfo,
  );
  const tagPage = readFragment(
    PageDetailsFragmentDoc,
    tagData.person.tags?.pageInfo,
  );
  const optionPage = readFragment(
    PageDetailsFragmentDoc,
    tagOptions?.tags?.pageInfo,
  );
  const common = { noteAfter, tagAfter, tagOptionAfter, tagSearch };

  return (
    <section className="space-y-7">
      {canCreateNote ? <NoteForm personId={personId} /> : null}
      {canApplyTag ? (
        <section aria-labelledby="tag-editor-heading" className="space-y-4">
          <h2 id="tag-editor-heading" className="sr-only">
            Tag editor
          </h2>
          <form
            method="get"
            aria-label="Find a workspace tag"
            className="border-border bg-card flex flex-wrap items-end gap-3 rounded-xl border p-4"
          >
            <input type="hidden" name="view" value="notes" />
            <div className="min-w-56 flex-1 space-y-2">
              <label htmlFor="tag-search" className="text-sm font-medium">
                Find a workspace tag
              </label>
              <Input
                id="tag-search"
                name="tagSearch"
                defaultValue={tagSearch}
                placeholder="Name starts with"
              />
            </div>
            <button className={buttonVariants({ variant: "secondary" })}>
              Search tags
            </button>
          </form>
          <TagForm
            canCreate={canCreateTag}
            personId={personId}
            tags={existingTags}
          />
          <PageControls
            label="Workspace tag options"
            resetHref={
              tagOptionAfter
                ? profilePageHref(personId, "notes", {
                    ...common,
                    tagOptionAfter: undefined,
                  })
                : null
            }
            nextHref={
              optionPage?.hasNextPage && optionPage.endCursor
                ? profilePageHref(personId, "notes", {
                    ...common,
                    tagOptionAfter: optionPage.endCursor,
                  })
                : null
            }
            nextLabel="More workspace tags"
          />
        </section>
      ) : null}
      <ResearchList title="Tags" empty="No tags have been applied.">
        {tags.flatMap((tag) =>
          tag?.id && tag.name
            ? [
                <li key={tag.id}>
                  <Badge>{tag.name}</Badge>
                </li>,
              ]
            : [],
        )}
      </ResearchList>
      <PageControls
        label="Applied tags"
        resetHref={
          tagAfter
            ? profilePageHref(personId, "notes", {
                ...common,
                tagAfter: undefined,
              })
            : null
        }
        nextHref={
          tagPage?.hasNextPage && tagPage.endCursor
            ? profilePageHref(personId, "notes", {
                ...common,
                tagAfter: tagPage.endCursor,
              })
            : null
        }
        nextLabel="Next applied tags page"
      />
      <ResearchList title="Notes" empty="No notes have been recorded.">
        {notes.flatMap((note) =>
          note?.id
            ? [
                <li
                  key={note.id}
                  className="border-border bg-card rounded-xl border p-4"
                >
                  <p className="text-sm whitespace-pre-wrap">
                    {note.sanitizedMarkdown ?? note.plainText ?? ""}
                  </p>
                  {note.createdBy?.label ? (
                    <p className="text-muted-foreground mt-3 text-xs">
                      By {note.createdBy.label}
                    </p>
                  ) : null}
                </li>,
              ]
            : [],
        )}
      </ResearchList>
      <PageControls
        label="Notes"
        resetHref={
          noteAfter
            ? profilePageHref(personId, "notes", {
                ...common,
                noteAfter: undefined,
              })
            : null
        }
        nextHref={
          notePage?.hasNextPage && notePage.endCursor
            ? profilePageHref(personId, "notes", {
                ...common,
                noteAfter: notePage.endCursor,
              })
            : null
        }
        nextLabel="Next notes page"
      />
    </section>
  );
}
