"use client";

import { Button } from "@/components/ui/button";

export default function SettingsError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="border-border bg-card rounded-2xl border p-6">
      <h1 className="text-xl font-semibold">Settings could not be loaded</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Your settings data remains unchanged. Try the read again.
      </p>
      <Button type="button" variant="outline" className="mt-5" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
