"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import {
  AuthShell,
  AuthStatus,
  Field,
  primaryButtonClassName,
  textLinkClassName,
} from "@/components/auth/auth-shell";
import { useLocationSearch } from "@/components/auth/use-location-search";
import { authClient } from "@/modules/auth/auth-client";
import { returnToFromSearch } from "@/modules/auth/return-to";

type ChallengeMethod = "totp" | "backup";

export default function TwoFactorPage() {
  const [method, setMethod] = useState<ChallengeMethod>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const locationSearch = useLocationSearch();
  const returnTo = returnToFromSearch(locationSearch ?? "");

  function selectMethod(nextMethod: ChallengeMethod) {
    setMethod(nextMethod);
    setCode("");
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response =
        method === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code: code.replace(/\s+/gu, ""),
              trustDevice,
            })
          : await authClient.twoFactor.verifyBackupCode({
              code: code.trim(),
              trustDevice,
            });

      if (response.error) {
        setError(
          "We couldn't verify that code. Check it and try again, or return to sign in.",
        );
        return;
      }

      setCode("");
      window.location.assign(returnTo);
    } catch {
      setError(
        "We couldn't verify that code. Check it and try again, or return to sign in.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Two-step verification"
      title="Confirm it’s you"
      description="Complete the second step before your session can access any workspace data."
      footer={
        <p>
          Need to start over?{" "}
          <Link href="/sign-in" className={textLinkClassName}>
            Return to sign in
          </Link>
        </p>
      }
    >
      <div className="mb-6 grid grid-cols-2 rounded-xl border border-white/10 bg-black/20 p-1">
        <button
          type="button"
          onClick={() => selectMethod("totp")}
          aria-pressed={method === "totp"}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-cyan-200 ${
            method === "totp"
              ? "bg-white/10 text-white shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Authenticator app
        </button>
        <button
          type="button"
          onClick={() => selectMethod("backup")}
          aria-pressed={method === "backup"}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-cyan-200 ${
            method === "backup"
              ? "bg-white/10 text-white shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Backup code
        </button>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit}>
        {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}

        <Field
          id="security-code"
          label={method === "totp" ? "Authentication code" : "Backup code"}
          name="security-code"
          type="text"
          inputMode={method === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={method === "totp" ? 8 : 64}
          hint={
            method === "totp"
              ? "Enter the current code from your authenticator app."
              : "Each backup code works once. It will be removed after a successful sign-in."
          }
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
          autoFocus
          disabled={pending}
          inputClassName={
            method === "totp" ? "font-mono tracking-[0.3em]" : "font-mono"
          }
        />

        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(event) => setTrustDevice(event.target.checked)}
            disabled={pending}
            className="mt-0.5 size-4 rounded border-white/20 bg-black/30 accent-cyan-300"
          />
          <span>
            Trust this private device
            <span className="mt-0.5 block text-xs leading-5 text-zinc-600">
              Skip this step temporarily. Never use this on a shared computer.
            </span>
          </span>
        </label>

        <button
          type="submit"
          disabled={pending}
          className={primaryButtonClassName}
        >
          {pending ? "Verifying…" : "Verify and continue"}
        </button>
      </form>
    </AuthShell>
  );
}
