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
