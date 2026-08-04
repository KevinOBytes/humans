"use server";

import { headers } from "next/headers";

export type WorkspaceActionResult =
  { ok: true; organizationId: string } | { ok: false; message: string };

export async function createWorkspace(
  formData: FormData,
): Promise<WorkspaceActionResult> {
  const [{ db }, { auth, provisionWorkspace }] = await Promise.all([
    import("@/db/client"),
    import("@/modules/auth/auth"),
  ]);
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session)
    return { ok: false, message: "Your session has expired. Sign in again." };

  const name = String(formData.get("name") ?? "").trim();
  const requestedSlug = String(formData.get("slug") ?? "")
    .trim()
    .toLowerCase();
  const slug =
    requestedSlug ||
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 63);
  if (!name || !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(slug)) {
    return {
      ok: false,
      message:
        "Enter a name and a slug with at least three letters or numbers.",
    };
  }
  try {
    const workspace = await provisionWorkspace(db, {
      userId: session.user.id,
      name,
      slug,
    });
    return { ok: true, organizationId: workspace.organizationId };
  } catch {
    return {
      ok: false,
      message: "That workspace could not be created. Try a different slug.",
    };
  }
}
