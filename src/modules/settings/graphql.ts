import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import { Sensitivity } from "@/modules/people/graphql";

import type {
  PolicySettingsReadModel,
  WorkspacePolicySummaryReadModel,
} from "./repository";
import type { SafeApiKeySettings } from "./read-model";
import type { SafeSettingsPage } from "./pagination";
import {
  WorkspaceAdministrationAccessError,
  type AdministrationMutationResult,
  type SafeDirectoryInvitation,
  type SafeDirectoryMember,
  type WorkspaceDirectory,
} from "./workspace-members";

const WorkspaceAdministrationRole = builder.enumType(
  "WorkspaceAdministrationRole",
  {
    values: ["ADMIN", "ANALYST", "CONTRIBUTOR", "VIEWER"] as const,
  },
);

const PolicyState = builder.enumType("PolicyState", {
  values: ["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"] as const,
});

function parseResourceGrantState(
  value: "DRAFT" | "ACTIVE" | "DISABLED" | "ARCHIVED" | null | undefined,
): "active" | "inactive" | "archived" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "ACTIVE") return "active";
  if (value === "DISABLED") return "inactive";
  if (value === "ARCHIVED") return "archived";
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "A resource grant cannot be in draft state.",
  );
}
const DeletionBehavior = builder.enumType("DeletionBehavior", {
  values: ["REVIEW", "SOFT_DELETE", "HARD_DELETE", "ANONYMIZE"] as const,
});
const ConsentStatus = builder.enumType("ConsentStatus", {
  values: ["GRANTED", "DENIED", "WITHDRAWN", "EXPIRED", "UNKNOWN"] as const,
});
const DeletionRequestState = builder.enumType("DeletionRequestState", {
  values: [
    "REVIEWING",
    "APPROVED",
    "REJECTED",
    "EXPORTING",
    "DELETING",
    "COMPLETED",
    "CANCELLED",
  ] as const,
});

const SettingsDirectoryMember = builder
  .objectRef<SafeDirectoryMember>("SettingsDirectoryMember")
  .implement({
    fields: (t) => ({
      actionId: t.exposeString("actionId", { nullable: false }),
      displayName: t.exposeString("displayName", { nullable: false }),
      email: t.exposeString("email", { nullable: false }),
      joinedAt: t.exposeString("joinedAt", { nullable: false }),
      isSelf: t.exposeBoolean("isSelf", { nullable: false }),
      role: t.string({
        nullable: false,
        resolve: (row) => row.role.toUpperCase(),
      }),
    }),
  });

const SettingsDirectoryInvitation = builder
  .objectRef<SafeDirectoryInvitation>("SettingsDirectoryInvitation")
  .implement({
    fields: (t) => ({
      actionId: t.exposeString("actionId", { nullable: false }),
      createdAt: t.exposeString("createdAt", { nullable: false }),
      email: t.exposeString("email", { nullable: false }),
      expiresAt: t.exposeString("expiresAt", { nullable: false }),
      role: t.string({
        nullable: false,
        resolve: (row) => row.role.toUpperCase(),
      }),
      status: t.string({
        nullable: false,
        resolve: (row) => row.status.toUpperCase(),
      }),
    }),
  });

const SettingsDirectoryMemberPage = builder
  .objectRef<WorkspaceDirectory["members"]>("SettingsDirectoryMemberPage")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [SettingsDirectoryMember],
        nullable: { list: false, items: false },
      }),
      offset: t.exposeInt("offset", { nullable: false }),
      limit: t.exposeInt("limit", { nullable: false }),
      total: t.exposeInt("total", { nullable: false }),
      hasPrevious: t.exposeBoolean("hasPrevious", { nullable: false }),
      hasMore: t.exposeBoolean("hasMore", { nullable: false }),
    }),
  });

const SettingsWorkspaceDirectory = builder
  .objectRef<WorkspaceDirectory>("SettingsWorkspaceDirectory")
  .implement({
    fields: (t) => ({
      actorRole: t.string({
        nullable: false,
        resolve: (row) => row.actorRole.toUpperCase(),
      }),
      invitations: t.expose("invitations", {
        type: [SettingsDirectoryInvitation],
        nullable: { list: false, items: false },
      }),
      members: t.expose("members", {
        type: SettingsDirectoryMemberPage,
        nullable: false,
      }),
    }),
  });

