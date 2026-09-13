"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

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
  CollaborationAddTeamMemberDocument,
  CollaborationCreateTeamDocument,
  CollaborationRemoveTeamMemberDocument,
  CollaborationTeamMembersDocument,
  CollaborationTeamsDocument,
  type CollaborationTeamMembersQuery,
  type CollaborationTeamsQuery,
} from "@/graphql/generated/graphql";

type Team = NonNullable<
  NonNullable<CollaborationTeamsQuery["teams"]>["nodes"]
>[number];
type TeamMember = NonNullable<
  NonNullable<CollaborationTeamMembersQuery["teamMembers"]>["nodes"]
>[number];

export function TeamAdministration({
  canManage = true,
}: {
  canManage?: boolean;
}) {
  const [teams, setTeams] = useState<readonly Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [members, setMembers] = useState<readonly TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    const result = await executeBrowserGraphQL(CollaborationTeamsDocument, {
      first: 50,
    });
    setLoading(false);
    if (!result.ok || !result.data.teams) {
      setFeedback("Teams could not be loaded.");
      return;
    }
    const next = result.data.teams.nodes ?? [];
    setTeams(next);
    setSelectedTeamId((current) => current ?? next[0]?.id ?? null);
  }, []);

  const loadMembers = useCallback(async (teamId: string) => {
    const result = await executeBrowserGraphQL(
      CollaborationTeamMembersDocument,
      {
        teamId,
        first: 100,
      },
    );
    if (!result.ok || !result.data.teamMembers) {
      setMembers([]);
      setFeedback("Team membership could not be loaded.");
      return;
    }
    setMembers(result.data.teamMembers.nodes ?? []);
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadTeams());
  }, [loadTeams]);

  useEffect(() => {
    queueMicrotask(() => {
      if (selectedTeamId) void loadMembers(selectedTeamId);
      else setMembers([]);
    });
  }, [loadMembers, selectedTeamId]);

  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      CollaborationCreateTeamDocument,
      {
        name: String(data.get("name") ?? ""),
        description: String(data.get("description") ?? "") || null,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    setBusy(false);
    if (!result.ok || !result.data.createTeam) {
      setFeedback("The team could not be created.");
      return;
    }
    form.reset();
    await loadTeams();
    setSelectedTeamId(result.data.createTeam.id);
    setFeedback("Team created.");
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !selectedTeamId) return;
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      CollaborationAddTeamMemberDocument,
      {
        teamId: selectedTeamId,
        principalId: String(data.get("principalId") ?? ""),
        role: String(data.get("role") ?? "member"),
        idempotencyKey: crypto.randomUUID(),
      },
    );
    setBusy(false);
    if (!result.ok || !result.data.addTeamMember) {
      setFeedback("The team member could not be added.");
      return;
    }
    form.reset();
    await loadMembers(selectedTeamId);
    setFeedback("Team member added.");
  }

  async function removeMember(member: TeamMember) {
    if (busy || !selectedTeamId || !member.id) return;
    setBusy(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(
      CollaborationRemoveTeamMemberDocument,
      {
        teamId: selectedTeamId,
        memberId: member.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setFeedback("The team member could not be removed.");
      return;
    }
    await loadMembers(selectedTeamId);
    setFeedback("Team member removed.");
  }

  return (
    <div className="space-y-6">
      {canManage ? (
        <form
          onSubmit={createTeam}
          aria-label="Create team"
          className="border-border grid gap-4 rounded-xl border p-4 md:grid-cols-[1fr_1fr_auto] md:items-end"
        >
          <div className="space-y-2">
            <Label htmlFor="team-name">Team name</Label>
            <Input id="team-name" name="name" required maxLength={160} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-description">Team description</Label>
            <Input id="team-description" name="description" maxLength={2000} />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Working…" : "Create team"}
          </Button>
        </form>
      ) : (
        <p className="border-border bg-muted/40 text-muted-foreground rounded-xl border p-4 text-sm">
          Team administration is read-only for your role.
        </p>
      )}

      {feedback ? (
        <p
          role={
            feedback.endsWith(".") && !feedback.includes("could not")
              ? "status"
              : "alert"
          }
          className="text-muted-foreground text-sm"
        >
          {feedback}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-muted-foreground">
          Loading teams…
        </p>
      ) : null}
      {!loading && teams.length === 0 ? (
        <p className="border-border bg-muted/40 text-muted-foreground rounded-xl border p-5">
          No teams have been created in this workspace.
        </p>
      ) : null}

      {teams.length > 0 ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(16rem,0.7fr)_minmax(0,1.3fr)]">
          <div
            className="border-border rounded-xl border p-2"
            aria-label="Workspace teams"
          >
            <ul className="space-y-1">
              {teams.map((team) =>
                team.id ? (
                  <li key={team.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTeamId(team.id)}
                      aria-pressed={selectedTeamId === team.id}
                      className="hover:bg-muted focus-visible:ring-ring aria-pressed:bg-primary/10 w-full rounded-lg p-3 text-left outline-none focus-visible:ring-2"
                    >
                      <span className="block font-medium">
                        {team.name ?? "Unnamed team"}
                      </span>
                      <span className="text-muted-foreground mt-1 block text-xs">
                        {team.description ?? "No description"}
                      </span>
                    </button>
                  </li>
                ) : null,
              )}
            </ul>
          </div>
          <section
            className="border-border rounded-xl border p-4"
            aria-labelledby="team-members-heading"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="team-members-heading" className="text-lg font-semibold">
                  Team members
                </h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  Membership is workspace-scoped and enforced by the API.
                </p>
              </div>
              {selectedTeamId ? (
                <Link
                  href={`/settings/teams/${selectedTeamId}`}
                  className="text-primary text-sm hover:underline"
                >
                  Open team record
                </Link>
              ) : null}
            </div>
            {selectedTeamId && canManage ? (
              <form
                onSubmit={addMember}
                aria-label="Add team member"
                className="mt-5 grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
              >
                <div className="space-y-2">
                  <Label htmlFor="team-member-principal">Principal UUID</Label>
                  <Input
                    id="team-member-principal"
                    name="principalId"
                    required
                    placeholder="Workspace principal UUID"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="team-member-role">Role</Label>
                  <select
                    id="team-member-role"
                    name="role"
                    defaultValue="member"
                    className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                  >
                    <option value="member">Member</option>
                    <option value="reviewer">Reviewer</option>
                  </select>
                </div>
                <Button type="submit" disabled={busy}>
                  Add member
                </Button>
              </form>
            ) : null}
            <div className="border-border mt-5 overflow-x-auto rounded-xl border">
              <Table aria-label="Team members">
                <TableHeader>
                  <TableRow>
                    <TableHead>Principal</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell className="font-mono text-xs">
                        {member.principalId ?? "Unknown"}
                      </TableCell>
                      <TableCell>
                        <Badge>{member.role ?? "member"}</Badge>
                      </TableCell>
                      <TableCell>
                        {canManage ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeMember(member)}
                            disabled={busy || member.role === "owner"}
                          >
                            Remove
                          </Button>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            Read-only
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {members.length === 0 ? (
              <p className="text-muted-foreground mt-4 text-sm">
                No active members in this team.
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
