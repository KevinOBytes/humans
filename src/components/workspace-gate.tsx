"use client";

import { useState, type FormEvent } from "react";

import type { WorkspaceActionResult } from "@/app/(app)/workspace-actions";
import type { WorkspaceOption } from "@/components/research/types";
import { SignOutControl } from "@/components/auth/sign-out-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/modules/auth/auth-client";

export function WorkspaceGate({
  createWorkspace,
  organizations,
}: {
  createWorkspace: (formData: FormData) => Promise<WorkspaceActionResult>;
  organizations: readonly WorkspaceOption[];
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function activate(organizationId: string) {
    setPending(true);
    setMessage(null);
    try {
      const result = await authClient.organization.setActive({
        organizationId,
      });
      if (result.error) {
        setMessage("That workspace could not be activated.");
        return;
      }
      window.location.assign("/dashboard");
    } catch {
      setMessage("That workspace could not be activated.");
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    const result = await createWorkspace(new FormData(event.currentTarget));
    setPending(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    await activate(result.organizationId);
  }

  return (
    <main className="bg-background grid min-h-svh place-items-center px-4 py-10">
      <section
        className="border-border bg-card w-full max-w-2xl rounded-3xl border p-6 shadow-xl sm:p-10"
        aria-labelledby="workspace-gate-title"
      >
        <p className="text-primary text-xs font-semibold tracking-[0.18em] uppercase">
          Humans research
        </p>
        <h1
          id="workspace-gate-title"
          className="mt-3 text-3xl font-semibold tracking-tight"
        >
          Choose a workspace
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          Research records stay isolated by workspace. Select one you already
          belong to, or create a new research workspace.
        </p>
        <div className="mt-4">
          <SignOutControl />
        </div>
        {message ? (
          <p
            role="alert"
            className="bg-destructive/10 text-destructive mt-5 rounded-xl p-3 text-sm"
          >
            {message}
          </p>
        ) : null}
        {organizations.length > 0 ? (
          <div className="mt-7">
            <h2 className="text-sm font-semibold">Available workspaces</h2>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {organizations.map((organization) => (
                <li key={organization.id}>
                  <Button
                    className="w-full justify-start"
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void activate(organization.id)}
                  >
                    {organization.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <form
          className="border-border mt-8 space-y-4 border-t pt-7"
          onSubmit={submit}
        >
          <h2 className="text-lg font-semibold">Create a workspace</h2>
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              name="name"
              required
              autoComplete="organization"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workspace-slug">Slug</Label>
            <Input
              id="workspace-slug"
              name="slug"
              placeholder="research-team"
              pattern="[a-z0-9](?:[a-z0-9]|-){2,62}"
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Working…" : "Create workspace"}
          </Button>
        </form>
      </section>
    </main>
  );
}
