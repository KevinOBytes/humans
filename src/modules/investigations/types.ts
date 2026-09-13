import type {
  investigationCaseLinks,
  investigations,
} from "@/db/schema/investigations";

export type InvestigationRow = typeof investigations.$inferSelect;
export type InvestigationCaseLinkRow =
  typeof investigationCaseLinks.$inferSelect;
