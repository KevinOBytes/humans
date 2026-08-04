import Link from "next/link";

import type { PersonListItem } from "@/components/research/types";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type PeopleTableProps = {
  hasFilters: boolean;
  nextHref?: string | null;
  people: readonly PersonListItem[];
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});

export function PeopleTable({
  hasFilters,
  nextHref,
  people,
}: PeopleTableProps) {
  if (people.length === 0) {
    return (
      <section className="border-border bg-card rounded-2xl border border-dashed px-6 py-12 text-center">
        <h2 className="text-base font-semibold">
          {hasFilters
            ? "No people match these filters"
            : "No people have been added"}
        </h2>
        <p className="text-muted-foreground mx-auto mt-2 max-w-lg text-sm">
          {hasFilters
            ? "Try broadening the current search or clearing a filter."
            : "Create the first person record to begin this workspace's research."}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <div className="border-border bg-card overflow-x-auto rounded-2xl border shadow-sm">
        <Table aria-label="People in this workspace">
          <caption className="sr-only">People in this workspace</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sensitivity</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((person) => (
              <TableRow key={person.id}>
                <TableCell>
                  <p className="text-foreground font-semibold">
                    {person.displayName}
                  </p>
                  {person.preferredName ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Known as {person.preferredName}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge>{person.status.toLowerCase()}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="neutral">
                    {person.sensitivity.toLowerCase()}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  <time dateTime={person.updatedAt}>
                    {dateFormatter.format(new Date(person.updatedAt))}
                  </time>
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                    href={`/people/${person.id}`}
                  >
                    <span className="sr-only">Open {person.displayName}</span>
                    <span aria-hidden="true">View</span>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {nextHref ? (
        <div className="flex justify-end">
          <Link
            className={buttonVariants({ variant: "outline" })}
            href={nextHref}
          >
            Next page
          </Link>
        </div>
      ) : null}
    </div>
  );
}
