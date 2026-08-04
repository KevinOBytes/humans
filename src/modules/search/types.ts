import type { SearchResultKind } from "./normalization";

export type SearchSnippetPart = Readonly<{
  matched: boolean;
  text: string;
}>;

export type SearchHit = Readonly<{
  id: string;
  kind: SearchResultKind;
  rank: number | null;
  snippet: readonly SearchSnippetPart[];
  subjectPersonId: string | null;
  title: string;
  updatedAt: string;
}>;

export type SearchConnection = Readonly<{
  nodes: readonly SearchHit[];
  pageInfo: Readonly<{
    endCursor: string | null;
    hasNextPage: boolean;
  }>;
}>;
