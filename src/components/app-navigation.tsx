"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BrainCircuit,
  Database,
  FileText,
  LayoutDashboard,
  Menu,
  Network,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import type { WorkspaceOption } from "@/components/research/types";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { cn } from "@/lib/utils";

type NavDestination = {
  href: string;
  label: string;
  icon: typeof Users;
  shown: boolean;
};

function destinationLinkClassName(pathname: string, href: string): string {
  const active =
    pathname === href ||
    (href === "/settings/account" && pathname?.startsWith("/settings/"));
  return cn(
    "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none",
    active && "bg-primary/10 text-primary",
  );
}

export function NavigationLinks({
  canViewAnalyst,
  canCreatePerson,
  canViewEvidence,
  canViewGraph,
  canViewImports,
  canViewSearch,
  onNavigate,
}: {
  canViewAnalyst: boolean;
  canCreatePerson: boolean;
  canViewEvidence: boolean;
  canViewGraph: boolean;
  canViewImports: boolean;
  canViewSearch: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const research: NavDestination[] = [
    {
      href: "/dashboard",
      label: "Dashboard",
      icon: LayoutDashboard,
      shown: true,
    },
    { href: "/people", label: "People", icon: Users, shown: true },
    { href: "/graph", label: "Graph", icon: Network, shown: canViewGraph },
    {
      href: "/evidence",
      label: "Evidence",
      icon: FileText,
      shown: canViewEvidence,
    },
    { href: "/search", label: "Search", icon: Search, shown: canViewSearch },
  ];

  const tools: NavDestination[] = [
    {
      href: "/analyst",
      label: "Analyst",
      icon: BrainCircuit,
      shown: canViewAnalyst,
    },
    {
      href: "/imports",
      label: "Imports",
      icon: Database,
      shown: canViewImports,
    },
  ];

  const renderLink = (item: NavDestination) => {
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={
          pathname === item.href ||
          (item.href === "/settings/account" &&
            pathname?.startsWith("/settings/"))
            ? "page"
            : undefined
        }
        onClick={onNavigate}
        className={destinationLinkClassName(pathname, item.href)}
      >
        <Icon aria-hidden="true" />
        {item.label}
      </Link>
    );
  };

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {research.filter((item) => item.shown).map(renderLink)}

      {tools.some((item) => item.shown) ? (
        <div className="mt-5">
          <p className="text-muted-foreground mb-1 px-3 text-xs font-semibold tracking-wide uppercase">
            Operations
          </p>
          {tools.filter((item) => item.shown).map(renderLink)}
        </div>
      ) : null}

      <Link
        href="/settings/account"
        onClick={onNavigate}
        className={cn(
          destinationLinkClassName(pathname, "/settings/account"),
          "mt-5",
        )}
      >
        <Settings aria-hidden="true" />
        Settings
      </Link>

      {canCreatePerson ? (
        <Link
          href="/people/new"
          onClick={onNavigate}
          className={cn(buttonVariants({ variant: "outline" }), "mt-3 w-full")}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          Add person
        </Link>
      ) : null}
    </nav>
  );
}

export function MobileNavigation({
  activeWorkspace,
  canViewAnalyst,
  canCreatePerson,
  canViewEvidence,
  canViewGraph,
  canViewImports,
  canViewSearch,
  organizations,
}: {
  activeWorkspace: WorkspaceOption;
  canViewAnalyst: boolean;
  canCreatePerson: boolean;
  canViewEvidence: boolean;
  canViewGraph: boolean;
  canViewImports: boolean;
  canViewSearch: boolean;
  organizations: readonly WorkspaceOption[];
}) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          className="lg:hidden"
        >
          <Menu aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby="mobile-navigation-description"
        className="top-0 left-0 h-svh max-h-svh w-[min(90vw,22rem)] translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle>Navigation</DialogTitle>
            <DialogDescription id="mobile-navigation-description">
              Move between available workspace areas.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              ref={closeRef}
              variant="ghost"
              size="icon"
              aria-label="Close navigation"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>
        <section aria-labelledby="mobile-workspace-heading" className="mt-7">
          <p
            id="mobile-workspace-heading"
            className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
          >
            Verified workspace
          </p>
          <WorkspaceSwitcher
            activeWorkspace={activeWorkspace}
            organizations={organizations}
          />
        </section>
        <div className="mt-8">
          <NavigationLinks
            canViewAnalyst={canViewAnalyst}
            canCreatePerson={canCreatePerson}
            canViewEvidence={canViewEvidence}
            canViewGraph={canViewGraph}
            canViewImports={canViewImports}
            canViewSearch={canViewSearch}
            onNavigate={() => setOpen(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function HumansMark() {
  return (
    <Link
      href="/dashboard"
      className="focus-visible:ring-ring inline-flex min-h-11 items-center gap-3 rounded-lg focus-visible:ring-2 focus-visible:outline-none"
      aria-label="Humans dashboard"
    >
      <span className="bg-primary/12 text-primary grid size-9 place-items-center rounded-xl">
        <Users aria-hidden="true" />
      </span>
      <span className="text-base font-semibold tracking-tight">Humans</span>
    </Link>
  );
}
