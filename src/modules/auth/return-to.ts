const localOrigin = "https://humans.invalid";

export function returnToFromSearch(search: string): string {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (!candidate || !candidate.startsWith("/") || candidate.includes("\\")) {
    return "/";
  }

  try {
    const parsed = new URL(candidate, localOrigin);
    if (
      parsed.origin !== localOrigin ||
      (parsed.pathname === "/accept-invitation" &&
        (parsed.search || parsed.hash))
    ) {
      return "/";
    }
    return candidate;
  } catch {
    return "/";
  }
}

export function twoFactorRedirectPath(search: string): string {
  return `/two-factor?returnTo=${encodeURIComponent(returnToFromSearch(search))}`;
}
