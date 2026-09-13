import type { caseTeamLinks, teamMembers, teams } from "@/db/schema/teams";

export type TeamRow = typeof teams.$inferSelect;
export type TeamMemberRow = typeof teamMembers.$inferSelect;
export type CaseTeamLinkRow = typeof caseTeamLinks.$inferSelect;
