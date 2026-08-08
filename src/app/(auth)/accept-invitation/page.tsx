"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  AuthShell,
  AuthStatus,
  primaryButtonClassName,
  secondaryButtonClassName,
  textLinkClassName,
} from "@/components/auth/auth-shell";
import { useEphemeralHashParam } from "@/components/auth/use-location-search";
import { requestDirectRoute } from "@/lib/api/direct-route-client";
import { authClient } from "@/modules/auth/auth-client";

type InvitationPreview = {
  id: string;
  email: string;
  role: string;
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
  expiresAt: Date | string;
};

export default function AcceptInvitationPage() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [invitationId, setInvitationId] = useState<string | null>(null);
  const [handoffReady, setHandoffReady] = useState(false);
  const handoff = useEphemeralHashParam("id");
  const loading = Boolean(
    session && invitationId && !invitation && !error && !accepted,
  );

  useEffect(() => {
    if (!handoff.ready || handoffReady) return;
    let active = true;
    const establish = async () => {
      if (handoff.value) {
        const response = await requestDirectRoute<{ status?: boolean }>({
          body: { invitationId: handoff.value },
          method: "POST",
          url: "/api/account/invitations/handoff",
        });
        if (active && response.ok) setInvitationId(handoff.value);
      } else if (session) {
        const response = await requestDirectRoute<{ invitationId?: unknown }>({
          url: "/api/account/invitations/handoff",
        });
        if (response.ok && typeof response.data.invitationId === "string") {
          if (active) setInvitationId(response.data.invitationId);
        }
      }
      if (active) setHandoffReady(true);
    };
    void establish();
    return () => {
      active = false;
    };
  }, [handoff.ready, handoff.value, handoffReady, session]);

  useEffect(() => {
    if (
      !handoffReady ||
      sessionPending ||
      !session ||
      !invitationId ||
      invitation ||
      error ||
      accepted
    ) {
      return;
    }

    let active = true;

    void authClient.organization
      .getInvitation({ query: { id: invitationId } })
      .then((response) => {
        if (!active) return;
        if (response.error || !response.data) {
          setError(
            "This invitation is unavailable. It may have expired, been canceled, or already been used.",
          );
          return;
        }
        setInvitation(response.data as InvitationPreview);
      })
      .catch(() => {
        if (active) {
          setError(
            "This invitation is unavailable. It may have expired, been canceled, or already been used.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [
    accepted,
    error,
    invitation,
    invitationId,
    handoffReady,
    session,
    sessionPending,
  ]);

  const returnPath = "/accept-invitation";
  const signInHref = `/sign-in?returnTo=${encodeURIComponent(returnPath)}`;
  const signUpHref = `/sign-up?returnTo=${encodeURIComponent(returnPath)}`;

  async function acceptInvitation() {
    if (!invitationId || !invitation) return;

    setAccepting(true);
    setError(null);
    try {
      const response = await requestDirectRoute<{ status?: boolean }>({
        body: { invitationId },
        method: "POST",
        url: "/api/account/invitations/accept",
      });
      if (!response.ok) {
        setError(
          "We couldn't accept this invitation. Sign in with the verified email address that was invited and try again.",
        );
        return;
      }

      const activeResponse = await authClient.organization.setActive({
        organizationId: invitation.organizationId,
      });
      if (activeResponse.error || !activeResponse.data) {
        setError(
          "Your invitation was accepted, but we couldn't activate the workspace. Return home and select the workspace before continuing.",
        );
        return;
      }

      setAccepted(true);
      setInvitationId(null);
      await requestDirectRoute({
        method: "DELETE",
        url: "/api/account/invitations/handoff",
      });
    } catch {
      setError(
        "We couldn't accept this invitation. Sign in with the verified email address that was invited and try again.",
      );
    } finally {
      setAccepting(false);
    }
  }

  async function switchAccount() {
    await authClient.signOut();
    window.location.assign(signInHref);
  }

  if (!handoff.ready || !handoffReady || sessionPending) {
    return (
      <AuthShell
        eyebrow="Workspace invitation"
        title="Opening your invitation"
        description="Checking the invitation and your signed-in account."
      >
        <AuthStatus kind="info">Loading invitation…</AuthStatus>
      </AuthShell>
    );
  }

  if (!invitationId && !accepted) {
    return (
      <AuthShell
        eyebrow="Workspace invitation"
        title="Invitation link unavailable"
        description="Open the complete invitation link from your email."
      >
        <AuthStatus kind="error">
          This link does not include a valid invitation credential.
        </AuthStatus>
      </AuthShell>
    );
  }

  if (!session) {
    return (
      <AuthShell
        eyebrow="Workspace invitation"
        title="Sign in to accept"
        description="Use the verified email address that received this invitation."
      >
        <div className="space-y-3">
          <Link href={signInHref} className={primaryButtonClassName}>
            Sign in
          </Link>
          <Link
            href={signUpHref}
            className={`${secondaryButtonClassName} w-full`}
          >
            Create an account
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Workspace invitation"
      title={accepted ? "You joined the workspace" : "Review your invitation"}
      description={
        accepted
          ? "Your membership is active and the workspace is ready."
          : "Confirm the workspace and role before joining."
      }
      footer={
        !accepted ? (
          <p>
            Signed in as{" "}
            <span className="text-zinc-300">{session.user.email}</span>.{" "}
            <button
              type="button"
              onClick={switchAccount}
              className={textLinkClassName}
            >
              Use another account
            </button>
          </p>
        ) : undefined
      }
    >
      {accepted ? (
        <div className="space-y-5">
          <AuthStatus kind="success">
            Membership created. All access will be scoped to this workspace and
            your assigned role.
          </AuthStatus>
          <Link href="/" className={primaryButtonClassName}>
            Open workspace
          </Link>
        </div>
      ) : loading ? (
        <AuthStatus kind="info">Loading invitation details…</AuthStatus>
      ) : error ? (
        <div className="space-y-5">
          <AuthStatus kind="error">{error}</AuthStatus>
          <Link href="/" className={primaryButtonClassName}>
            Return home
          </Link>
        </div>
      ) : invitation ? (
        <div className="space-y-6">
          {!session.user.emailVerified ? (
            <AuthStatus kind="error">
              Verify your email address before accepting this invitation.
            </AuthStatus>
          ) : session.user.email.toLowerCase() !==
            invitation.email.toLowerCase() ? (
            <AuthStatus kind="error">
              This invitation belongs to a different email address. Sign in with
              the address that received it.
            </AuthStatus>
          ) : null}

          <dl className="divide-y divide-white/[0.07] rounded-2xl border border-white/10 bg-black/20 px-4">
            <InvitationDetail
              label="Workspace"
              value={invitation.organizationName}
            />
            <InvitationDetail label="Role" value={invitation.role} capitalize />
            <InvitationDetail
              label="Invited by"
              value={invitation.inviterEmail}
            />
            <InvitationDetail
              label="Expires"
              value={new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(invitation.expiresAt))}
            />
          </dl>

          <button
            type="button"
            onClick={acceptInvitation}
            disabled={
              accepting ||
              !session.user.emailVerified ||
              session.user.email.toLowerCase() !==
                invitation.email.toLowerCase()
            }
            className={primaryButtonClassName}
          >
            {accepting ? "Joining workspace…" : "Accept invitation"}
          </button>
        </div>
      ) : null}
    </AuthShell>
  );
}

function InvitationDetail({
  label,
  value,
  capitalize = false,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-4 py-3.5 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd
        className={`text-right text-zinc-200 ${capitalize ? "capitalize" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
