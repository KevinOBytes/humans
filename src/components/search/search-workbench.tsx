"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  SavedQuerySharing,
  SearchFiltersInput,
  SearchInput,
  SearchResultKind,
  Sensitivity,
} from "@/graphql/generated/graphql";

export type SearchWorkbenchHit = {
  id: string;
  kind: SearchResultKind;
  rank: number | null;
  snippet: readonly { matched: boolean; text: string }[];
  title: string;
  updatedAt: string;
};

export type SearchWorkbenchPage = {
  nodes: readonly SearchWorkbenchHit[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};

export type SearchWorkbenchSavedQuery = {
  archivedAt: string | null;
  createdAt: string;
  id: string;
  name: string;
  ownerPrincipalId: string;
  queryAst: unknown;
  sharing: SavedQuerySharing;
  updatedAt: string;
  version: number;
};

export type SearchWorkbenchSavedPage = {
  nodes: readonly SearchWorkbenchSavedQuery[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};

export type SearchWorkbenchAdapter = {
  archiveSaved(
    id: string,
    expectedVersion: number,
  ): Promise<SearchWorkbenchSavedQuery | null>;
  createSaved(input: {
    name: string;
    queryAst: unknown;
    sharing: SavedQuerySharing;
  }): Promise<SearchWorkbenchSavedQuery | null>;
  listSaved(after?: string): Promise<SearchWorkbenchSavedPage>;
  readSaved(id: string): Promise<SearchWorkbenchSavedQuery | null>;
  runSaved(id: string): Promise<SearchWorkbenchPage>;
  search(input: SearchInput): Promise<SearchWorkbenchPage>;
  updateSaved(input: {
    expectedVersion: number;
    id: string;
    name: string;
    queryAst: unknown;
    sharing: SavedQuerySharing;
  }): Promise<SearchWorkbenchSavedQuery | null>;
};

type SearchMode = "TEXT" | "PROTECTED_EXACT";
type ProtectedKind = "PHONE" | "PERSON_IDENTIFIER";
type RequestLane = "search" | "savedAction" | "savedList";
type RequestToken = {
  generation: number;
  lane: RequestLane;
  request: number;
};
type AstV1 = {
  filters: Record<string, unknown>;
  kinds: SearchResultKind[];
  match: { query: string; type: "text" };
  pageSize: number;
  schema: "humans.search-query";
  version: 1;
};

const RESULT_KINDS: readonly SearchResultKind[] = [
  "PERSON",
  "FACT",
  "ADDRESS",
  "RELATIONSHIP",
  "EVIDENCE",
];
const SENSITIVITIES: readonly Sensitivity[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
];
const FACT_STATES = [
  "",
  "asserted",
  "corroborated",
  "disputed",
  "disproven",
  "superseded",
  "unknown",
] as const;
const RELATIONSHIP_STATES = [
  "",
  "asserted",
  "inferred",
  "corroborated",
  "disputed",
  "disproven",
  "inactive",
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AST_FILTER_KEYS = new Set([
  "personIds",
  "factDefinitionIds",
  "factStates",
  "relationshipTypeIds",
  "relationshipStates",
  "sourceIds",
  "sensitivities",
  "at",
  "from",
  "until",
]);

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

function safeFailure(error: unknown): string {
  const code = errorCode(error);
  if (code === "VALIDATION_FAILED" || code === "CONFLICT")
    return "Search input is invalid or has changed. Review it and try again.";
  if (code === "RATE_LIMITED")
    return "Search capacity is temporarily exhausted. Wait and try again.";
  if (
    code === "PROVIDER_UNAVAILABLE" ||
    code === "NETWORK_ERROR" ||
    code === "INVALID_RESPONSE"
  )
    return "Search is temporarily unavailable. Try again later.";
  if (code === "NOT_FOUND")
    return "The requested search is no longer available.";
  return "Search could not be completed.";
}

function parseIds(value: string): string[] | undefined {
  const ids = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.some((id) => !UUID.test(id)) || ids.length > 64)
    throw new Error("INVALID_LOCAL_SEARCH");
  return ids.length ? ids.sort() : undefined;
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_LOCAL_SEARCH");
  return date.toISOString();
}

function validPage(page: SearchWorkbenchPage): void {
  if (
    !page ||
    !Array.isArray(page.nodes) ||
    !page.pageInfo ||
    typeof page.pageInfo.hasNextPage !== "boolean" ||
    (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
    page.nodes.some(
      (hit) =>
        !UUID.test(hit.id) ||
        !RESULT_KINDS.includes(hit.kind) ||
        typeof hit.title !== "string" ||
        typeof hit.updatedAt !== "string" ||
        !Array.isArray(hit.snippet) ||
        hit.snippet.some(
          (part: { matched: unknown; text: unknown }) =>
            typeof part.text !== "string" || typeof part.matched !== "boolean",
        ),
    )
  )
    throw new Error("INVALID_SEARCH_RESPONSE");
}

function asAst(value: unknown): AstV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_SAVED_SEARCH");
  const ast = value as Record<string, unknown>;
  const match = ast.match as Record<string, unknown> | undefined;
  const filters = ast.filters as Record<string, unknown> | undefined;
  if (
    Reflect.ownKeys(ast).length !== 6 ||
    ast.schema !== "humans.search-query" ||
    ast.version !== 1 ||
    !match ||
    Reflect.ownKeys(match).length !== 2 ||
    match.type !== "text" ||
    typeof match.query !== "string" ||
    !Array.isArray(ast.kinds) ||
    ast.kinds.length < 1 ||
    ast.kinds.some(
      (kind) => !RESULT_KINDS.includes(kind as SearchResultKind),
    ) ||
    !filters ||
    Array.isArray(filters) ||
    (Object.getPrototypeOf(filters) !== Object.prototype &&
      Object.getPrototypeOf(filters) !== null) ||
    !Number.isInteger(ast.pageSize) ||
    Number(ast.pageSize) < 1 ||
    Number(ast.pageSize) > 100
  )
    throw new Error("INVALID_SAVED_SEARCH");
  const filterKeys = Reflect.ownKeys(filters);
  if (
    filterKeys.some(
      (key) => typeof key !== "string" || !AST_FILTER_KEYS.has(key),
    ) ||
    new TextEncoder().encode(match.query.trim()).length < 1 ||
    new TextEncoder().encode(match.query).length > 256 ||
    /[\p{Cc}\p{Cf}]/u.test(match.query) ||
    new Set(ast.kinds as unknown[]).size !== ast.kinds.length
  )
    throw new Error("INVALID_SAVED_SEARCH");
  const array = (
    key: string,
    cap: number,
    allowed?: readonly string[],
  ): string[] | undefined => {
    const item = filters[key];
    if (item === undefined) return undefined;
    if (
      !Array.isArray(item) ||
      item.length > cap ||
      item.some(
        (entry) =>
          typeof entry !== "string" ||
          (allowed ? !allowed.includes(entry) : !UUID.test(entry)),
      )
    )
      throw new Error("INVALID_SAVED_SEARCH");
    return item;
  };
  array("personIds", 20);
  array("factDefinitionIds", 50);
  array("relationshipTypeIds", 50);
  array("sourceIds", 50);
  array("factStates", 10, FACT_STATES.filter(Boolean));
  array("relationshipStates", 10, RELATIONSHIP_STATES.filter(Boolean));
  array(
    "sensitivities",
    10,
    SENSITIVITIES.map((item) => item.toLocaleLowerCase("und")),
  );
  const dates = ["at", "from", "until"].map((key) => {
    const item = filters[key];
    if (item === undefined) return undefined;
    if (
      typeof item !== "string" ||
      item.length > 64 ||
      !/(?:Z|[+-]\d{2}:\d{2})$/u.test(item) ||
      !Number.isFinite(new Date(item).getTime())
    )
      throw new Error("INVALID_SAVED_SEARCH");
    return new Date(item).toISOString();
  });
  if (
    (dates[0] && (dates[1] || dates[2])) ||
    (dates[1] && dates[2] && dates[1] > dates[2])
  )
    throw new Error("INVALID_SAVED_SEARCH");
  return ast as AstV1;
}

function mergeById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) values.set(item.id, item);
  return [...values.values()];
}

