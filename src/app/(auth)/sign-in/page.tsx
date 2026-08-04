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

const INVALID_CREDENTIALS_MESSAGE =
  "We couldn't sign you in with those credentials. Check your details and try again.";

export default function SignInPage() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const locationSearch = useLocationSearch();
  const search = new URLSearchParams(locationSearch ?? "");
  const returnTo = returnToFromSearch(locationSearch ?? "");
  const queryNotice =
    search.get("verified") === "true"
      ? "Your email is verified. You can sign in now."
      : search.get("passwordReset") === "true"
        ? "Your password was updated. Sign in with your new password."
        : search.get("securityChanged") === "true"
          ? "Your security settings changed. Sign in again to continue."
          : search.get("signedOut") === "true"
            ? "You have been signed out."
            : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    const account = identifier.trim();

    try {
      const response = account.includes("@")
        ? await authClient.signIn.email({
            email: account,
            password,
            rememberMe,
            callbackURL: returnTo,
          })
        : await authClient.signIn.username({
            username: account,
            password,
            rememberMe,
            callbackURL: returnTo,
          });

      if (response.error) {
        setError(INVALID_CREDENTIALS_MESSAGE);
        return;
      }

      const result = response.data as
        { twoFactorRedirect?: boolean; url?: string } | null | undefined;

      if (result?.twoFactorRedirect) {
        setNotice("Password accepted. Continue with your security code.");
        return;
      }

      window.location.assign(returnTo);
    } catch {
      setError(INVALID_CREDENTIALS_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in to Humans"
      description="Use your email address or username to open your research workspace."
      footer={
        <p>
          New to Humans?{" "}
          <Link
            href={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`}
            className={textLinkClassName}
          >
            Create an account
          </Link>
        </p>
      }
    >
      <form className="space-y-5" onSubmit={handleSubmit} noValidate={false}>
        {(notice ?? queryNotice) ? (
          <AuthStatus kind="success">{notice ?? queryNotice}</AuthStatus>
        ) : null}
        {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}

        <Field
          id="account"
          label="Email or username"
          name="account"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
          disabled={pending}
        />

        <div>
          <div className="mb-2 flex items-center justify-between gap-4">
            <label
              htmlFor="password"
              className="text-sm font-medium text-zinc-200"
            >
              Password
            </label>
            <Link
              href="/forgot-password"
              className={`text-xs ${textLinkClassName}`}
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={pending}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-[16px] text-white transition outline-none focus:border-cyan-300/60 focus:ring-3 focus:ring-cyan-300/10 sm:text-sm"
          />
        </div>

        <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(event) => setRememberMe(event.target.checked)}
            disabled={pending}
            className="size-4 rounded border-white/20 bg-black/30 accent-cyan-300"
          />
          Keep me signed in on this device
        </label>

        <button
          type="submit"
          disabled={pending}
          className={primaryButtonClassName}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
