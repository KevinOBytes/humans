import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export default function PersonNotFound() {
  return (
    <section className="border-border bg-card mx-auto max-w-xl rounded-2xl border p-8 text-center">
      <h1 className="text-2xl font-semibold">Person not found</h1>
      <p className="text-muted-foreground mt-3 text-sm">
        This record is unavailable in the current workspace.
      </p>
      <Link
        href="/people"
        className={`${buttonVariants({ variant: "outline" })} mt-6`}
      >
        Back to people
      </Link>
    </section>
  );
}
