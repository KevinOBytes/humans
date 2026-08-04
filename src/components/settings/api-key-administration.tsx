"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CreateOrganizationApiKeyDocument,
  RevokeOrganizationApiKeyDocument,
  RotateOrganizationApiKeyDocument,
  type SettingsOrganizationApiKeysQuery,
} from "@/graphql/generated/graphql";

type ApiKey =
  SettingsOrganizationApiKeysQuery["settingsOrganizationApiKeys"]["nodes"][number];
type Feedback = { kind: "error" | "success"; message: string } | null;

const READ_ONLY_SCOPES = [
  "person:read",
  "fact:read",
  "relationship:read",
  "evidence:read",
  "source:read",
  "file:read",
  "search:read",
  "graph:read",
] as const;

const expiryOptions = [
  { label: "No expiry", value: "" },
  { label: "7 days", value: String(7 * 24 * 60 * 60) },
  { label: "30 days", value: String(30 * 24 * 60 * 60) },
  { label: "90 days", value: String(90 * 24 * 60 * 60) },
  { label: "1 year", value: String(365 * 24 * 60 * 60) },
] as const;

function readOnlySelection(allowedScopes: readonly string[]) {
  return new Set(
    READ_ONLY_SCOPES.filter((scope) => allowedScopes.includes(scope)),
  );
}

