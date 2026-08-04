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

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SIGN_UP_ERROR =
  "We couldn't create the account. Check the form and try again, or sign in if you already have an account.";

export default function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [pending, setPending] = useState(false);
  const locationSearch = useLocationSearch();
  const returnTo = returnToFromSearch(locationSearch ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalizedUsername = username.trim().toLowerCase();
    if (
      normalizedUsername.length < 3 ||
      normalizedUsername.length > 64 ||
      !USERNAME_PATTERN.test(normalizedUsername) ||
      password.length < 16 ||
      password !== confirmation
    ) {
      setError(
        password !== confirmation
          ? "The password confirmation does not match."
          : SIGN_UP_ERROR,
      );
      return;
    }

    setPending(true);
    try {
      const response = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        username: normalizedUsername,
        displayUsername: username.trim(),
        password,
        callbackURL: `/sign-in?verified=true&returnTo=${encodeURIComponent(returnTo)}`,
      });

      if (response.error) {
        setError(SIGN_UP_ERROR);
        return;
      }

      setPassword("");
      setConfirmation("");
      setComplete(true);
    } catch {
      setError(SIGN_UP_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Start researching"
      title="Create your account"
      description="Set up your identity. A workspace owner can then invite you into a shared research space."
      footer={
        <p>
          Already have an account?{" "}
          <Link
            href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}
            className={textLinkClassName}
          >
            Sign in
          </Link>
        </p>
      }
    >
      {complete ? (
        <div className="space-y-5">
          <AuthStatus kind="success">
            Check your email. If an account can be created for those details,
            you’ll receive a verification link shortly.
          </AuthStatus>
          <p className="text-sm leading-6 text-zinc-400">
            Verify your address before signing in. The link expires for your
            protection, but you can request another by attempting to sign in.
          </p>
          <Link
            href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}
            className={primaryButtonClassName}
          >
            Continue to sign in
          </Link>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit}>
          {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}

          <Field
            id="name"
            label="Display name"
            name="name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
            disabled={pending}
          />

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

          <Field
            id="username"
            label="Username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            minLength={3}
            maxLength={64}
            pattern="[A-Za-z0-9](?:[A-Za-z0-9]|_|-)*"
            hint="3–64 characters. Start with a letter or number; underscores and hyphens are allowed."
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            disabled={pending}
          />

          <Field
            id="new-password"
            label="Password"
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
            label="Confirm password"
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
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