const SettingsAdministrationMutationPayload = builder
  .objectRef<AdministrationMutationResult>(
    "SettingsAdministrationMutationPayload",
  )
  .implement({
    fields: (t) => ({
      actionId: t.exposeString("actionId", { nullable: true }),
      code: t.exposeString("code", { nullable: false }),
      requestId: t.exposeString("requestId", { nullable: false }),
    }),
  });

const IssueWorkspaceInvitationInput = builder.inputType(
  "IssueWorkspaceInvitationInput",
  {
    fields: (t) => ({
      email: t.string({ required: true }),
      idempotencyKey: t.string({ required: true }),
      role: t.field({ type: WorkspaceAdministrationRole, required: true }),
    }),
  },
);

const WorkspaceInvitationActionInput = builder.inputType(
  "WorkspaceInvitationActionInput",
  {
    fields: (t) => ({
      actionId: t.string({ required: true }),
      idempotencyKey: t.string({ required: true }),
    }),
  },
);

const UpdateWorkspaceMemberRoleInput = builder.inputType(
  "UpdateWorkspaceMemberRoleInput",
  {
    fields: (t) => ({
      actionId: t.string({ required: true }),
      idempotencyKey: t.string({ required: true }),
      role: t.field({ type: WorkspaceAdministrationRole, required: true }),
    }),
  },
);

const CreateOrganizationApiKeyInput = builder.inputType(
  "CreateOrganizationApiKeyInput",
  {
    fields: (t) => ({
      name: t.string({ required: true }),
      scopes: t.field({ type: ["String"], required: true }),
      expiresInSeconds: t.int(),
    }),
  },
);

const RotateOrganizationApiKeyInput = builder.inputType(
  "RotateOrganizationApiKeyInput",
  {
    fields: (t) => ({
      actionId: t.string({ required: true }),
      name: t.string({ required: true }),
      scopes: t.field({ type: ["String"], required: true }),
      expiresInSeconds: t.int(),
    }),
  },
);

const RevokeOrganizationApiKeyInput = builder.inputType(
  "RevokeOrganizationApiKeyInput",
  {
    fields: (t) => ({ actionId: t.string({ required: true }) }),
  },
);

const UpdateWorkspaceDefaultsInput = builder.inputType(
  "UpdateWorkspaceDefaultsInput",
  {
    fields: (t) => ({
      expectedVersion: t.int({ required: true }),
      idempotencyKey: t.string(),
      locale: t.string(),
      timezone: t.string(),
      retentionDays: t.int(),
      aiEnabled: t.boolean(),
      retainRestrictedAiPrompts: t.boolean(),
      storageEnabled: t.boolean(),
    }),
  },
);
const AccessPolicyInput = builder.inputType("AccessPolicyInput", {
  fields: (t) => ({
    idempotencyKey: t.string(),
    name: t.string({ required: true }),
    sensitivityCeiling: t.field({ type: Sensitivity, required: true }),
    resourceKinds: t.stringList({ required: true }),
    roleBindings: t.field({ type: "JSON", required: true }),
    state: t.field({ type: PolicyState, required: true }),
  }),
});
const UpdateAccessPolicyInput = builder.inputType("UpdateAccessPolicyInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    idempotencyKey: t.string(),
    name: t.string(),
    sensitivityCeiling: t.field({ type: Sensitivity }),
    resourceKinds: t.stringList(),
    roleBindings: t.field({ type: "JSON" }),
    state: t.field({ type: PolicyState }),
  }),
});
const UpsertRetentionPolicyInput = builder.inputType(
  "UpsertRetentionPolicyInput",
  {
    fields: (t) => ({
      idempotencyKey: t.string(),
      resourceKind: t.string({ required: true }),
      retentionDays: t.int({ required: true }),
      deletionBehavior: t.field({ type: DeletionBehavior, required: true }),
      legalBasis: t.string(),
      expectedVersion: t.int(),
    }),
  },
);
const CreateLegalHoldInput = builder.inputType("CreateLegalHoldInput", {
  fields: (t) => ({
    idempotencyKey: t.string(),
    resourceId: t.field({ type: "UUID", required: true }),
    resourceKind: t.string({ required: true }),
    reason: t.string({ required: true }),
    authority: t.string({ required: true }),
  }),
});
const CreateResourceGrantInput = builder.inputType("CreateResourceGrantInput", {
  fields: (t) => ({
    idempotencyKey: t.string(),
    policyId: t.field({ type: "UUID", required: true }),
    resourceId: t.field({ type: "UUID", required: true }),
    resourceKind: t.string({ required: true }),
    memberId: t.string(),
    role: t.field({ type: WorkspaceAdministrationRole }),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
  }),
});
const UpdateResourceGrantInput = builder.inputType("UpdateResourceGrantInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    idempotencyKey: t.string(),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    state: t.field({ type: PolicyState }),
  }),
});
const ReleaseLegalHoldInput = builder.inputType("ReleaseLegalHoldInput", {
  fields: (t) => ({
    idempotencyKey: t.string(),
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    releaseReason: t.string({ required: true }),
  }),
});
const CreateConsentInput = builder.inputType("CreateConsentInput", {
  fields: (t) => ({
    idempotencyKey: t.string(),
    personId: t.field({ type: "UUID", required: true }),
    purpose: t.string({ required: true }),
    status: t.field({ type: ConsentStatus, required: true }),
    source: t.string({ required: true }),
    effectiveFrom: t.field({ type: "DateTime", required: true }),
    effectiveUntil: t.field({ type: "DateTime" }),
    evidenceId: t.field({ type: "UUID" }),
  }),
});
const CreateDeletionRequestInput = builder.inputType(
  "CreateDeletionRequestInput",
  {
    fields: (t) => ({
      idempotencyKey: t.string(),
      scope: t.field({ type: "JSON", required: true }),
    }),
  },
);
const ReviewDeletionRequestInput = builder.inputType(
  "ReviewDeletionRequestInput",
  {
    fields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
      idempotencyKey: t.string(),
      state: t.field({ type: DeletionRequestState, required: true }),
      notes: t.string(),
    }),
  },
);

