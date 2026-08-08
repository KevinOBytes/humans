"use client";

import { apiKeyClient } from "@better-auth/api-key/client";
import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  organizationClient,
  twoFactorClient,
  usernameClient,
} from "better-auth/client/plugins";

import { ac, roles } from "./permissions";
import { twoFactorRedirectPath } from "./return-to";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  plugins: [
    usernameClient(),
    twoFactorClient({
      twoFactorPage: "/two-factor",
      onTwoFactorRedirect: () => {
        if (typeof window !== "undefined") {
          window.location.assign(
            twoFactorRedirectPath(window.location.search, "/dashboard"),
          );
        }
      },
    }),
    adminClient(),
    organizationClient({ ac, roles }),
    apiKeyClient(),
  ],
});

export type BetterAuthClient = typeof authClient;
