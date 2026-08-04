import Link from "next/link";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";

export function PageControls({
  label,
  nextHref,
  nextLabel,
  resetHref,
}: {
  label: string;
  nextHref?: string | null;
  nextLabel: string;
  resetHref?: string | null;
}) {
  if (!nextHref && !resetHref) return null;
  return (
    <nav
      aria-label={`${label} pagination`}
      className="mt-4 flex flex-wrap gap-3"
    >
      {resetHref ? (
        <Link
          href={resetHref}
          className={buttonVariants({ variant: "outline" })}
        >
          First page
        </Link>
      ) : null}
      {nextHref ? (
        <Link
          href={nextHref}
          className={buttonVariants({ variant: "outline" })}
        >
          {nextLabel}
        </Link>
      ) : null}
    </nav>
  );
}

export function ResearchList({
  children,
  empty,
  title,
}: {
  children: ReactNode[];
  empty: string;
  title: string;
}) {
  const id = `${title.toLowerCase().replace(/[^a-z]+/gu, "-")}-heading`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children.length ? (
        <ul className="mt-4 grid gap-3">{children}</ul>
      ) : (
        <p className="border-border bg-card text-muted-foreground mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
          {empty}
        </p>
      )}
    </section>
  );
}
