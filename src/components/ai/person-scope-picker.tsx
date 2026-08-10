"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { executeBrowserGraphQL } from "@/graphql/client";
import { PeopleOptionsDocument } from "@/graphql/generated/graphql";

type PersonOption = { id: string; displayName: string };

export function PersonScopePicker({
  selectedIds,
  onSelect,
  disabled,
}: {
  selectedIds: readonly string[];
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PersonOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchId = useId();
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const term = search.trim().slice(0, 100);
    if (term.length < 2) {
      const timer = setTimeout(() => {
        setResults([]);
        setLoading(false);
      }, 0);
      return () => clearTimeout(timer);
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const loadingTimer = setTimeout(() => {
      setLoading(true);
      setError(null);
    }, 0);
    void executeBrowserGraphQL(
      PeopleOptionsDocument,
      { first: 25, filter: { nameContains: term } },
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError("Could not load people.");
          setResults([]);
          return;
        }
        const nodes = response.data.people?.nodes ?? [];
        setResults(
          nodes.filter((n): n is PersonOption =>
            Boolean(n?.id && n?.displayName),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load people.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      clearTimeout(loadingTimer);
      controller.abort();
    };
  }, [open, search]);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="mt-2"
      >
        Pick person
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Pick a person</DialogTitle>
          <DialogDescription>
            Search by display name and add to scope.
          </DialogDescription>
          <Input
            id={searchId}
            className="mt-4"
            placeholder="Search people…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {loading ? (
            <p className="text-muted-foreground mt-3 text-sm">Loading…</p>
          ) : null}
          {error ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {!loading &&
          !error &&
          results.length === 0 &&
          search.trim().length >= 2 ? (
            <p className="text-muted-foreground mt-3 text-sm">
              No people found.
            </p>
          ) : null}
          <ul
            className="mt-3 max-h-64 divide-y overflow-y-auto"
            aria-label="People search results"
          >
            {results.map((person) => {
              const already = selectedIds.includes(person.id);
              return (
                <li key={person.id} className="py-2">
                  <button
                    type="button"
                    disabled={already}
                    onClick={() => {
                      onSelect(person.id);
                      setOpen(false);
                      setSearch("");
                      setResults([]);
                    }}
                    className="focus-visible:ring-ring hover:bg-muted w-full rounded-lg px-2 py-1 text-left text-sm font-medium outline-none focus-visible:ring-2 disabled:opacity-50"
                  >
                    {person.displayName}
                    {already ? (
                      <span className="text-muted-foreground ml-2 text-xs">
                        (already selected)
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
