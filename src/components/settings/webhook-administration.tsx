"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CreateWorkspaceWebhookDocument,
  DisableWorkspaceWebhookDocument,
  RotateWorkspaceWebhookSecretDocument,
  type WorkspaceWebhooksQuery,
} from "@/graphql/generated/graphql";

type Webhook = WorkspaceWebhooksQuery["webhooks"]["nodes"][number];

export function WebhookAdministration({
  webhooks,
}: {
  webhooks: readonly Webhook[];
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("person.updated");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setSecret(null);
    const result = await executeBrowserGraphQL(CreateWorkspaceWebhookDocument, {
      input: {
        url,
        events: events
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      },
    });
    setBusy(false);
    if (!result.ok || result.data.createWebhook.code !== "APPLIED") {
      setMessage(
        "The webhook could not be created. Use a public HTTPS URL and valid event names.",
      );
      return;
    }
    setUrl("");
    setSecret(result.data.createWebhook.secret ?? null);
    setMessage("Webhook created. Save the one-time signing secret now.");
    router.refresh();
  }

  async function rotate(webhook: Webhook) {
    if (
      busy ||
      !window.confirm(
        "Rotate this webhook secret? Existing signatures will stop verifying.",
      )
    )
      return;
    setBusy(true);
    setSecret(null);
    const result = await executeBrowserGraphQL(
      RotateWorkspaceWebhookSecretDocument,
      { input: { id: webhook.id ?? "" } },
    );
    setBusy(false);
    if (!result.ok || result.data.rotateWebhookSecret.code !== "APPLIED") {
      setMessage("The webhook secret could not be rotated.");
      return;
    }
    setSecret(result.data.rotateWebhookSecret.secret ?? null);
    setMessage("Secret rotated. Save the new one-time secret.");
    router.refresh();
  }

  async function disable(webhook: Webhook) {
    if (
      busy ||
      !webhook.id ||
      !window.confirm("Disable this webhook? Pending deliveries will stop.")
    )
      return;
    setBusy(true);
    const result = await executeBrowserGraphQL(
      DisableWorkspaceWebhookDocument,
      { input: { id: webhook.id } },
    );
    setBusy(false);
    setMessage(
      result.ok && result.data.disableWebhook.code === "APPLIED"
        ? "Webhook disabled."
        : "The webhook could not be disabled.",
    );
    if (result.ok && result.data.disableWebhook.code === "APPLIED")
      router.refresh();
  }

  return (
    <div className="space-y-6">
      <form
        className="border-border grid gap-4 rounded-xl border p-4"
        onSubmit={(event) => void create(event)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Public HTTPS URL</Label>
            <Input
              id="webhook-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="webhook-events">Events (comma separated)</Label>
            <Input
              id="webhook-events"
              value={events}
              onChange={(event) => setEvents(event.target.value)}
              required
              disabled={busy}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Create webhook"}
          </Button>
          {message ? (
            <p role="status" className="text-muted-foreground text-sm">
              {message}
            </p>
          ) : null}
        </div>
      </form>
      {secret ? (
        <div
          role="alert"
          className="border-primary/40 bg-primary/5 rounded-xl border p-4 text-sm"
        >
          <p className="font-semibold">One-time signing secret</p>
          <p className="mt-2 font-mono break-all">{secret}</p>
          <p className="text-muted-foreground mt-2">
            This value is shown only once. Store it in your receiving service.
          </p>
        </div>
      ) : null}
      <ul className="grid gap-3">
        {webhooks.map((webhook) => (
          <li
            key={webhook.id}
            className="border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div>
              <p className="font-medium break-all">{webhook.url}</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {webhook.subscribedEvents.join(", ")} · {webhook.state}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !webhook.id}
                onClick={() => void rotate(webhook)}
              >
                Rotate
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !webhook.id}
                onClick={() => void disable(webhook)}
              >
                Disable
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {webhooks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No webhooks configured.</p>
      ) : null}
    </div>
  );
}