type AccessPolicy = PolicySettingsReadModel["accessPolicies"][number];
type RetentionPolicy = PolicySettingsReadModel["retentionPolicies"][number];
type WorkspaceDefaults = PolicySettingsReadModel["workspace"];
type ApiKeySettingsPage = SafeSettingsPage<SafeApiKeySettings> & {
  allowedScopes: readonly string[];
};
type ApiKeyLifecycleMutationResult = {
  actionId: string | null;
  code: "APPLIED" | "INVALID";
  requestId: string;
  secret?: string;
};

const SettingsPolicyMutationPayload = builder
  .objectRef<{
    id: string | null;
    version: number | null;
    code: string;
    requestId: string;
  }>("SettingsPolicyMutationPayload")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id", { nullable: true }),
      version: t.exposeInt("version", { nullable: true }),
      code: t.exposeString("code"),
      requestId: t.exposeString("requestId"),
    }),
  });

const SettingsApiKey = builder
  .objectRef<SafeApiKeySettings>("SettingsApiKey")
  .implement({
    fields: (t) => ({
      actionId: t.exposeString("actionId", { nullable: false }),
      name: t.exposeString("name", { nullable: false }),
      fingerprint: t.exposeString("fingerprint", { nullable: false }),
      state: t.exposeString("state", { nullable: false }),
      scopes: t.exposeStringList("scopes", {
        nullable: { list: false, items: false },
      }),
      createdAt: t.exposeString("createdAt", { nullable: false }),
      updatedAt: t.exposeString("updatedAt", { nullable: false }),
      expiresAt: t.exposeString("expiresAt", { nullable: true }),
      lastUsedAt: t.exposeString("lastUsedAt", { nullable: true }),
    }),
  });

const SettingsApiKeyPage = builder
  .objectRef<ApiKeySettingsPage>("SettingsApiKeyPage")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [SettingsApiKey],
        nullable: { list: false, items: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      offset: t.exposeInt("offset", { nullable: false }),
      limit: t.exposeInt("limit", { nullable: false }),
      total: t.exposeInt("total", { nullable: false }),
      hasPrevious: t.exposeBoolean("hasPrevious", { nullable: false }),
      hasMore: t.exposeBoolean("hasMore", { nullable: false }),
      allowedScopes: t.exposeStringList("allowedScopes", {
        nullable: { list: false, items: false },
      }),
    }),
  });

const SettingsApiKeyLifecycleMutationPayload = builder
  .objectRef<ApiKeyLifecycleMutationResult>(
    "SettingsApiKeyLifecycleMutationPayload",
  )
  .implement({
    fields: (t) => ({
      actionId: t.exposeString("actionId", { nullable: true }),
      code: t.exposeString("code", { nullable: false }),
      requestId: t.exposeString("requestId", { nullable: false }),
      // The plaintext is populated only for one successful create/rotate
      // response. No query type can select it.
      secret: t.string({
        nullable: true,
        resolve: (result) => result.secret ?? null,
      }),
    }),
  });

