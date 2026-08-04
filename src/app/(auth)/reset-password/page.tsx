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
import { useEphemeralHashParam } from "@/components/auth/use-location-search";
import { authClient } from "@/modules/auth/auth-client";

const RESET_ERROR =
  "This reset link is invalid or has expired. Request a new link and try again.";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const { ready: tokenReady, value: token } = useEphemeralHashParam("token");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError(RESET_ERROR);
      return;
    }

    if (password.length < 16) {
      setError("Your new password must contain at least 16 characters.");
      return;
    }

    if (password !== confirmation) {
      setError("The password confirmation does not match.");
      return;
    }

    setPending(true);
    try {
      const response = await authClient.resetPassword({
        newPassword: password,
        token,
      });

      if (response.error) {
        setError(RESET_ERROR);
        return;
      }

      setPassword("");
      setConfirmation("");
      setComplete(true);
      window.history.replaceState(null, "", "/reset-password");
    } catch {
      setError(RESET_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Choose a new password"
      description="Your new password will revoke your other sessions and must be at least 16 characters."
      footer={
        <Link href="/sign-in" className={textLinkClassName}>
          Return to sign in
        </Link>
      }
    >
      {!tokenReady ? (
        <AuthStatus kind="info">Checking your reset link…</AuthStatus>
      ) : complete ? (
        <div className="space-y-5">
          <AuthStatus kind="success">
            Your password has been updated and your previous sessions have been
            revoked.
          </AuthStatus>
          <Link
            href="/sign-in?passwordReset=true"
            className={primaryButtonClassName}
          >
            Sign in with the new password
          </Link>
        </div>
      ) : !token ? (
        <div className="space-y-5">
          <AuthStatus kind="error">{RESET_ERROR}</AuthStatus>
          <Link href="/forgot-password" className={primaryButtonClassName}>
            Request another link
          </Link>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit}>
          {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}

          <Field
            id="new-password"
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={16}
            hint="Use at least 16 characters. A password manager is recommended."
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={pending}
          />
          <Field
            id="confirm-password"
            label="Confirm new password"
            name="password-confirmation"
            type="password"
            autoComplete="new-password"
            minLength={16}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            disabled={pending}
          />

          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClassName}
          >
            {pending ? "Updating password…" : "Update password"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
