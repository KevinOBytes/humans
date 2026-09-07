# Person enrichment and web research

## Goal

Make person creation useful on first entry and add a governed web-research workflow that drafts public-profile suggestions for explicit review before any record mutation.

## Design

The create form will expose the existing core person fields plus confidence and confidence explanation, with stable defaults and clear optional-field grouping. It will not duplicate the repeatable facts, names, contacts, addresses, or evidence tables; those remain available through the person record sections.

Web research will be a GraphQL-backed, permission-gated request for a single visible person. The server sends only the person's public display/preferred/sort name and biography to a configured search adapter. The adapter returns bounded public sources, and the configured OpenAI-compatible provider converts them into a strict allowlisted suggestion set for core fields. Suggestions stay in a client review draft until the user checks individual fields. Applying checked suggestions uses the existing optimistic `updatePerson` mutation, so unselected fields cannot be written and current-version conflicts remain visible.

The feature is disabled with a stable configuration message when no web-search adapter is configured. No private contacts, addresses, identifiers, relations, restricted notes, or sensitive-trait inference are sent to an external provider.

## Acceptance

- Person creation defaults are deterministic and optional fields remain blank when omitted.
- A visible person can request web research only with `person:read`, `analysis:create`, and `analysis:run`.
- Research output is bounded, source-backed, allowlisted, and never directly persists a person update.
- Each suggestion is editable and unchecked by default; only checked suggestions are applied.
- Applying suggestions is workspace-scoped, optimistic-versioned, auditable through existing person updates, and preserves the draft on failure.
- Unit/component tests cover form payloads, provider parsing/validation, permission/configuration failures, unchecked suggestions, partial acceptance, and version conflicts.
