// @vitest-environment node

import { GraphQLFixture, type SessionActor } from "./graphql";
import { eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { members, sessions } from "@/db/schema/auth";
import { ensureUserPrincipal } from "@/modules/auth/workspaces";

export const CREATE_PERSON_MUTATION = /* GraphQL */ `
  mutation CreatePerson($input: CreatePersonInput!) {
    createPerson(input: $input) {
      code
      issues {
        code
        message
        path
      }
      person {
        id
        displayName
        sortName
        status
        sensitivity
        version
      }
    }
  }
`;

export const PEOPLE_QUERY = /* GraphQL */ `
  query People($first: Int, $after: String) {
    people(first: $first, after: $after) {
      nodes {
        id
        displayName
        version
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

export class ResearchFixture extends GraphQLFixture {
  async createActor(
    role: "admin" | "analyst" | "contributor" | "owner" | "viewer" = "owner",
  ): Promise<SessionActor> {
    return this.createSessionActor({ role });
  }

  async createPerson(
    actor: SessionActor,
    input: {
      biography?: string;
      displayName: string;
      sensitivity?: "CONFIDENTIAL" | "INTERNAL" | "PUBLIC" | "RESTRICTED";
      sortName?: string;
    },
  ) {
    return this.execute<{
      createPerson?: {
        code: string | null;
        issues: Array<{ code: string; message: string; path: string[] }>;
        person: {
          id: string;
          displayName: string;
          sensitivity: string;
          sortName: string | null;
          status: string;
          version: number;
        } | null;
      };
    }>({
      jar: actor.jar,
      query: CREATE_PERSON_MUTATION,
      variables: { input },
    });
  }

  async createWorkspaceMember(
    owner: SessionActor,
    role: "admin" | "analyst" | "contributor" | "viewer",
  ): Promise<SessionActor> {
    const suffix = newId();
    const user = await this.createUser({
      email: `member-${suffix}@example.test`,
      username: `Member_${suffix.replaceAll("-", "")}`,
    });
    const memberId = newId();
    await this.database.insert(members).values({
      id: memberId,
      organizationId: owner.organizationId,
      userId: user.userId,
      role,
      workspaceId: owner.workspaceId,
      createdAt: new Date(),
    });
    const principalId = await ensureUserPrincipal(this.database, {
      memberId,
      userId: user.userId,
      workspaceId: owner.workspaceId,
    });
    await this.database
      .update(sessions)
      .set({ activeOrganizationId: owner.organizationId })
      .where(eq(sessions.userId, user.userId));
    return {
      ...user,
      memberId,
      organizationId: owner.organizationId,
      principalId,
      workspaceId: owner.workspaceId,
    };
  }
}