const SettingsAccessPolicy = builder
  .objectRef<AccessPolicy>("SettingsAccessPolicy")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id", { nullable: false }),
      version: t.exposeInt("version", { nullable: false }),
      name: t.exposeString("name", { nullable: false }),
      state: t.exposeString("state", { nullable: false }),
      sensitivityCeiling: t.exposeString("sensitivityCeiling", {
        nullable: false,
      }),
      resourceKinds: t.exposeStringList("resourceKinds", {
        nullable: { items: false, list: false },
      }),
    }),
  });

const SettingsResourceGrant = builder
  .objectRef<PolicySettingsReadModel["resourceGrants"][number]>(
    "SettingsResourceGrant",
  )
  .implement({
    fields: (t) => ({
      id: t.exposeString("id", { nullable: false }),
      policyId: t.exposeString("policyId", { nullable: false }),
      resourceId: t.exposeString("resourceId", { nullable: false }),
      resourceKind: t.exposeString("resourceKind", { nullable: false }),
      memberId: t.exposeString("memberId", { nullable: true }),
      role: t.exposeString("role", { nullable: true }),
      state: t.exposeString("state", { nullable: false }),
      version: t.exposeInt("version", { nullable: false }),
      validFrom: t.string({
        nullable: true,
        resolve: (row) => row.validFrom?.toISOString() ?? null,
      }),
      validUntil: t.string({
        nullable: true,
        resolve: (row) => row.validUntil?.toISOString() ?? null,
      }),
    }),
  });

const SettingsRetentionPolicy = builder
  .objectRef<RetentionPolicy>("SettingsRetentionPolicy")
  .implement({
    fields: (t) => ({
      resourceKind: t.exposeString("resourceKind", { nullable: false }),
      retentionDays: t.exposeInt("retentionDays", { nullable: false }),
      deletionBehavior: t.exposeString("deletionBehavior", { nullable: false }),
    }),
  });

const SettingsWorkspaceDefaults = builder
  .objectRef<WorkspaceDefaults>("SettingsWorkspaceDefaults")
  .implement({
    fields: (t) => ({
      version: t.exposeInt("version", { nullable: false }),
      name: t.exposeString("name", { nullable: false }),
      locale: t.exposeString("locale", { nullable: false }),
      timezone: t.exposeString("timezone", { nullable: false }),
      defaultRetentionDays: t.exposeInt("defaultRetentionDays", {
        nullable: true,
      }),
      aiEnabled: t.exposeBoolean("aiEnabled", { nullable: false }),
      retainRestrictedAiPrompts: t.exposeBoolean("retainRestrictedAiPrompts", {
        nullable: false,
      }),
      storageEnabled: t.exposeBoolean("storageEnabled", { nullable: false }),
    }),
  });

const SettingsPolicyPosture = builder
  .objectRef<PolicySettingsReadModel>("SettingsPolicyPosture")
  .implement({
    fields: (t) => ({
      workspace: t.expose("workspace", {
        type: SettingsWorkspaceDefaults,
        nullable: false,
      }),
      accessPolicies: t.expose("accessPolicies", {
        type: [SettingsAccessPolicy],
        nullable: { items: false, list: false },
      }),
      retentionPolicies: t.expose("retentionPolicies", {
        type: [SettingsRetentionPolicy],
        nullable: { items: false, list: false },
      }),
      resourceGrants: t.expose("resourceGrants", {
        type: [SettingsResourceGrant],
        nullable: { items: false, list: false },
      }),
    }),
  });

const WorkspacePolicySummary = builder
  .objectRef<WorkspacePolicySummaryReadModel>("WorkspacePolicySummary")
  .implement({
    fields: (t) => ({
      defaultRetentionDays: t.exposeInt("defaultRetentionDays", {
        nullable: true,
      }),
      aiEnabled: t.exposeBoolean("aiEnabled", { nullable: false }),
      retainRestrictedAiPrompts: t.exposeBoolean("retainRestrictedAiPrompts", {
        nullable: false,
      }),
      storageEnabled: t.exposeBoolean("storageEnabled", { nullable: false }),
    }),
  });

