"use client";

import { useMemo } from "react";

import { executeBrowserGraphQL } from "@/graphql/client";
import {
  useFragment as readFragment,
  type FragmentType,
} from "@/graphql/generated/fragment-masking";
import {
  AiRunDocument,
  AnalystPublicRunFragmentDoc,
  CancelAiAnalysisDocument,
  StartAiAnalysisDocument,
  type AnalystPublicRunFragment,
} from "@/graphql/generated/graphql";

import { Analyst, type AnalystAdapter, type AnalystRun } from "./analyst";

class AnalystRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The analyst request could not be completed.");
    this.name = "AnalystRequestError";
    this.code = code;
  }
}

function failed(errors: readonly { code: string }[]): never {
  throw new AnalystRequestError(errors[0]?.code ?? "INTERNAL");
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new AnalystRequestError(`INVALID_RESPONSE_${field}`);
  }
  return value;
}

type PublicToolCall = NonNullable<
  AnalystPublicRunFragment["toolCalls"]
>[number];

function countSummary(value: PublicToolCall["inputSummary"]) {
  const summary = required(value, "TOOL_SUMMARY");
  return {
    ...(summary.evidenceCount === null
      ? {}
      : { evidenceCount: summary.evidenceCount }),
    ...(summary.filterCount === null
      ? {}
      : { filterCount: summary.filterCount }),
    ...(summary.personCount === null
      ? {}
      : { personCount: summary.personCount }),
    ...(summary.resourceCount === null
      ? {}
      : { resourceCount: summary.resourceCount }),
    ...(summary.resultCount === null
      ? {}
      : { resultCount: summary.resultCount }),
    ...(summary.truncated === null ? {} : { truncated: summary.truncated }),
  };
}

function analystRun(
  value: FragmentType<typeof AnalystPublicRunFragmentDoc> | null | undefined,
): AnalystRun {
  const row = readFragment(
    AnalystPublicRunFragmentDoc,
    required(value, "ANALYST_RUN"),
  );
  const state = required(row.state, "STATE").toLowerCase();
  if (
    !["cancelled", "completed", "failed", "pending", "running"].includes(state)
  ) {
    throw new AnalystRequestError("INVALID_RESPONSE_STATE");
  }
  return {
    answer: row.answer ?? null,
    citations: required(row.citations, "CITATIONS").map((citation, index) => {
      const resourceKind = required(
        citation.resourceKind,
        `CITATION_${index}_KIND`,
      ).toLowerCase();
      if (resourceKind !== "evidence" && resourceKind !== "person") {
        throw new AnalystRequestError(`INVALID_RESPONSE_CITATION_${index}`);
      }
      return {
        claimText: required(citation.claimText, `CITATION_${index}_CLAIM`),
        locator: citation.locator ?? null,
        resourceId: required(citation.resourceId, `CITATION_${index}_RESOURCE`),
        resourceKind,
      };
    }),
    completedAt: row.completedAt ?? null,
    createdAt: required(row.createdAt, "CREATED_AT"),
    errorCode: row.errorCode?.toLowerCase() ?? null,
    id: required(row.id, "ID"),
    model: required(row.model, "MODEL"),
    provider: required(row.provider, "PROVIDER"),
    startedAt: row.startedAt ?? null,
    state: state as AnalystRun["state"],
    toolCalls: required(row.toolCalls, "TOOL_CALLS").map((tool, index) => {
      const toolState = required(
        tool.state,
        `TOOL_${index}_STATE`,
      ).toLowerCase();
      if (!["completed", "failed", "pending", "running"].includes(toolState)) {
        throw new AnalystRequestError(`INVALID_RESPONSE_TOOL_${index}_STATE`);
      }
      return {
        completedAt: tool.completedAt ?? null,
        inputSummary: countSummary(tool.inputSummary),
        name: required(tool.name, `TOOL_${index}_NAME`),
        resultSummary: tool.resultSummary
          ? countSummary(tool.resultSummary)
          : null,
        startedAt: tool.startedAt ?? null,
        state: toolState as AnalystRun["toolCalls"][number]["state"],
      };
    }),
  };
}

export function createBrowserAnalystAdapter(): AnalystAdapter {
  return {
    async cancel(id, options) {
      const response = await executeBrowserGraphQL(
        CancelAiAnalysisDocument,
        { id },
        options,
      );
      if (!response.ok) return failed(response.errors);
      return analystRun(response.data.cancelAiAnalysis);
    },
    async read(id, options) {
      const response = await executeBrowserGraphQL(
        AiRunDocument,
        { id },
        options,
      );
      if (!response.ok) return failed(response.errors);
      return analystRun(response.data.aiRun);
    },
    async start(input, options) {
      const response = await executeBrowserGraphQL(
        StartAiAnalysisDocument,
        {
          input: {
            ...input,
            scope: {
              evidenceIds: [...input.scope.evidenceIds],
              personIds: [...input.scope.personIds],
            },
          },
        },
        options,
      );
      if (!response.ok) return failed(response.errors);
      return analystRun(response.data.startAiAnalysis);
    },
  };
}

export function BrowserAnalyst(props: {
  canCancel: boolean;
  canStart: boolean;
  workspaceIdentity: string;
}) {
  const adapter = useMemo(() => createBrowserAnalystAdapter(), []);
  return <Analyst {...props} adapter={adapter} />;
}
