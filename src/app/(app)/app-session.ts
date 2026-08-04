import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ResearchViewerDocument } from "@/graphql/generated/graphql";
import {
  executeServerGraphQL,
  ServerGraphQLError,
} from "@/graphql/server-client";

export const getVerifiedAppSession = cache(async () => {
  const { auth } = await import("@/modules/auth/auth");
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) redirect("/sign-in?returnTo=%2Fdashboard");

  const organizations = await auth.api.listOrganizations({
    headers: requestHeaders,
  });
  return { requestHeaders, session, organizations };
});

export const getAppContext = cache(async () => {
  const verified = await getVerifiedAppSession();
  if (!verified.session.session.activeOrganizationId) {
    return { ...verified, viewer: null };
  }
  try {
    const data = await executeServerGraphQL(ResearchViewerDocument, {});
    return { ...verified, viewer: data.viewer };
  } catch (error) {
    if (
      error instanceof ServerGraphQLError &&
      (error.hasCode("PRECONDITION_FAILED") ||
        error.hasCode("FORBIDDEN") ||
        error.hasCode("NOT_FOUND"))
    ) {
      return { ...verified, viewer: null };
    }
    throw error;
  }
});
