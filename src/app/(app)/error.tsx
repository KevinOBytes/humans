"use client";

import { Button } from "@/components/ui/button";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section role="alert" className="grid min-h-[60svh] place-items-center">
      <div className="border-border bg-card max-w-lg rounded-2xl border p-8 text-center">
        <h1 className="text-2xl font-semibold">
          This research view could not be loaded
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          No data was changed. Try loading the view again.
        </p>
        <Button className="mt-6" type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </section>
  );
}
