"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const personalDestinations = [
  { href: "/settings/account", label: "Account" },
  { href: "/settings/security", label: "Security" },
] as const;

const administrationDestinations = [
  { href: "/settings/members", label: "Members" },
  { href: "/settings/api-keys", label: "API keys" },
  { href: "/settings/policies", label: "Policies" },
  { href: "/settings/audit", label: "Audit" },
  { href: "/settings/integrations", label: "Integrations" },
] as const;

export function SettingsNavigation({
  canAdministerWorkspace,
}: {
  canAdministerWorkspace: boolean;
}) {
  const pathname = usePathname();
  const destinations = canAdministerWorkspace
    ? [...personalDestinations, ...administrationDestinations]
    : personalDestinations;

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <nav aria-label="Settings" className="flex min-w-max gap-1">
        {destinations.map((destination) => {
          const active = pathname === destination.href;
          return (
            <Link
              key={destination.href}
              href={destination.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium outline-none focus-visible:ring-2",
                active && "bg-primary/10 text-primary",
              )}
            >
              {destination.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
