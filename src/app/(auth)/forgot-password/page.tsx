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
import { authClient } from "@/modules/auth/auth-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    try {
      await authClient.requestPasswordReset({
        email: email.trim().toLowerCase(),
        redirectTo: "/reset-password",
      });
    } catch {
      // The response remains deliberately indistinguishable so this form
      // cannot be used to discover registered email addresses.
    } finally {
      setEmail("");
      setSubmitted(true);
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Reset your password"
      description="Enter the email address associated with your account."
      footer={
        <Link href="/sign-in" className={textLinkClassName}>
          Return to sign in
        </Link>
      }
    >
      {submitted ? (
        <div className="space-y-5">
          <AuthStatus kind="success">
            If an account matches that address, a password-reset link is on its
            way.
          </AuthStatus>
          <p className="text-sm leading-6 text-zinc-400">
            Check your spam folder if it does not arrive. For security, the link
            expires and can only be used once.
          </p>
          <Link href="/sign-in" className={primaryButtonClassName}>
            Back to sign in
          </Link>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit}>
          <Field
            id="email"
            label="Email address"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClassName}
          >
            {pending ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
