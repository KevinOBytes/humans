import type { PersonProfileView } from "@/components/research/types";

// Hand-authored fiction only. Reserved .test domains and NANP fictional numbers;
// never use production exports, real contacts, credentials, or private uploads.
export const fictionalProfile: PersonProfileView = {
  id: "018f0000-0000-7000-8000-000000000001",
  displayName: "Mira Example-Fiction",
  preferredName: "Mira",
  biography:
    "A fictional archivist used exclusively for consent-governance tests.",
  status: "ACTIVE",
  sensitivity: "INTERNAL",
  confidence: 0.7,
  version: 1,
  facts: [
    ["alias", "Alias", "M. Example-Fiction"],
    ["pronouns", "Pronouns", "they/them"],
    ["employment", "Employment", "Fictional Lantern Archive"],
    ["education", "Education", "Fictional Example Academy"],
    ["public_contact", "Public contact", "mira@example.test"],
    ["address", "Historical address", "Unit TEST, Fictional Example Square"],
    ["language", "Language", "English"],
    ["organization", "Organization", "Fictional Lantern Archive"],
    ["identifier", "Public identifier", "TEST-ARCHIVIST-001"],
    ["note", "Research note", "Synthetic source requires review"],
    ["custom", "Custom field", "Fictional collection A"],
    ["phone", "Phone", "+1 202-555-0142"],
    ["employment", "Employment", "Competing fictional archive claim"],
  ].map(([fieldKey, label, value], index) => ({
    id: `018f0000-0000-7000-8001-${String(index + 1).padStart(12, "0")}`,
    namespace: "fictional",
    fieldKey: fieldKey!,
    label: label!,
    value: value!,
    state: index === 12 ? "DISPUTED" : "ASSERTED",
    reviewState: "unreviewed",
    sensitivity: index === 11 ? "RESTRICTED" : "INTERNAL",
    confidence: 0.6,
    temporalLabel: "2024-01-01 through 2025-01-01",
    version: 1,
    selected: false,
    revisions: [],
    evidence: [
      {
        id: "test-evidence",
        title: "Fictional archive sample",
        url: "https://archive.example.test/item/1",
      },
    ],
  })),
};
