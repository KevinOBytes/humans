"use client";

import Link from "next/link";
import { Command, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const baseCommands = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/people", label: "People" },
] as const;

export function CommandMenu({
  canCreatePerson,
  canViewEvidence,
  canViewGraph,
  canViewImports,
  canViewSearch,
}: {
  canCreatePerson: boolean;
  canViewEvidence: boolean;
  canViewGraph: boolean;
  canViewImports: boolean;
  canViewSearch: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  const commands = useMemo(
    () => [
      ...baseCommands,
      ...(canViewGraph ? [{ href: "/graph", label: "Graph" as const }] : []),
      ...(canViewSearch ? [{ href: "/search", label: "Search" as const }] : []),
      ...(canViewEvidence
        ? [{ href: "/evidence", label: "Evidence" as const }]
        : []),
      ...(canViewImports
        ? [{ href: "/imports", label: "Imports" as const }]
        : []),
      ...(canCreatePerson
        ? [{ href: "/people/new", label: "Add person" as const }]
        : []),
    ],
    [
      canCreatePerson,
      canViewEvidence,
      canViewGraph,
      canViewImports,
      canViewSearch,
    ],
  );
  const visible = commands.filter((item) =>
    item.label.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label="Go to or run a command"
        className="text-muted-foreground hidden min-h-10 gap-3 sm:inline-flex"
      >
        <Search aria-hidden="true" data-icon="inline-start" />
        Commands
        <kbd className="border-border bg-muted rounded border px-1.5 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Go to or run a command"
        className="sm:hidden"
      >
        <Command aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Go to or run a command</DialogTitle>
          <DialogDescription>
            Navigate within the application. Research search is a separate tool.
          </DialogDescription>
          <Input
            className="mt-5"
            aria-label="Filter commands"
            placeholder="Filter commands"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            autoFocus
          />
          <div className="mt-3 flex flex-col gap-1">
            {visible.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="hover:bg-muted focus-visible:ring-ring flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium outline-none focus-visible:ring-2"
              >
                {item.label === "Add person" ? (
                  <Plus aria-hidden="true" />
                ) : null}
                {item.label}
              </Link>
            ))}
            {visible.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                No local command matches.
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