function TextFilter({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="mt-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Comma-separated UUIDs"
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

type SearchWorkbenchProps = {
  adapter: SearchWorkbenchAdapter;
  canManageSaved: boolean;
  viewerPrincipalId: string;
  workspaceIdentity: string;
};

export function SearchWorkbench(props: SearchWorkbenchProps) {
  return <SearchWorkbenchState key={props.workspaceIdentity} {...props} />;
}

function SearchWorkbenchState({
  adapter,
  canManageSaved,
  viewerPrincipalId,
  workspaceIdentity,
}: SearchWorkbenchProps) {
  const generationRef = useRef(0);
  const requestRef = useRef<Record<RequestLane, number>>({
    savedAction: 0,
    savedList: 0,
    search: 0,
  });
  const [mode, setMode] = useState<SearchMode>("TEXT");
  const [query, setQuery] = useState("");
  const [protectedKind, setProtectedKind] = useState<ProtectedKind>("PHONE");
  const [protectedValue, setProtectedValue] = useState("");
  const [namespace, setNamespace] = useState("");
  const [kinds, setKinds] = useState<readonly SearchResultKind[]>(RESULT_KINDS);
  const [sensitivities, setSensitivities] = useState<readonly Sensitivity[]>(
    [],
  );
  const [personIds, setPersonIds] = useState("");
  const [factDefinitionIds, setFactDefinitionIds] = useState("");
  const [relationshipTypeIds, setRelationshipTypeIds] = useState("");
  const [sourceIds, setSourceIds] = useState("");
  const [factState, setFactState] = useState("");
  const [relationshipState, setRelationshipState] = useState("");
  const [at, setAt] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [first, setFirst] = useState(25);
  const [results, setResults] = useState<readonly SearchWorkbenchHit[]>([]);
  const [pageInfo, setPageInfo] = useState({
    endCursor: null as string | null,
    hasNextPage: false,
  });
  const [seenSearchCursors, setSeenSearchCursors] = useState<
    ReadonlySet<string>
  >(new Set());
  const [lastInput, setLastInput] = useState<SearchInput | null>(null);
  const [savedQueries, setSavedQueries] = useState<
    readonly SearchWorkbenchSavedQuery[]
  >([]);
  const [savedPageInfo, setSavedPageInfo] = useState({
    endCursor: null as string | null,
    hasNextPage: false,
  });
  const [seenSavedCursors, setSeenSavedCursors] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedSavedId, setSelectedSavedId] = useState("");
  const [savedName, setSavedName] = useState("");
  const [sharing, setSharing] = useState<SavedQuerySharing>("PRIVATE");
  const [pending, setPending] = useState(false);
  const [savedPending, setSavedPending] = useState(canManageSaved);
  const [status, setStatus] = useState("Enter a search query to begin.");

  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [adapter, workspaceIdentity]);

  function begin(lane: RequestLane): RequestToken {
    requestRef.current[lane] += 1;
    return {
      generation: generationRef.current,
      lane,
      request: requestRef.current[lane],
    };
  }

  function current(token: RequestToken) {
    return (
      token.generation === generationRef.current &&
      token.request === requestRef.current[token.lane]
    );
  }

  useEffect(() => {
    if (!canManageSaved) return;
    const token = begin("savedList");
    adapter
      .listSaved()
      .then((page) => {
        if (!current(token)) return;
        if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
          throw new Error("INVALID_SAVED_SEARCH_PAGE");
        setSavedQueries(mergeById([], page.nodes));
        setSavedPageInfo(page.pageInfo);
        setSeenSavedCursors(
          page.pageInfo.endCursor
            ? new Set([page.pageInfo.endCursor])
            : new Set(),
        );
      })
      .catch(() => {
        if (current(token)) setStatus("Saved queries could not be listed.");
      })
      .finally(() => {
        if (current(token)) setSavedPending(false);
      });
  }, [adapter, canManageSaved, workspaceIdentity]);

  const selectedSaved = useMemo(
    () => savedQueries.find(({ id }) => id === selectedSavedId) ?? null,
    [savedQueries, selectedSavedId],
  );
  const ownsSelected = selectedSaved?.ownerPrincipalId === viewerPrincipalId;

  function filters(): SearchFiltersInput {
    return {
      ...(parseIds(personIds) ? { personIds: parseIds(personIds) } : {}),
      ...(parseIds(factDefinitionIds)
        ? { factDefinitionIds: parseIds(factDefinitionIds) }
        : {}),
      ...(factState ? { factStates: [factState] } : {}),
      ...(parseIds(relationshipTypeIds)
        ? { relationshipTypeIds: parseIds(relationshipTypeIds) }
        : {}),
      ...(relationshipState ? { relationshipStates: [relationshipState] } : {}),
      ...(parseIds(sourceIds) ? { sourceIds: parseIds(sourceIds) } : {}),
      ...(sensitivities.length ? { sensitivities: [...sensitivities] } : {}),
      ...(isoDate(at) ? { at: isoDate(at) } : {}),
      ...(isoDate(from) ? { from: isoDate(from) } : {}),
      ...(isoDate(until) ? { until: isoDate(until) } : {}),
    };
  }

  function input(after?: string): SearchInput {
    if (mode === "TEXT") {
      if (
        !kinds.length ||
        new TextEncoder().encode(query.trim()).length < 1 ||
        new TextEncoder().encode(query).length > 256
      )
        throw new Error("INVALID_LOCAL_SEARCH");
      return {
        version: 1,
        match: { type: "TEXT", query },
        kinds: [...kinds],
        filters: filters(),
        first: Math.min(Math.max(first, 1), 100),
        ...(after ? { after } : {}),
      };
    }
    if (
      !protectedValue ||
      (protectedKind === "PERSON_IDENTIFIER" && !namespace.trim())
    )
      throw new Error("INVALID_LOCAL_SEARCH");
    return {
      version: 1,
      match: {
        type: "PROTECTED_EXACT",
        protectedKind,
        value: protectedValue,
        ...(protectedKind === "PERSON_IDENTIFIER"
          ? { namespace: namespace.trim() }
          : {}),
      },
      kinds: ["PERSON"],
      filters: {},
      first: Math.min(Math.max(first, 1), 100),
      ...(after ? { after } : {}),
    };
  }

  function acceptPage(
    page: SearchWorkbenchPage,
    token: RequestToken,
    append: boolean,
  ) {
    if (!current(token)) return;
    validPage(page);
    if (
      append &&
      page.pageInfo.endCursor &&
      seenSearchCursors.has(page.pageInfo.endCursor)
    )
      throw new Error("NON_ADVANCING_SEARCH_CURSOR");
    setResults((existing) => mergeById(append ? existing : [], page.nodes));
    setPageInfo(page.pageInfo);
    if (page.pageInfo.endCursor)
      setSeenSearchCursors(
        (existing) =>
          new Set(
            append
              ? [...existing, page.pageInfo.endCursor!]
              : [page.pageInfo.endCursor!],
          ),
      );
    else if (!append) setSeenSearchCursors(new Set());
    setStatus(
      page.nodes.length || append
        ? "Authorized search results loaded."
        : "No authorized results matched this search.",
    );
  }

  async function runSearch(event?: FormEvent) {
    event?.preventDefault();
    if (pending) return;
    let searchInput: SearchInput;
    try {
      searchInput = input();
    } catch {
      setStatus("Search input is invalid. Review it and try again.");
      return;
    }
    const token = begin("search");
    setPending(true);
    setStatus("Searching authorized records…");
    setResults([]);
    setPageInfo({ endCursor: null, hasNextPage: false });
    setSeenSearchCursors(new Set());
    setLastInput(searchInput);
    try {
      acceptPage(await adapter.search(searchInput), token, false);
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setPending(false);
    }
  }

  async function loadMore() {
    if (pending || !lastInput || !pageInfo.hasNextPage || !pageInfo.endCursor)
      return;
    const token = begin("search");
    setPending(true);
    setStatus("Loading more authorized results…");
    try {
      const next = { ...lastInput, after: pageInfo.endCursor };
      acceptPage(await adapter.search(next), token, true);
      setLastInput(next);
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setPending(false);
    }
  }

  function ast(): AstV1 {
    const searchInput = input();
    if (searchInput.match.type !== "TEXT")
      throw new Error("PROTECTED_SEARCH_NOT_SAVABLE");
    return {
      schema: "humans.search-query",
      version: 1,
      match: { type: "text", query: searchInput.match.query ?? "" },
      kinds: [...searchInput.kinds],
      filters: {
        ...searchInput.filters,
        ...(searchInput.filters.sensitivities
          ? {
              sensitivities: searchInput.filters.sensitivities.map((value) =>
                value.toLocaleLowerCase("und"),
              ),
            }
          : {}),
      },
      pageSize: searchInput.first ?? 25,
    };
  }

  function applyAst(value: unknown) {
    const parsed = asAst(value);
    const astFilters = parsed.filters;
    setMode("TEXT");
    setProtectedValue("");
    setNamespace("");
    setQuery(parsed.match.query);
    setKinds(parsed.kinds);
    setPersonIds(
      ((astFilters.personIds as string[] | undefined) ?? []).join(", "),
    );
    setFactDefinitionIds(
      ((astFilters.factDefinitionIds as string[] | undefined) ?? []).join(", "),
    );
    setRelationshipTypeIds(
      ((astFilters.relationshipTypeIds as string[] | undefined) ?? []).join(
        ", ",
      ),
    );
    setSourceIds(
      ((astFilters.sourceIds as string[] | undefined) ?? []).join(", "),
    );
    setFactState((astFilters.factStates as string[] | undefined)?.[0] ?? "");
    setRelationshipState(
      (astFilters.relationshipStates as string[] | undefined)?.[0] ?? "",
    );
    setSensitivities(
      ((astFilters.sensitivities as string[] | undefined) ?? []).map(
        (value) => value.toLocaleUpperCase("und") as Sensitivity,
      ),
    );
    setAt(typeof astFilters.at === "string" ? astFilters.at.slice(0, 16) : "");
    setFrom(
      typeof astFilters.from === "string" ? astFilters.from.slice(0, 16) : "",
    );
    setUntil(
      typeof astFilters.until === "string" ? astFilters.until.slice(0, 16) : "",
    );
    setFirst(parsed.pageSize);
  }

  async function selectSaved(id: string) {
    setSelectedSavedId(id);
    if (!id) {
      setSavedName("");
      setSharing("PRIVATE");
      return;
    }
    const token = begin("savedAction");
    setSavedPending(true);
    try {
      const saved = await adapter.readSaved(id);
      if (!current(token)) return;
      if (!saved || saved.id !== id) throw { code: "NOT_FOUND" };
      applyAst(saved.queryAst);
      setSavedQueries((existing) => mergeById(existing, [saved]));
      setSelectedSavedId(saved.id);
      setSavedName(saved.name);
      setSharing(saved.sharing);
      setStatus("Saved query loaded. Run it to apply current authorization.");
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setSavedPending(false);
    }
  }

  async function createSaved() {
    if (!canManageSaved || mode !== "TEXT" || savedPending) return;
    let queryAst: AstV1;
    try {
      if (!savedName.trim()) throw new Error("INVALID_LOCAL_SEARCH");
      queryAst = ast();
    } catch {
      setStatus("Search input is invalid. Review it and try again.");
      return;
    }
    const token = begin("savedAction");
    setSavedPending(true);
    try {
      const saved = await adapter.createSaved({
        name: savedName,
        queryAst,
        sharing,
      });
      if (!current(token)) return;
      if (!saved) throw new Error("INVALID_SAVED_SEARCH_RESPONSE");
      setSavedQueries((existing) => mergeById(existing, [saved]));
      setSelectedSavedId(saved.id);
      setSavedName(saved.name);
      setSharing(saved.sharing);
      setStatus("Current query saved.");
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setSavedPending(false);
    }
  }

  async function updateSaved() {
    if (!selectedSaved || !ownsSelected || savedPending) return;
    const token = begin("savedAction");
    setSavedPending(true);
    try {
      const saved = await adapter.updateSaved({
        expectedVersion: selectedSaved.version,
        id: selectedSaved.id,
        name: savedName,
        queryAst: ast(),
        sharing,
      });
      if (!current(token)) return;
      if (!saved) throw new Error("INVALID_SAVED_SEARCH_RESPONSE");
      setSavedQueries((existing) => mergeById(existing, [saved]));
      setStatus("Saved query updated.");
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setSavedPending(false);
    }
  }

  async function archiveSaved() {
    if (!selectedSaved || !ownsSelected || savedPending) return;
    const token = begin("savedAction");
    setSavedPending(true);
    try {
      const archived = await adapter.archiveSaved(
        selectedSaved.id,
        selectedSaved.version,
      );
      if (!current(token)) return;
      if (!archived) throw new Error("INVALID_SAVED_SEARCH_RESPONSE");
      setSavedQueries((existing) =>
        existing.filter(({ id }) => id !== selectedSaved.id),
      );
      setSelectedSavedId("");
      setSavedName("");
      setSharing("PRIVATE");
      setStatus("Saved query archived.");
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setSavedPending(false);
    }
  }

  async function runSaved() {
    if (!selectedSaved || pending) return;
    const token = begin("search");
    setPending(true);
    setStatus("Running the saved query with current authorization…");
    setResults([]);
    setPageInfo({ endCursor: null, hasNextPage: false });
    setSeenSearchCursors(new Set());
    setLastInput(null);
    try {
      acceptPage(await adapter.runSaved(selectedSaved.id), token, false);
    } catch (error) {
      if (current(token)) setStatus(safeFailure(error));
    } finally {
      if (current(token)) setPending(false);
    }
  }

  async function loadMoreSaved() {
    if (savedPending || !savedPageInfo.hasNextPage || !savedPageInfo.endCursor)
      return;
    const token = begin("savedList");
    const after = savedPageInfo.endCursor;
    setSavedPending(true);
    try {
      const page = await adapter.listSaved(after);
      if (!current(token)) return;
      if (
        (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
        (page.pageInfo.endCursor &&
          seenSavedCursors.has(page.pageInfo.endCursor))
      )
        throw new Error("NON_ADVANCING_SAVED_CURSOR");
      setSavedQueries((existing) => mergeById(existing, page.nodes));
      setSavedPageInfo(page.pageInfo);
      if (page.pageInfo.endCursor)
        setSeenSavedCursors(
          (existing) => new Set([...existing, page.pageInfo.endCursor!]),
        );
    } catch {
      if (current(token)) setStatus("More saved queries could not be listed.");
    } finally {
      if (current(token)) setSavedPending(false);
    }
  }

  return (
    <div className="space-y-7">
      <header>
        <p className="text-primary text-sm font-semibold">Research workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Authorized search
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          Search only the records visible to your current workspace role. Query
          and protected values stay in this tab and are never placed in the URL.
        </p>
      </header>

      <form
        aria-labelledby="search-controls-heading"
        className="border-border bg-card rounded-2xl border p-5 shadow-sm"
        onSubmit={runSearch}
      >
        <h2 id="search-controls-heading" className="text-xl font-semibold">
          Search controls
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="search-mode">Search mode</Label>
            <select
              id="search-mode"
              className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
              value={mode}
              onChange={(event) => {
                const nextMode = event.target.value as SearchMode;
                setMode(nextMode);
                if (nextMode === "PROTECTED_EXACT") setQuery("");
                else {
                  setProtectedValue("");
                  setNamespace("");
                }
                setResults([]);
                setPageInfo({ endCursor: null, hasNextPage: false });
                setLastInput(null);
              }}
            >
              <option value="TEXT">Text</option>
              <option value="PROTECTED_EXACT">Protected exact</option>
            </select>
          </div>
          <div>
            <Label htmlFor="search-first">Results per page</Label>
            <select
              id="search-first"
              className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
              value={first}
              onChange={(event) => setFirst(Number(event.target.value))}
            >
              {[10, 25, 50, 100].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
        {mode === "TEXT" ? (
          <div className="mt-4">
            <Label htmlFor="search-query">Search query</Label>
            <Input
              id="search-query"
              className="mt-2"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="protected-search-kind">
                Protected value kind
              </Label>
              <select
                id="protected-search-kind"
                className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                value={protectedKind}
                onChange={(event) => {
                  const nextKind = event.target.value as ProtectedKind;
                  setProtectedKind(nextKind);
                  setProtectedValue("");
                  if (nextKind === "PHONE") setNamespace("");
                }}
              >
                <option value="PHONE">Phone</option>
                <option value="PERSON_IDENTIFIER">Person identifier</option>
              </select>
            </div>
            <div>
              <Label htmlFor="protected-search-value">Protected value</Label>
              <Input
                id="protected-search-value"
                className="mt-2"
                type="password"
                value={protectedValue}
                onChange={(event) => setProtectedValue(event.target.value)}
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {protectedKind === "PERSON_IDENTIFIER" ? (
              <div>
                <Label htmlFor="protected-search-namespace">
                  Identifier namespace
                </Label>
                <Input
                  id="protected-search-namespace"
                  className="mt-2"
                  value={namespace}
                  onChange={(event) => setNamespace(event.target.value)}
                  maxLength={120}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : null}
          </div>
        )}

        {mode === "TEXT" ? (
          <details className="border-border mt-5 rounded-xl border p-4">
            <summary className="cursor-pointer font-semibold">
              Structured filters
            </summary>
            <fieldset className="mt-4">
              <legend className="text-sm font-semibold">Result kinds</legend>
              <div className="mt-2 flex flex-wrap gap-4">
                {RESULT_KINDS.map((kind) => (
                  <label
                    key={kind}
                    className="flex min-h-11 items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={kinds.includes(kind)}
                      onChange={(event) =>
                        setKinds((currentKinds) =>
                          event.target.checked
                            ? [...new Set([...currentKinds, kind])]
                            : currentKinds.filter((value) => value !== kind),
                        )
                      }
                    />
                    {kind}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="mt-4">
              <legend className="text-sm font-semibold">Sensitivities</legend>
              <div className="mt-2 flex flex-wrap gap-4">
                {SENSITIVITIES.map((sensitivity) => (
                  <label
                    key={sensitivity}
                    className="flex min-h-11 items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={sensitivities.includes(sensitivity)}
                      onChange={(event) =>
                        setSensitivities((currentSensitivities) =>
                          event.target.checked
                            ? [
                                ...new Set([
                                  ...currentSensitivities,
                                  sensitivity,
                                ]),
                              ]
                            : currentSensitivities.filter(
                                (value) => value !== sensitivity,
                              ),
                        )
                      }
                    />
                    {sensitivity}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <TextFilter
                id="search-person-ids"
                label="Person IDs"
                value={personIds}
                onChange={setPersonIds}
              />
              <TextFilter
                id="search-definition-ids"
                label="Fact definition IDs"
                value={factDefinitionIds}
                onChange={setFactDefinitionIds}
              />
              <TextFilter
                id="search-relationship-type-ids"
                label="Relationship type IDs"
                value={relationshipTypeIds}
                onChange={setRelationshipTypeIds}
              />
              <TextFilter
                id="search-source-ids"
                label="Source IDs"
                value={sourceIds}
                onChange={setSourceIds}
              />
              <div>
                <Label htmlFor="search-fact-state">Fact state</Label>
                <select
                  id="search-fact-state"
                  className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                  value={factState}
                  onChange={(event) => setFactState(event.target.value)}
                >
                  {FACT_STATES.map((value) => (
                    <option key={value} value={value}>
                      {value || "Any"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="search-relationship-state">
                  Relationship state
                </Label>
                <select
                  id="search-relationship-state"
                  className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                  value={relationshipState}
                  onChange={(event) => setRelationshipState(event.target.value)}
                >
                  {RELATIONSHIP_STATES.map((value) => (
                    <option key={value} value={value}>
                      {value || "Any"}
                    </option>
                  ))}
                </select>
              </div>
              {[
                ["search-at", "Active at", at, setAt],
                ["search-from", "From", from, setFrom],
                ["search-until", "Until", until, setUntil],
              ].map(([id, label, value, update]) => (
                <div key={id as string}>
                  <Label htmlFor={id as string}>{label as string}</Label>
                  <Input
                    id={id as string}
                    className="mt-2"
                    type="datetime-local"
                    value={value as string}
                    onChange={(event) =>
                      (update as (value: string) => void)(event.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Searching…" : "Search"}
          </Button>
          {pageInfo.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending || !pageInfo.endCursor}
              onClick={loadMore}
            >
              Load more results
            </Button>
          ) : null}
        </div>
      </form>

      <p
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-sm"
      >
        {status}
      </p>

      <section aria-labelledby="search-results-heading">
        <h2 id="search-results-heading" className="text-xl font-semibold">
          Results
        </h2>
        {results.length ? (
          <ul aria-label="Authorized search results" className="mt-4 space-y-3">
            {results.map((hit) => (
              <li
                key={hit.id}
                className="border-border bg-card rounded-2xl border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{hit.title}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {hit.kind} · Updated {hit.updatedAt}
                    </p>
                  </div>
                  {hit.rank === null ? null : (
                    <span className="text-muted-foreground text-xs">
                      Rank {hit.rank}
                    </span>
                  )}
                </div>
                <p className="mt-3 text-sm">
                  {hit.snippet.map((part, index) =>
                    part.matched ? (
                      <mark
                        key={`${hit.id}:${index}`}
                        className="bg-primary/20 text-foreground rounded-sm px-0.5"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <span key={`${hit.id}:${index}`}>{part.text}</span>
                    ),
                  )}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {canManageSaved ? (
        <section
          aria-labelledby="saved-search-heading"
          className="border-border bg-card rounded-2xl border p-5 shadow-sm"
        >
          <h2 id="saved-search-heading" className="text-xl font-semibold">
            Saved queries
          </h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Private queries are visible only to you. Workspace queries are
            readable by authorized workspace members, but only the owner can
            update or archive them. Protected exact values cannot be saved.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <Label htmlFor="saved-search-select">Saved query</Label>
              <select
                id="saved-search-select"
                className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                value={selectedSavedId}
                onChange={(event) => void selectSaved(event.target.value)}
              >
                <option value="">Choose a saved query</option>
                {savedQueries.map((saved) => (
                  <option key={saved.id} value={saved.id}>
                    {saved.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="saved-search-name">Saved query name</Label>
              <Input
                id="saved-search-name"
                className="mt-2"
                value={savedName}
                onChange={(event) => setSavedName(event.target.value)}
                maxLength={120}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="saved-search-sharing">Sharing</Label>
              <select
                id="saved-search-sharing"
                className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                value={sharing}
                onChange={(event) =>
                  setSharing(event.target.value as SavedQuerySharing)
                }
              >
                <option value="PRIVATE">Private</option>
                <option value="WORKSPACE">Workspace</option>
              </select>
            </div>
          </div>
          {selectedSaved && !ownsSelected ? (
            <p className="text-muted-foreground mt-3 text-sm">
              This workspace-shared query is read-only because you are not its
              owner.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={savedPending || mode !== "TEXT"}
              onClick={createSaved}
            >
              Save current query
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                savedPending ||
                !selectedSaved ||
                !ownsSelected ||
                mode !== "TEXT"
              }
              onClick={updateSaved}
            >
              Update saved query
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={savedPending || !selectedSaved || !ownsSelected}
              onClick={archiveSaved}
            >
              Archive saved query
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || !selectedSaved}
              onClick={runSaved}
            >
              Run saved query
            </Button>
            {savedPageInfo.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                disabled={savedPending || !savedPageInfo.endCursor}
                onClick={loadMoreSaved}
              >
                Load more saved queries
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
