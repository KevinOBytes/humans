import { headers } from "next/headers";
import { redirect } from "next/navigation";

import TwoFactorEnrollment from "./two-factor-enrollment";

const enrollmentPath = "/two-factor/enroll";

export const dynamic = "force-dynamic";

export default async function TwoFactorEnrollmentPage() {
  const requestHeaders = await headers();
  const { auth } = await import("@/modules/auth/auth");
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true, disableRefresh: true },
  });

  if (!session) {
    redirect(`/sign-in?returnTo=${encodeURIComponent(enrollmentPath)}`);
  }

  return (
    <TwoFactorEnrollment
      twoFactorEnabled={session.user.twoFactorEnabled === true}
    />
  );
}
