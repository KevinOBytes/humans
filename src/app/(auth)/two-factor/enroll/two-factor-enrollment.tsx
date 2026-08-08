"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import {
  AuthShell,
  AuthStatus,
  Field,
  primaryButtonClassName,
  secondaryButtonClassName,
  textLinkClassName,
} from "@/components/auth/auth-shell";
import { requestDirectRoute } from "@/lib/api/direct-route-client";
import { authClient } from "@/modules/auth/auth-client";

type EnrollmentMaterial = {
  totpURI: string;
  backupCodes: string[];
};

function getManualSecret(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export default function TwoFactorEnrollment({
  twoFactorEnabled,
  navigate = (destination) => window.location.assign(destination),
}: {
  twoFactorEnabled: boolean;
  navigate?: (destination: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [enrollment, setEnrollment] = useState<EnrollmentMaterial | null>(null);
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [managementPassword, setManagementPassword] = useState("");
  const [replacementCodes, setReplacementCodes] = useState<string[] | null>(
    null,
  );
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);

  const manualSecret = useMemo(
    () => (enrollment ? getManualSecret(enrollment.totpURI) : ""),
    [enrollment],
  );

  async function beginEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setActionStatus(null);
    setPending(true);

    try {
      const response = await authClient.twoFactor.enable({ password });

      if (response.error || !response.data) {
        setPassword("");
        setError(
          "We couldn't start two-step verification. Check your password and try again.",
        );
        return;
      }

      setEnrollment({
        totpURI: response.data.totpURI,
        backupCodes: [...response.data.backupCodes],
      });
    } catch {
      setPassword("");
      setError(
        "We couldn't start two-step verification. Check your password and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  async function verifyEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setActionStatus(null);
    setPending(true);

    try {
      const response = await authClient.twoFactor.verifyTotp({
        code: verificationCode.replace(/\s+/gu, ""),
      });
      setVerificationCode("");

      if (response.error) {
        setError(
          "That code could not be verified. Wait for a new code and try again.",
        );
        return;
      }

      setEnrollment((current) =>
        current ? { ...current, totpURI: "" } : current,
      );
      setVerified(true);
      setPassword("");
      setCodesAcknowledged(false);
      setActionStatus(
        "Two-step verification is active. Save your backup codes before finishing.",
      );
    } catch {
      setVerificationCode("");
      setError(
        "That code could not be verified. Wait for a new code and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  async function regenerateBackupCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setActionStatus(null);
    setPending(true);
    try {
      const response = await authClient.twoFactor.generateBackupCodes({
        password: managementPassword,
      });
      setManagementPassword("");
      if (response.error || !response.data) {
        setError(
          "We couldn't generate new backup codes. Check your password and try again.",
        );
        return;
      }
      setReplacementCodes([...response.data.backupCodes]);
      setCodesAcknowledged(false);
    } catch {
      setManagementPassword("");
      setError(
        "We couldn't generate new backup codes. Check your password and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  async function cancelEnrollment() {
    setError(null);
    setPending(true);
    try {
      const response = await requestDirectRoute({
        body: { action: "cancel", password },
        method: "POST",
        url: "/api/account/two-factor/disable",
      });
      if (!response.ok) throw new Error("cancel failed");
      setEnrollment(null);
      setPassword("");
      setVerificationCode("");
      navigate("/settings/security");
    } catch {
      setEnrollment(null);
      setPassword("");
      setVerificationCode("");
      setError(
        "Setup was closed, but its server state could not be confirmed. Sign in again before retrying.",
      );
      navigate("/sign-in?securityChanged=true");
    } finally {
      setPending(false);
    }
  }

  async function disableTwoFactor() {
    setError(null);
    setActionStatus(null);
    setPending(true);
    try {
      const response = await requestDirectRoute({
        body: {
          action: "disable",
          password: managementPassword,
        },
        method: "POST",
        url: "/api/account/two-factor/disable",
      });
      setManagementPassword("");
      if (!response.ok) throw new Error("disable failed");
      setReplacementCodes(null);
      navigate("/sign-in?securityChanged=true");
    } catch {
      setManagementPassword("");
      setError(
        "We couldn't disable two-step verification. Sign in again, then retry with your current password.",
      );
    } finally {
      setPending(false);
    }
  }

  async function copyText(value: string, successMessage: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setActionStatus(successMessage);
    } catch {
      setError(
        "Clipboard access was unavailable. Select and copy the value manually.",
      );
    }
  }

  function downloadCodes(codes: string[]) {
    const content = [
      "Humans two-step verification backup codes",
      "Each code can be used once. Store these somewhere private.",
      "",
      ...codes,
      "",
    ].join("\n");
    const objectUrl = URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "humans-backup-codes.txt";
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    setActionStatus("Backup-code download started.");
  }

  function downloadBackupCodes() {
    if (enrollment) downloadCodes(enrollment.backupCodes);
  }

  function finishEnrollment() {
    setEnrollment(null);
    setVerificationCode("");
    setActionStatus(null);
    navigate("/dashboard");
  }

  if (!enrollment && twoFactorEnabled && replacementCodes) {
    return (
      <AuthShell
        eyebrow="Account security"
        title="Save your new backup codes"
        description="Your previous unused codes are no longer valid. These replacements are shown only during this step."
      >
        <div className="space-y-5">
          <BackupCodes
            codes={replacementCodes}
            onCopy={() =>
              copyText(replacementCodes.join("\n"), "Backup codes copied.")
            }
            onDownload={() => downloadCodes(replacementCodes)}
          />
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={codesAcknowledged}
              onChange={(event) => setCodesAcknowledged(event.target.checked)}
              className="mt-1"
            />
            I saved these codes somewhere private.
          </label>
          <button
            type="button"
            disabled={!codesAcknowledged}
            onClick={() => {
              setReplacementCodes(null);
              setCodesAcknowledged(false);
              navigate("/settings/security");
            }}
            className={primaryButtonClassName}
          >
            Finish
          </button>
        </div>
      </AuthShell>
    );
  }

  if (!enrollment && twoFactorEnabled) {
    return (
      <AuthShell
        eyebrow="Account security"
        title="Manage two-step verification"
        description="Rotate recovery codes or disable protection. Both actions require your current password."
        footer={
          <Link href="/settings/security" className={textLinkClassName}>
            Return to security settings
          </Link>
        }
      >
        <form className="space-y-5" onSubmit={regenerateBackupCodes}>
          {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}
          <Field
            id="management-password"
            label="Current password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={managementPassword}
            onChange={(event) => setManagementPassword(event.target.value)}
            required
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClassName}
          >
            Generate new backup codes
          </button>
          <button
            type="button"
            disabled={pending || managementPassword.length === 0}
            onClick={disableTwoFactor}
            className={secondaryButtonClassName}
          >
            Disable two-step verification
          </button>
        </form>
      </AuthShell>
    );
  }

  if (!enrollment) {
    return (
      <AuthShell
        eyebrow="Account security"
        title="Set up two-step verification"
        description="Confirm your password, then connect an authenticator and save the one-time backup codes."
        footer={
          <Link href="/" className={textLinkClassName}>
            Cancel and return
          </Link>
        }
      >
        <form className="space-y-5" onSubmit={beginEnrollment}>
          {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}
          <Field
            id="current-password"
            label="Current password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClassName}
          >
            {pending ? "Preparing setup…" : "Begin secure setup"}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Account security"
      title={
        verified ? "Save your recovery codes" : "Connect your authenticator"
      }
      description={
        verified
          ? "Protection is active. Keep these one-time codes somewhere private before leaving this page."
          : "Scan the QR code, save the backup codes, then enter the current six-digit code to finish."
      }
      wide
    >
      <div className="space-y-7">
        {actionStatus ? (
          <AuthStatus kind="success">{actionStatus}</AuthStatus>
        ) : null}
        {error ? <AuthStatus kind="error">{error}</AuthStatus> : null}

        {!verified ? (
          <section
            aria-labelledby="authenticator-setup-heading"
            className="grid gap-6 rounded-2xl border border-white/10 bg-black/20 p-5 sm:grid-cols-[auto_1fr] print:hidden"
          >
            <div className="w-fit rounded-2xl bg-white p-3 shadow-xl shadow-black/30">
              <QRCodeSVG
                value={enrollment.totpURI}
                size={180}
                level="M"
                bgColor="#ffffff"
                fgColor="#09090b"
                title="Humans authenticator enrollment code"
              />
            </div>
            <div className="min-w-0 self-center">
              <h2
                id="authenticator-setup-heading"
                className="font-medium text-white"
              >
                Scan with an authenticator app
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                If scanning is unavailable, enter this setup key manually. Do
                not share it.
              </p>
              <div className="mt-3 flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-cyan-100">
                  {manualSecret}
                </code>
                <button
                  type="button"
                  onClick={() => copyText(manualSecret, "Setup key copied.")}
                  className={secondaryButtonClassName}
                >
                  Copy
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <BackupCodes
          codes={enrollment.backupCodes}
          onCopy={() =>
            copyText(enrollment.backupCodes.join("\n"), "Backup codes copied.")
          }
          onDownload={downloadBackupCodes}
        />

        {verified ? (
          <div className="space-y-4">
            <label className="flex items-start gap-2 text-sm text-zinc-300 print:hidden">
              <input
                type="checkbox"
                checked={codesAcknowledged}
                onChange={(event) => setCodesAcknowledged(event.target.checked)}
                className="mt-1"
              />
              I saved these one-time codes somewhere private.
            </label>
            <button
              type="button"
              disabled={!codesAcknowledged}
              onClick={finishEnrollment}
              className={primaryButtonClassName}
            >
              I saved my codes — finish
            </button>
          </div>
        ) : (
          <form className="space-y-5 print:hidden" onSubmit={verifyEnrollment}>
            <Field
              id="verification-code"
              label="Authentication code"
              name="verification-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              hint="Enter the current code shown by your authenticator app."
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value)}
              required
              disabled={pending}
              inputClassName="font-mono tracking-[0.3em]"
            />
            <button
              type="submit"
              disabled={pending}
              className={primaryButtonClassName}
            >
              {pending ? "Verifying…" : "Verify and enable"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={cancelEnrollment}
              className={secondaryButtonClassName}
            >
              Cancel setup
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}

function BackupCodes({
  codes,
  onCopy,
  onDownload,
}: {
  codes: string[];
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <section
      aria-labelledby="backup-codes-heading"
      className="rounded-2xl border border-amber-200/15 bg-amber-200/[0.06] p-5 print:border-zinc-300 print:bg-white print:text-black"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="backup-codes-heading"
            className="font-medium text-amber-50 print:text-black"
          >
            One-time backup codes
          </h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-400 print:text-zinc-700">
            Each code works once. Store them separately from your password and
            authenticator device.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <button
            type="button"
            onClick={onCopy}
            className={secondaryButtonClassName}
          >
            Copy all
          </button>
          <button
            type="button"
            onClick={onDownload}
            className={secondaryButtonClassName}
          >
            Download
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className={secondaryButtonClassName}
          >
            Print
          </button>
        </div>
      </div>
      <ol className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm text-amber-100 sm:grid-cols-3 print:text-black">
        {codes.map((code, index) => (
          <li
            key={index}
            className="rounded bg-black/20 px-2.5 py-2 print:bg-transparent"
          >
            {code}
          </li>
        ))}
      </ol>
    </section>
  );
}
