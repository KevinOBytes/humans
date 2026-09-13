const localOrigin = "https://humans.invalid";

export function returnToFromSearch(search: string, fallback = "/"): string {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (!candidate || !candidate.startsWith("/") || candidate.includes("\\")) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, localOrigin);
    if (
      parsed.origin !== localOrigin ||
      (parsed.pathname === "/accept-invitation" &&
        (parsed.search || parsed.hash))
    ) {
      return fallback;
    }
    return candidate;
  } catch {
    return fallback;
  }
}

export function twoFactorRedirectPath(search: string, fallback = "/"): string {
  return `/two-factor?returnTo=${encodeURIComponent(returnToFromSearch(search, fallback))}`;
}

/**
 * Resolve the internal App Router request path without trusting a complete
 * redirect URL supplied by the browser. Next exposes `next-url` for internal
 * navigations and `x-invoke-path` in some server/runtime paths; both are
 * treated as untrusted and reduced to a same-origin, non-API path.
 */
export function returnToFromRequestHeaders(
  requestHeaders: Pick<Headers, "get">,
  fallback = "/dashboard",
): string {
  const candidate =
    requestHeaders.get("next-url") ?? requestHeaders.get("x-invoke-path");
  if (!candidate) return fallback;

  try {
    const parsed = new URL(candidate, localOrigin);
    const path = `${parsed.pathname}${parsed.search}`;
    if (parsed.origin !== localOrigin || path.startsWith("/api/")) {
      return fallback;
    }
    return returnToFromSearch(
      `?returnTo=${encodeURIComponent(path)}`,
      fallback,
    );
  } catch {
    return fallback;
  }
}
