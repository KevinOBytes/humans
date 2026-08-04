"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CancelWorkspaceInvitationDocument,
  IssueWorkspaceInvitationDocument,
  RemoveWorkspaceMemberDocument,
  ResendWorkspaceInvitationDocument,
  SettingsWorkspaceDirectoryDocument,
  type SettingsWorkspaceDirectoryQuery,
  UpdateWorkspaceMemberRoleDocument,
  type WorkspaceAdministrationRole,
} from "@/graphql/generated/graphql";

type Directory = SettingsWorkspaceDirectoryQuery["settingsWorkspaceDirectory"];
type Member = Directory["members"]["nodes"][number];
type Invitation = Directory["invitations"][number];
type Feedback = { kind: "error" | "success"; message: string } | null;

const lowerRoles = ["ANALYST", "CONTRIBUTOR", "VIEWER"] as const;

function mutationMessage(code: string): Feedback {
  return code === "APPLIED"
    ? { kind: "success", message: "Workspace access was updated." }
    : code === "UNCHANGED"
      ? {
          kind: "success",
          message: "The request was accepted. No additional change was needed.",
        }
      : {
          kind: "error",
          message: "The request could not be completed.",
        };
}

export function MemberAdministration() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (nextOffset: number, signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    const result = await executeBrowserGraphQL(
      SettingsWorkspaceDirectoryDocument,
      { offset: nextOffset },
      { signal },
    );
    if (signal?.aborted || generation !== loadGeneration.current) return;
    setLoading(false);
    if (!result.ok) {
      setDirectory(null);
      setFeedback({
        kind: "error",
        message: "Workspace access could not be loaded.",
      });
      return;
    }
    setDirectory(result.data.settingsWorkspaceDirectory);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(offset, controller.signal);
    });
    return () => controller.abort();
  }, [load, offset]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      IssueWorkspaceInvitationDocument,
      {
        input: {
          email: String(data.get("email") ?? ""),
          role: String(data.get("role")) as WorkspaceAdministrationRole,
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    setBusy(false);
    if (!result.ok) {
      setFeedback({
        kind: "error",
        message: "The invitation could not be sent.",
      });
      return;
    }
    setFeedback(mutationMessage(result.data.issueWorkspaceInvitation.code));
    if (result.data.issueWorkspaceInvitation.code === "APPLIED") form.reset();
    await load(offset);
  }

  async function invitationAction(
    invitation: Invitation,
    action: "cancel" | "resend",
  ) {
    if (
      busy ||
      (action === "cancel" && !window.confirm("Cancel this invitation?"))
    )
      return;
    setBusy(true);
    setFeedback(null);
    const input = {
      actionId: invitation.actionId,
      idempotencyKey: crypto.randomUUID(),
    };
    if (action === "cancel") {
      const result = await executeBrowserGraphQL(
        CancelWorkspaceInvitationDocument,
        { input },
      );
      setBusy(false);
      setFeedback(
        result.ok
          ? mutationMessage(result.data.cancelWorkspaceInvitation.code)
          : {
              kind: "error",
              message: "The invitation could not be updated.",
            },
      );
      await load(offset);
      return;
    }
    const result = await executeBrowserGraphQL(
      ResendWorkspaceInvitationDocument,
      { input },
    );
    setBusy(false);
    setFeedback(
      result.ok
        ? mutationMessage(result.data.resendWorkspaceInvitation.code)
        : {
            kind: "error",
            message: "The invitation could not be updated.",
          },
    );
    await load(offset);
  }

  async function updateRole(member: Member, role: WorkspaceAdministrationRole) {
    if (busy || role === member.role) return;
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      UpdateWorkspaceMemberRoleDocument,
      {
        input: {
          actionId: member.actionId,
          role,
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    setBusy(false);
    setFeedback(
      result.ok
        ? mutationMessage(result.data.updateWorkspaceMemberRole.code)
        : { kind: "error", message: "The member role could not be changed." },
    );
    await load(offset);
  }

  async function remove(member: Member) {
    if (
      busy ||
      !window.confirm(`Remove ${member.displayName} from this workspace?`)
    )
      return;
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(RemoveWorkspaceMemberDocument, {
      input: { actionId: member.actionId, idempotencyKey: crypto.randomUUID() },
    });
    setBusy(false);
    setFeedback(
      result.ok
        ? mutationMessage(result.data.removeWorkspaceMember.code)
        : { kind: "error", message: "The member could not be removed." },
    );
    await load(offset);
  }

  if (loading && !directory) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading workspace access…
      </p>
    );
  }
  if (!directory) {
    return (
      <p role="alert" className="text-destructive">
        Workspace access is unavailable.
      </p>
    );
  }
  const owner = directory.actorRole === "OWNER";
  const invitationRoles = owner
    ? (["ADMIN", ...lowerRoles] as const)
    : [...lowerRoles];

  return (
    <div className="space-y-6">
      <form
        onSubmit={invite}
        aria-label="Invite workspace member"
        className="border-border grid gap-4 rounded-xl border p-4 md:grid-cols-[1fr_12rem_auto] md:items-end"
      >
        <div className="space-y-2">
          <Label htmlFor="invitation-email">Email</Label>
          <Input
            id="invitation-email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={320}
            required
            disabled={busy}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invitation-role">Role</Label>
          <select
            id="invitation-role"
            name="role"
            disabled={busy}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          >
            {invitationRoles.map((role) => (
              <option key={role} value={role}>
                {role.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : "Send invitation"}
        </Button>
      </form>

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

      <div className="border-border overflow-x-auto rounded-xl border">
        <Table aria-label="Current workspace members">
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {directory.members.nodes.map((member) => (
              <TableRow key={member.actionId}>
                <TableCell className="font-medium">
                  {member.displayName}
                  {member.isSelf ? " (you)" : ""}
                </TableCell>
                <TableCell>{member.email}</TableCell>
                <TableCell>
                  <Badge>{member.role.toLowerCase()}</Badge>
                </TableCell>
                <TableCell>
                  {member.isSelf ? (
                    <span className="text-muted-foreground text-sm">
                      Current account
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Label
                        className="sr-only"
                        htmlFor={`role-${member.actionId}`}
                      >
                        Role for {member.displayName}
                      </Label>
                      <select
                        id={`role-${member.actionId}`}
                        aria-label={`Role for ${member.displayName}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) =>
                          void updateRole(
                            member,
                            event.target.value as WorkspaceAdministrationRole,
                          )
                        }
                        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                      >
                        {(owner
                          ? (["ADMIN", ...lowerRoles] as const)
                          : lowerRoles
                        ).map((role) => (
                          <option key={role} value={role}>
                            {role.toLowerCase()}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => void remove(member)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <nav
        aria-label="Member pages"
        className="flex items-center justify-between gap-3"
      >
        <p className="text-muted-foreground text-sm">
          Showing {directory.members.nodes.length} of {directory.members.total}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!directory.members.hasPrevious || busy}
            onClick={() =>
              setOffset(Math.max(0, offset - directory.members.limit))
            }
          >
            Previous members
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!directory.members.hasMore || busy}
            onClick={() => setOffset(offset + directory.members.limit)}
          >
            Next members
          </Button>
        </div>
      </nav>

      <section aria-labelledby="pending-invitations" className="space-y-3">
        <h2 id="pending-invitations" className="font-semibold">
          Invitations
        </h2>
        {directory.invitations.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No pending invitations.
          </p>
        ) : (
          <ul className="grid gap-3">
            {directory.invitations.map((invitation) => (
              <li
                key={invitation.actionId}
                className="border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
              >
                <div>
                  <p className="font-medium">{invitation.email}</p>
                  <p className="text-muted-foreground text-sm">
                    {invitation.role.toLowerCase()} ·{" "}
                    {invitation.status.toLowerCase()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || invitation.status === "EXPIRED"}
                    onClick={() => void invitationAction(invitation, "resend")}
                  >
                    Resend
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busy || invitation.status === "EXPIRED"}
                    onClick={() => void invitationAction(invitation, "cancel")}
                  >
                    Cancel
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
