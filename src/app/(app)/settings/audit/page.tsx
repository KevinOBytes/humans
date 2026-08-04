import Link from "next/link";

import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  type AuditEventFilterInput,
  SettingsAuditEventsDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { readOpaqueCursor } from "@/lib/research-pagination";
import { parseAuditDateTimeRange } from "@/modules/settings/audit-filter";

function readFilterValue(
  value: string | string[] | undefined,
): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  if (!selected || selected.length > 100 || selected.trim() !== selected) {
    return undefined;
  }
  return selected;
}

export default async function AuditSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await getAdministrativeSettingsContext();
  const params = await searchParams;
  const action = readFilterValue(params.action);
  const resourceKind = readFilterValue(params.resourceKind);
  const outcomeValue = readFilterValue(params.outcome)?.toUpperCase();
  const outcome =
    outcomeValue === "SUCCESS" || outcomeValue === "FAILURE"
      ? outcomeValue
      : undefined;
  const rawFrom = Array.isArray(params.from) ? params.from[0] : params.from;
  const rawUntil = Array.isArray(params.until) ? params.until[0] : params.until;
  const dateRange = parseAuditDateTimeRange(
    rawFrom && rawFrom.length <= 100 ? rawFrom : undefined,
    rawUntil && rawUntil.length <= 100 ? rawUntil : undefined,
  );
  const filter: AuditEventFilterInput = {
    ...(action ? { action } : {}),
    ...(resourceKind ? { resourceKind } : {}),
    ...(outcome ? { outcome } : {}),
    ...(!dateRange.rangeError && dateRange.from.iso
      ? { occurredFrom: dateRange.from.iso }
      : {}),
    ...(!dateRange.rangeError && dateRange.until.iso
      ? { occurredUntil: dateRange.until.iso }
      : {}),
  };
  const after = readOpaqueCursor(params.after);
  const data = await executeServerGraphQL(SettingsAuditEventsDocument, {
    first: 25,
    after,
    filter,
  });
  const connection = data.auditEvents;
  if (!connection?.nodes || !connection.pageInfo) {
    throw new Error("The audit history could not be loaded.");
  }
  const events = connection.nodes.filter(
    (event): event is NonNullable<typeof event> => event !== null,
  );
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries({
    action,
    resourceKind,
    outcome: outcome?.toLowerCase(),
    from: dateRange.from.input,
    until: dateRange.until.input,
  })) {
    if (value) nextParams.set(key, value);
  }
  if (connection.pageInfo.endCursor) {
    nextParams.set("after", connection.pageInfo.endCursor);
  }
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Audit"
        description="Bounded, server-redacted workspace history. Raw diffs, resource identifiers, and attribution identifiers are not requested by this page."
      />
      <SettingsCard
        title="Filters"
        description="Filter by exact safe action, resource kind, outcome, or a UTC date and time range."
      >
        {dateRange.rangeError ? (
          <p role="alert" className="text-destructive mb-4 text-sm">
            {dateRange.rangeError}
          </p>
        ) : null}
        <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="grid gap-1 text-sm font-medium">
            Action
            <input
              name="action"
              defaultValue={action}
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-lg border px-3 outline-none focus-visible:ring-2"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Resource kind
            <input
              name="resourceKind"
              defaultValue={resourceKind}
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-lg border px-3 outline-none focus-visible:ring-2"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Outcome
            <select
              name="outcome"
              defaultValue={outcome?.toLowerCase() ?? ""}
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-lg border px-3 outline-none focus-visible:ring-2"
            >
              <option value="">All</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            From (UTC)
            <input
              aria-describedby={
                dateRange.from.error ? "audit-from-error" : undefined
              }
              aria-invalid={dateRange.from.error ? true : undefined}
              name="from"
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DDTHH:mm"
              defaultValue={dateRange.from.input}
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-lg border px-3 outline-none focus-visible:ring-2"
            />
            {dateRange.from.error ? (
              <span
                id="audit-from-error"
                className="text-destructive font-normal"
              >
                {dateRange.from.error}
              </span>
            ) : null}
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Until (UTC)
            <input
              aria-describedby={
                dateRange.until.error ? "audit-until-error" : undefined
              }
              aria-invalid={dateRange.until.error ? true : undefined}
              name="until"
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DDTHH:mm"
              defaultValue={dateRange.until.input}
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-lg border px-3 outline-none focus-visible:ring-2"
            />
            {dateRange.until.error ? (
              <span
                id="audit-until-error"
                className="text-destructive font-normal"
              >
                {dateRange.until.error}
              </span>
            ) : null}
          </label>
          <button
            type="submit"
            className={buttonVariants({ variant: "outline" })}
          >
            Apply filters
          </button>
        </form>
      </SettingsCard>
      <SettingsCard title="Audit events">
        <ol className="grid gap-3">
          {events.map((event) => (
            <li
              key={`${event.requestId ?? "request"}:${event.occurredAt ?? "time"}:${event.action ?? "event"}`}
              className="border-border rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{event.action ?? "Audit event"}</p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {event.actor?.label ?? "Former actor"} ·{" "}
                    {event.actor?.kind ?? "LEGACY"} ·{" "}
                    {event.resourceKind ?? "resource"}
                  </p>
                </div>
                <Badge>{event.outcome?.toLowerCase() ?? "unknown"}</Badge>
              </div>
              <p className="text-muted-foreground mt-3 text-xs">
                {event.occurredAt ? (
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleString()}
                  </time>
                ) : (
                  "Time unavailable"
                )}{" "}
                · Request {event.requestId ?? "unavailable"}
              </p>
            </li>
          ))}
          {events.length === 0 ? (
            <li className="text-muted-foreground py-5 text-sm">
              No audit events match the current filters.
            </li>
          ) : null}
        </ol>
        {connection.pageInfo.hasNextPage && connection.pageInfo.endCursor ? (
          <div className="mt-5 flex justify-end">
            <Link
              href={`/settings/audit?${nextParams.toString()}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Next events
            </Link>
          </div>
        ) : null}
      </SettingsCard>
    </div>
  );
}
