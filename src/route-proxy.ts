import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

const protectedPrefixes = [
  "/dashboard",
  "/people",
  "/graph",
  "/search",
  "/analyst",
  "/evidence",
  "/imports",
  "/settings",
] as const;

export function routeProxy(request: NextRequest): NextResponse {
  if (
    request.nextUrl.pathname === "/reset-password" &&
    request.nextUrl.searchParams.has("token")
  ) {
    const token = request.nextUrl.searchParams.get("token")!;
    const clean = new URL("/reset-password", request.url);
    clean.hash = new URLSearchParams({ token }).toString();
    return NextResponse.redirect(clean);
  }

  if (
    request.nextUrl.pathname === "/accept-invitation" &&
    request.nextUrl.searchParams.has("id")
  ) {
    const id = request.nextUrl.searchParams.get("id")!;
    const clean = new URL("/accept-invitation", request.url);
    clean.hash = new URLSearchParams({ id }).toString();
    return NextResponse.redirect(clean);
  }

  const hasSessionCookie = Boolean(getSessionCookie(request));
  const isProtected = protectedPrefixes.some(
    (prefix) =>
      request.nextUrl.pathname === prefix ||
      request.nextUrl.pathname.startsWith(`${prefix}/`),
  );

  if (isProtected && !hasSessionCookie) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set(
      "returnTo",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}
