"use client";

import { useState } from "react";

import { authClient } from "@/modules/auth/auth-client";

export function SignOutControl({
  navigate = (destination) => window.location.assign(destination),
}: {
  navigate?: (destination: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    setPending(true);
    setError(false);
    try {
      const response = await authClient.signOut();
      if (response.error) {
        setError(true);
        return;
      }
      navigate("/sign-in?signedOut=true");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <p role="status" className="text-destructive mt-1 max-w-44 text-xs">
          We couldn&apos;t sign you out. Try again.
        </p>
      ) : null}
    </div>
  );
}
