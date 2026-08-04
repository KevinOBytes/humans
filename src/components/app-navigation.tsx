"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  FileText,
  Menu,
  Network,
  Plus,
  Search,
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

const destinations = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/people", label: "People" },
  { href: "/settings/account", label: "Settings" },
] as const;

export function NavigationLinks({
  canCreatePerson,
  canViewEvidence,
  canViewGraph,
  canViewImports,
  canViewSearch,
  onNavigate,
}: {
  canCreatePerson: boolean;
  canViewEvidence: boolean;
  canViewGraph: boolean;
  canViewImports: boolean;
  canViewSearch: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {destinations.map((destination) => {
        const active =
          pathname === destination.href ||
          (destination.href === "/settings/account" &&
            pathname?.startsWith("/settings/"));
        return (
          <Link
            key={destination.href}
            href={destination.href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none",
              active && "bg-primary/10 text-primary",
            )}
          >
            {destination.label}
          </Link>
        );
      })}
      {canViewGraph ? (
        <Link
          href="/graph"
          aria-current={pathname === "/graph" ? "page" : undefined}
          onClick={onNavigate}
          className={cn(
            "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none",
            pathname === "/graph" && "bg-primary/10 text-primary",
          )}
        >
          <Network aria-hidden="true" />
          Graph
        </Link>
      ) : null}
      {canViewSearch ? (
        <Link
          href="/search"
          aria-current={pathname === "/search" ? "page" : undefined}
          onClick={onNavigate}
          className={cn(
            "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none",
            pathname === "/search" && "bg-primary/10 text-primary",
          )}
        >
          <Search aria-hidden="true" />
          Search
        </Link>
      ) : null}
      {canViewEvidence ? (
        <Link
          href="/evidence"
          aria-current={pathname === "/evidence" ? "page" : undefined}
          onClick={onNavigate}
          className={cn(
            "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none",
            pathname === "/evidence" && "bg-primary/10 text-primary",
          )}
        >
          <FileText aria-hidden="true" />
          Evidence
        </Link>
      ) : null}
      {canViewImports ? (
        <Link
          href="/imports"
          aria-current={pathname === "/imports" ? "page" : undefined}
          onClick={onNavigate}
          className={cn(
            "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none",
            pathname === "/imports" && "bg-primary/10 text-primary",
          )}
        >
          <Database aria-hidden="true" />
          Imports
        </Link>
      ) : null}
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
  canCreatePerson,
  canViewEvidence,
  canViewGraph,
  canViewImports,
  canViewSearch,
  organizations,
}: {
  activeWorkspace: WorkspaceOption;
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
