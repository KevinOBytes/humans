import "server-only";

export function canonicalizeHttpOrigin(value: string): string | null {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const input = value.trim();
  if (!/^https?:\/\//i.test(input)) return null;

  const authorityStart = input.indexOf("://") + 3;
  const authorityEnd = input.slice(authorityStart).search(/[/?#]/u);
  const authority = input.slice(
    authorityStart,
    authorityEnd === -1 ? undefined : authorityStart + authorityEnd,
  );
  if (authority.includes("@")) return null;

  try {
    const url = new URL(input);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