export function registerSettingsGraphQL(): void {
  builder.queryFields((t) => ({
    settingsWorkspaceDirectory: t.field({
      type: SettingsWorkspaceDirectory,
      nullable: false,
      args: { offset: t.arg.int() },
      complexity: { field: 12, multiplier: 1 },
      resolve: async (_root, args, context) => {
        if (
          context.actor.type !== "user" ||
          (context.actor.role !== "owner" && context.actor.role !== "admin")
        ) {
          throw createGraphQLError(
            "FORBIDDEN",
            "Workspace settings require an administrator session.",
          );
        }
        try {
          return await context.services.settings.directory(args.offset ?? 0);
        } catch (error) {
          if (!(error instanceof WorkspaceAdministrationAccessError)) {
            throw error;
          }
          throw createGraphQLError(
            "FORBIDDEN",
            "Workspace settings require an administrator session.",
          );
        }
      },
    }),
    settingsOrganizationApiKeys: t.field({
      type: SettingsApiKeyPage,
      nullable: false,
      args: { offset: t.arg.int() },
      complexity: { field: 8, multiplier: 1 },
      resolve: (_root, args, context) => {
        if (context.actor.type !== "user") {
          throw createGraphQLError(
            "FORBIDDEN",
            "Workspace settings require an administrator session.",
          );
        }
        return context.services.settings.listOrganizationApiKeys(args.offset);
      },
    }),
    settingsPolicyPosture: t.field({
      type: SettingsPolicyPosture,
      nullable: false,
      complexity: { field: 8, multiplier: 1 },
      resolve: (_root, _args, context) => {
        if (context.actor.type !== "user") {
          throw createGraphQLError(
            "FORBIDDEN",
            "Workspace settings require an administrator session.",
          );
        }
        return context.services.settings.readPolicySettings();
      },
    }),
    workspacePolicySummary: t.field({
      type: WorkspacePolicySummary,
      nullable: false,
      complexity: { field: 2, multiplier: 1 },
      resolve: (_root, _args, context) => {
        requirePermission(context, "workspace", "read");
        return context.services.settings.readWorkspacePolicySummary();
      },
    }),
  }));

  builder.mutationFields((t) => ({
    issueWorkspaceInvitation: t.field({
      type: SettingsAdministrationMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: IssueWorkspaceInvitationInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.issueInvitation(
            args.input.email,
            args.input.role.toLowerCase() as
              "admin" | "analyst" | "contributor" | "viewer",
            args.input.idempotencyKey,
          ),
        ),
    }),
    resendWorkspaceInvitation: t.field({
      type: SettingsAdministrationMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: WorkspaceInvitationActionInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.resendInvitation(
            args.input.actionId,
            args.input.idempotencyKey,
          ),
        ),
    }),
    cancelWorkspaceInvitation: t.field({
      type: SettingsAdministrationMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: WorkspaceInvitationActionInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.cancelInvitation(
            args.input.actionId,
            args.input.idempotencyKey,
          ),
        ),
    }),
    updateWorkspaceMemberRole: t.field({
      type: SettingsAdministrationMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: UpdateWorkspaceMemberRoleInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.updateMemberRole(
            args.input.actionId,
            args.input.role.toLowerCase() as
              "admin" | "analyst" | "contributor" | "viewer",
            args.input.idempotencyKey,
          ),
        ),
    }),
    removeWorkspaceMember: t.field({
      type: SettingsAdministrationMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: WorkspaceInvitationActionInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.removeMember(
            args.input.actionId,
            args.input.idempotencyKey,
          ),
        ),
    }),
    createOrganizationApiKey: t.field({
      type: SettingsApiKeyLifecycleMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: CreateOrganizationApiKeyInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.createOrganizationApiKey(args.input),
        ),
    }),
    rotateOrganizationApiKey: t.field({
      type: SettingsApiKeyLifecycleMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: RotateOrganizationApiKeyInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.rotateOrganizationApiKey(args.input),
        ),
    }),
    revokeOrganizationApiKey: t.field({
      type: SettingsApiKeyLifecycleMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: RevokeOrganizationApiKeyInput, required: true }),
      },
      resolve: (_root, args, context) =>
        requireSessionAdministration(context.actor.type, () =>
          context.services.settings.revokeOrganizationApiKey(
            args.input.actionId,
          ),
        ),
    }),
    updateWorkspaceDefaults: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: UpdateWorkspaceDefaultsInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        return context.services.settings.policyMutations.updateWorkspaceDefaults(
          args.input,
        );
      },
    }),
    createAccessPolicy: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: AccessPolicyInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "accessPolicy", "create");
        return context.services.settings.policyMutations.createAccessPolicy({
          idempotencyKey: args.input.idempotencyKey,
          name: args.input.name,
          resourceKinds: args.input.resourceKinds,
          roleBindings: args.input.roleBindings,
          sensitivityCeiling: args.input.sensitivityCeiling.toLowerCase() as
            "public" | "internal" | "confidential" | "restricted",
          state: args.input.state.toLowerCase() as
            "draft" | "active" | "disabled" | "archived",
        });
      },
    }),
    updateAccessPolicy: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: UpdateAccessPolicyInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "accessPolicy", "update");
        return context.services.settings.policyMutations.updateAccessPolicy({
          ...args.input,
          sensitivityCeiling: args.input.sensitivityCeiling
            ? (args.input.sensitivityCeiling.toLowerCase() as
                "public" | "internal" | "confidential" | "restricted")
            : undefined,
          state: args.input.state
            ? (args.input.state.toLowerCase() as
                "draft" | "active" | "disabled" | "archived")
            : undefined,
        });
      },
    }),
    archiveAccessPolicy: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "accessPolicy", "delete");
        return context.services.settings.policyMutations.archiveAccessPolicy(
          args.id,
          args.expectedVersion,
          args.idempotencyKey,
        );
      },
    }),
    createResourceGrant: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: CreateResourceGrantInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "resourceGrant", "create");
        return context.services.settings.policyMutations.createResourceGrant({
          ...args.input,
          memberId: args.input.memberId ?? undefined,
          role: args.input.role?.toLowerCase(),
          validFrom: args.input.validFrom
            ? new Date(args.input.validFrom)
            : undefined,
          validUntil: args.input.validUntil
            ? new Date(args.input.validUntil)
            : undefined,
        });
      },
    }),
    updateResourceGrant: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: UpdateResourceGrantInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "resourceGrant", "update");
        return context.services.settings.policyMutations.updateResourceGrant({
          id: args.input.id,
          expectedVersion: args.input.expectedVersion,
          idempotencyKey: args.input.idempotencyKey,
          validFrom: args.input.validFrom
            ? new Date(args.input.validFrom)
            : undefined,
          validUntil: args.input.validUntil
            ? new Date(args.input.validUntil)
            : undefined,
          state: parseResourceGrantState(args.input.state),
        });
      },
    }),
    archiveResourceGrant: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "resourceGrant", "delete");
        return context.services.settings.policyMutations.archiveResourceGrant(
          args.id,
          args.expectedVersion,
          args.idempotencyKey,
        );
      },
    }),
    upsertRetentionPolicy: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: UpsertRetentionPolicyInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        return context.services.settings.policyMutations.upsertRetentionPolicy({
          ...args.input,
          deletionBehavior: args.input.deletionBehavior.toLowerCase() as
            "review" | "soft_delete" | "hard_delete" | "anonymize",
        });
      },
    }),
    createLegalHold: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: CreateLegalHoldInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        return context.services.settings.policyMutations.createLegalHold(
          args.input,
        );
      },
    }),
    releaseLegalHold: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: ReleaseLegalHoldInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        return context.services.settings.policyMutations.releaseLegalHold(
          args.input.id,
          args.input.expectedVersion,
          args.input.releaseReason,
          args.input.idempotencyKey,
        );
      },
    }),
    createConsentRecord: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: { input: t.arg({ type: CreateConsentInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "person", "update");
        return context.services.settings.policyMutations.createConsent({
          ...args.input,
          status: args.input.status.toLowerCase() as
            "granted" | "denied" | "withdrawn" | "expired" | "unknown",
          effectiveFrom: new Date(args.input.effectiveFrom),
          effectiveUntil: args.input.effectiveUntil
            ? new Date(args.input.effectiveUntil)
            : undefined,
        });
      },
    }),
    createDeletionRequest: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: CreateDeletionRequestInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        return context.services.settings.policyMutations.createDeletionRequest({
          scope: args.input.scope,
          idempotencyKey: args.input.idempotencyKey,
        });
      },
    }),
    reviewDeletionRequest: t.field({
      type: SettingsPolicyMutationPayload,
      nullable: false,
      args: {
        input: t.arg({ type: ReviewDeletionRequestInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        return context.services.settings.policyMutations.reviewDeletionRequest({
          ...args.input,
          state: args.input.state.toLowerCase() as
            | "reviewing"
            | "approved"
            | "rejected"
            | "exporting"
            | "deleting"
            | "completed"
            | "cancelled",
        });
      },
    }),
  }));
}

function requireSessionAdministration<T>(
  actorType: "apiKey" | "user",
  operation: () => T,
): T {
  if (actorType !== "user") {
    throw createGraphQLError(
      "FORBIDDEN",
      "Workspace settings require an administrator session.",
    );
  }
  return operation();
}
