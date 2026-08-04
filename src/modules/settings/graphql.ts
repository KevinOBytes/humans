import { builder } from "@/graphql/builder";
import { createGraphQLError } from "@/graphql/errors";

import type { PolicySettingsReadModel } from "./repository";
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

type AccessPolicy = PolicySettingsReadModel["accessPolicies"][number];
type RetentionPolicy = PolicySettingsReadModel["retentionPolicies"][number];
type WorkspaceDefaults = PolicySettingsReadModel["workspace"];

const SettingsApiKey = builder
  .objectRef<SafeApiKeySettings>("SettingsApiKey")
  .implement({
    fields: (t) => ({
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
  .objectRef<SafeSettingsPage<SafeApiKeySettings>>("SettingsApiKeyPage")
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
    }),
  });

const SettingsAccessPolicy = builder
  .objectRef<AccessPolicy>("SettingsAccessPolicy")
  .implement({
    fields: (t) => ({
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
      name: t.exposeString("name", { nullable: false }),
      locale: t.exposeString("locale", { nullable: false }),
      timezone: t.exposeString("timezone", { nullable: false }),
      defaultRetentionDays: t.exposeInt("defaultRetentionDays", {
        nullable: true,
      }),
      aiEnabled: t.exposeBoolean("aiEnabled", { nullable: false }),
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
