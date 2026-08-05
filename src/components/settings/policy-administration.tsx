"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import { UpdateWorkspaceDefaultsDocument } from "@/graphql/generated/graphql";

export function PolicyAdministration({
  version,
  locale: initialLocale,
  timezone: initialTimezone,
  retentionDays: initialRetentionDays,
  aiEnabled: initialAiEnabled,
  storageEnabled: initialStorageEnabled,
}: {
  version: number;
  locale: string;
  timezone: string;
  retentionDays: number | null;
  aiEnabled: boolean;
  storageEnabled: boolean;
}) {
  const router = useRouter();
  const [locale, setLocale] = useState(initialLocale);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [retentionDays, setRetentionDays] = useState(
    initialRetentionDays == null ? "" : String(initialRetentionDays),
  );
  const [aiEnabled, setAiEnabled] = useState(initialAiEnabled);
  const [storageEnabled, setStorageEnabled] = useState(initialStorageEnabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsedRetention =
      retentionDays.trim() === "" ? null : Number(retentionDays);
    if (
      parsedRetention !== null &&
      (!Number.isSafeInteger(parsedRetention) ||
        parsedRetention < 0 ||
        parsedRetention > 36_500)
    ) {
      setMessage("Retention must be a whole number between 0 and 36,500 days.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await executeBrowserGraphQL(
      UpdateWorkspaceDefaultsDocument,
      {
        input: {
          expectedVersion: version,
          locale: locale.trim(),
          timezone: timezone.trim(),
          retentionDays: parsedRetention,
          aiEnabled,
          storageEnabled,
        },
      },
    );
    setBusy(false);
    if (!result.ok || result.data.updateWorkspaceDefaults.code !== "APPLIED") {
      setMessage(
        "The settings changed elsewhere or could not be saved. Reload and try again.",
      );
      return;
    }
    setMessage("Workspace defaults saved.");
    router.refresh();
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="workspace-locale">Locale</Label>
          <Input
            id="workspace-locale"
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            maxLength={64}
            disabled={busy}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="workspace-timezone">Time zone</Label>
          <Input
            id="workspace-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            maxLength={64}
            disabled={busy}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="workspace-retention">Default retention (days)</Label>
          <Input
            id="workspace-retention"
            inputMode="numeric"
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
            placeholder="No automatic expiry"
            disabled={busy}
          />
        </div>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={aiEnabled}
          onChange={(event) => setAiEnabled(event.target.checked)}
          disabled={busy}
        />
        Enable workspace AI analysis
      </label>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={storageEnabled}
          onChange={(event) => setStorageEnabled(event.target.checked)}
          disabled={busy}
        />
        Enable file and image storage
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save defaults"}
        </Button>
        {message ? (
          <p role="status" className="text-muted-foreground text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