function expiryValue(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function mutationFeedback(code: string): Feedback {
  return code === "APPLIED"
    ? { kind: "success", message: "API-key changes were applied." }
    : {
        kind: "error",
        message: "The API-key request could not be completed.",
      };
}

export function ApiKeyAdministration({
  allowedScopes,
  apiKeys,
}: {
  allowedScopes: readonly string[];
  apiKeys: readonly ApiKey[];
}) {
  const router = useRouter();
  const initialScopes = useMemo(
    () => readOnlySelection(allowedScopes),
    [allowedScopes],
  );
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(initialScopes);
  const [mode, setMode] = useState<"custom" | "read-only">("read-only");
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  function resetForm() {
    setName("");
    setExpiry("");
    setScopes(readOnlySelection(allowedScopes));
    setMode("read-only");
    setRotating(null);
  }

  function selectPreset(value: "custom" | "read-only") {
    setMode(value);
    if (value === "read-only") setScopes(readOnlySelection(allowedScopes));
  }

  function toggleScope(scope: string) {
    setMode("custom");
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  function beginRotation(key: ApiKey) {
    setSecret(null);
    setCopied(false);
    setFeedback(null);
    setRotating(key);
    setName(`${key.name} replacement`);
    setExpiry("");
    setScopes(
      new Set(key.scopes.filter((scope) => allowedScopes.includes(scope))),
    );
    setMode("custom");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const selectedScopes = [...scopes].sort();
    if (selectedScopes.length === 0) {
      setFeedback({
        kind: "error",
        message: "Choose at least one allowed permission.",
      });
      return;
    }
    if (
      rotating &&
      !window.confirm(
        "Create the replacement and immediately revoke the selected API key? The original key will stop working after a successful rotation.",
      )
    ) {
      return;
    }

    setBusy(true);
    setFeedback(null);
    setSecret(null);
    setCopied(false);
    const common = {
      name,
      scopes: selectedScopes,
      ...(expiryValue(expiry) === undefined
        ? {}
        : { expiresInSeconds: expiryValue(expiry) }),
    };
    let payload: { code: string; secret?: string | null } | null = null;
    if (rotating) {
      const result = await executeBrowserGraphQL(
        RotateOrganizationApiKeyDocument,
        {
          input: { ...common, actionId: rotating.actionId },
        },
      );
      if (result.ok) payload = result.data.rotateOrganizationApiKey;
    } else {
      const result = await executeBrowserGraphQL(
        CreateOrganizationApiKeyDocument,
        {
          input: common,
        },
      );
      if (result.ok) payload = result.data.createOrganizationApiKey;
    }
    setBusy(false);
    if (!payload) {
      setFeedback({
        kind: "error",
        message: "The API-key request could not be completed.",
      });
      return;
    }
    setFeedback(mutationFeedback(payload.code));
    if (payload.code === "APPLIED" && payload.secret) {
      setSecret(payload.secret);
      resetForm();
      router.refresh();
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setFeedback({ kind: "success", message: "API key copied." });
    } catch {
      setFeedback({
        kind: "error",
        message:
          "Clipboard access was unavailable. Select and copy the key manually.",
      });
    }
  }

  async function revoke(key: ApiKey) {
    if (
      busy ||
      !window.confirm(
        `Revoke ${key.name}? This immediately disables the key and cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      RevokeOrganizationApiKeyDocument,
      {
        input: { actionId: key.actionId },
      },
    );
    setBusy(false);
    if (!result.ok) {
      setFeedback({
        kind: "error",
        message: "The API key could not be revoked.",
      });
      return;
    }
    setFeedback(mutationFeedback(result.data.revokeOrganizationApiKey.code));
    if (result.data.revokeOrganizationApiKey.code === "APPLIED") {
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <form
        aria-label={rotating ? "Rotate API key" : "Create API key"}
        className="border-border grid gap-4 rounded-xl border p-4"
        onSubmit={(event) => void submit(event)}
      >
        <div>
          <h3 className="font-semibold">
            {rotating ? `Rotate ${rotating.name}` : "Create API key"}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm leading-6">
            {rotating
              ? "A replacement is generated before the current key is revoked."
              : "Use the smallest permission set needed for this integration."}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              maxLength={100}
              required
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key-expiry">Expiry</Label>
            <select
              id="api-key-expiry"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              disabled={busy}
              className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            >
              {expiryOptions.map((option) => (
                <option key={option.value || "never"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Permissions</legend>
          <div className="flex flex-wrap gap-2" aria-label="Permission preset">
            <Button
              type="button"
              size="sm"
              variant={mode === "read-only" ? "default" : "outline"}
              disabled={busy}
              onClick={() => selectPreset("read-only")}
            >
              Read-only research preset
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "custom" ? "default" : "outline"}
              disabled={busy}
              onClick={() => selectPreset("custom")}
            >
              Custom permissions
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {allowedScopes.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.has(scope)}
                  disabled={busy}
                  onChange={() => toggleScope(scope)}
                />
                <span className="font-mono text-xs">{scope}</span>
              </label>
            ))}
          </div>
          {allowedScopes.length === 0 ? (
            <p className="text-destructive text-sm" role="alert">
              No API-key permissions are available for this session.
            </p>
          ) : null}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || allowedScopes.length === 0}>
            {busy
              ? "Working…"
              : rotating
                ? "Create replacement and revoke"
                : "Create API key"}
          </Button>
          {rotating ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={resetForm}
            >
              Cancel rotation
            </Button>
          ) : null}
        </div>
      </form>

      {secret ? (
        <section
          aria-labelledby="new-api-key"
          className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4"
        >
          <h3 id="new-api-key" className="font-semibold">
            Save this API key now
          </h3>
          <p className="mt-1 text-sm leading-6">
            This plaintext key is shown only once. Copy it to your secret
            manager before closing this message; it cannot be recovered later.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Input
              aria-label="New API key"
              value={secret}
              readOnly
              className="font-mono text-xs md:max-w-xl"
            />
            <Button type="button" onClick={() => void copySecret()}>
              {copied ? "Copied" : "Copy API key"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSecret(null)}
            >
              I saved it
            </Button>
          </div>
        </section>
      ) : null}

      {feedback ? (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={
            feedback.kind === "error"
              ? "text-destructive"
              : "text-emerald-700 dark:text-emerald-300"
          }
        >
          {feedback.message}
        </p>
      ) : null}

      <ul className="grid gap-3">
        {apiKeys.map((apiKey) => (
          <li
            key={apiKey.actionId}
            className="border-border rounded-xl border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">{apiKey.name}</p>
                <p className="text-muted-foreground mt-1 font-mono text-xs">
                  {apiKey.fingerprint}
                </p>
              </div>
              <Badge>{apiKey.state}</Badge>
            </div>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Scopes</dt>
                <dd className="mt-1 break-words">
                  {apiKey.scopes.join(", ") || "None"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Expires</dt>
                <dd className="mt-1">
                  {apiKey.expiresAt
                    ? new Date(apiKey.expiresAt).toLocaleString()
                    : "No expiry recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last used</dt>
                <dd className="mt-1">
                  {apiKey.lastUsedAt
                    ? new Date(apiKey.lastUsedAt).toLocaleString()
                    : "Never"}
                </dd>
              </div>
            </dl>
            {apiKey.state === "active" ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => beginRotation(apiKey)}
                >
                  Rotate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void revoke(apiKey)}
                >
                  Revoke
                </Button>
              </div>
            ) : null}
          </li>
        ))}
        {apiKeys.length === 0 ? (
          <li className="text-muted-foreground py-5 text-sm">
            No organization API keys are recorded.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
