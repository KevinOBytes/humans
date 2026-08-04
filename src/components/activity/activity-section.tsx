import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  PersonActivityDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { cursorParam, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

export async function ActivitySection({
  personId,
  search,
}: {
  personId: string;
  search: SearchState;
}) {
  const after = cursorParam(search, "activityAfter");
  const data = await executeServerGraphQL(PersonActivityDocument, {
    id: personId,
    first: 10,
    after,
  });
  const events = data.auditEvents?.nodes ?? [];
  const pageInfo = readFragment(
    PageDetailsFragmentDoc,
    data.auditEvents?.pageInfo,
  );
  return (
    <div className="space-y-4">
      <ResearchList
        title="Activity"
        empty="No visible activity has been recorded."
      >
        {events.flatMap((event) =>
          event?.id
            ? [
                <li
                  key={event.id}
                  className="border-border bg-card rounded-xl border p-4"
                >
                  <p className="font-semibold">
                    {event.action ?? "Research event"}
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {event.actor?.label ?? "System"} ·{" "}
                    {event.outcome ?? "SUCCESS"}
                    {event.occurredAt
                      ? ` · ${new Date(event.occurredAt).toLocaleString("en", { timeZone: "UTC" })}`
                      : ""}
                  </p>
                </li>,
              ]
            : [],
        )}
      </ResearchList>
      <PageControls
        label="Activity"
        resetHref={after ? profilePageHref(personId, "activity") : null}
        nextHref={
          pageInfo?.hasNextPage && pageInfo.endCursor
            ? profilePageHref(personId, "activity", {
                activityAfter: pageInfo.endCursor,
              })
            : null
        }
        nextLabel="Next activity page"
      />
    </div>
  );
}
