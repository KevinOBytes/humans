import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EvidenceAssociationForm,
  TagForm,
} from "@/components/research/research-record-forms";

const refresh = vi.fn();
const execute = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("research record forms", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
  });

  it("applies an existing workspace tag without recreating it", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: { tagPerson: { personTag: { id: "association-a" }, issues: [] } },
      requestId: "request-tag-existing",
    });
    render(
      <TagForm
        canCreate
        personId="person-a"
        tags={[
          {
            id: "tag-priority",
            name: "priority",
            normalizedName: "priority",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Apply tag" }));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[1]).toEqual({
      input: { personId: "person-a", tagId: "tag-priority" },
    });
  });

  it("recovers a same-name create conflict and applies the existing tag", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: {
          createTag: {
            tag: null,
            code: "CONFLICT",
            currentVersion: 3,
            issues: [],
          },
        },
        requestId: "request-tag-conflict",
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          tags: {
            nodes: [
              {
                id: "tag-existing",
                name: "Priority",
                normalizedName: "priority",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { tagPerson: { personTag: { id: "association-a" }, issues: [] } },
      });
    render(<TagForm canCreate personId="person-a" tags={[]} />);
    await user.type(screen.getByLabelText("New tag name"), "Priority");
    await user.click(screen.getByRole("button", { name: "Apply tag" }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute.mock.calls[2]?.[1]).toEqual({
      input: { personId: "person-a", tagId: "tag-existing" },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("associates an existing-tag ID issue only with the tag select", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        tagPerson: {
          personTag: null,
          code: "VALIDATION_FAILED",
          currentVersion: null,
          issues: [
            {
              code: "UNKNOWN_TAG",
              message: "Choose an available workspace tag.",
              path: ["input", "tagId"],
            },
          ],
        },
      },
      requestId: "request-tag-id",
    });
    render(
      <TagForm
        canCreate
        personId="person-a"
        tags={[
          {
            id: "tag-priority",
            name: "priority",
            normalizedName: "priority",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Apply tag" }));

    const select = await screen.findByLabelText("Tag", { exact: true });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAttribute("aria-describedby", "tag-choice-error");
    expect(document.getElementById("tag-choice-error")).toHaveTextContent(
      "Choose an available workspace tag.",
    );
    expect(screen.queryByLabelText("New tag name")).not.toBeInTheDocument();
  });

  it("associates a new-tag name issue only with the name input", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createTag: {
          tag: null,
          code: "VALIDATION_FAILED",
          currentVersion: null,
          issues: [
            {
              code: "INVALID_TAG_NAME",
              message: "Enter a usable tag name.",
              path: ["input", "name"],
            },
          ],
        },
      },
      requestId: "request-tag-name",
    });
    render(<TagForm canCreate personId="person-a" tags={[]} />);

    const name = screen.getByLabelText("New tag name");
    await user.type(name, "?");
    await user.click(screen.getByRole("button", { name: "Apply tag" }));

    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "tag-name-error");
    expect(document.getElementById("tag-name-error")).toHaveTextContent(
      "Enter a usable tag name.",
    );
    expect(screen.getByLabelText("Tag", { exact: true })).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("retries only the fact link after source and evidence creation succeeded", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: { createSource: { source: { id: "source-a" }, issues: [] } },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          createEvidenceItem: {
            evidenceItem: { id: "evidence-a" },
            issues: [],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          linkFactEvidence: {
            factEvidence: null,
            code: "VALIDATION_FAILED",
            currentVersion: null,
            issues: [
              {
                code: "INVALID_LINK",
                message: "The fact link could not be saved.",
                path: ["factId"],
              },
            ],
          },
        },
        requestId: "request-link-failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          linkFactEvidence: {
            factEvidence: { id: "fact-evidence-a" },
            issues: [],
          },
        },
      });
    render(
      <EvidenceAssociationForm
        facts={[{ id: "fact-a", label: "Birth date" }]}
      />,
    );
    await user.type(screen.getByLabelText("Source title"), "Archive register");
    await user.type(screen.getByLabelText("Excerpt"), "Recorded entry");
    await user.click(screen.getByRole("button", { name: "Add evidence" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "request-link-failed",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "retry will continue with the fact link",
    );
    await user.click(
      screen.getAllByRole("button", { name: "Retry remaining step" })[0]!,
    );
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
    expect(String(execute.mock.calls[2]?.[0])).toContain("LinkFactEvidence");
    expect(String(execute.mock.calls[3]?.[0])).toContain("LinkFactEvidence");
    expect(refresh).toHaveBeenCalledOnce();
  });
});
