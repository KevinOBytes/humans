import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { PersonProfile } from "@/components/people/person-profile";
import { fictionalProfile } from "../support/fixtures";

it("keeps competing claims independent and exposes governance context on sensitive fields", () => {
  render(<PersonProfile person={fictionalProfile} />);
  expect(
    screen.getAllByRole("article", { name: "Employment claim" }),
  ).toHaveLength(2);
  const phone = within(screen.getByRole("article", { name: "Phone claim" }));
  expect(phone.getByText("RESTRICTED")).toBeInTheDocument();
  expect(phone.getByText("unreviewed")).toBeInTheDocument();
  expect(
    phone.getByRole("link", { name: "Check consent & purpose" }),
  ).toHaveAttribute("href", `/people/${fictionalProfile.id}?view=governance`);
  expect(phone.queryByText("Fictional archive sample")).toBeNull();
  expect(phone.queryByText("+1 202-555-0142")).toBeNull();
  expect(phone.getByText(/withheld.*field-level consent/i)).toBeInTheDocument();
});

it("does not serialize sensitive values or provenance into rendered HTML", () => {
  const { container } = render(
    <PersonProfile
      person={{
        ...fictionalProfile,
        facts: [
          {
            ...fictionalProfile.facts[0]!,
            sensitivity: "CONFIDENTIAL",
            value: "SENSITIVE VALUE",
            evidence: [
              {
                id: "e1",
                title: "SECRET SOURCE",
                excerpt: "SECRET QUOTE",
                url: "https://secret.example.test",
              },
            ],
            revisions: [
              {
                id: "r1",
                revision: 1,
                createdAt: "2026-01-01",
                changeReason: "SECRET CHANGE",
              },
            ],
          },
        ],
      }}
    />,
  );
  for (const secret of [
    "SENSITIVE VALUE",
    "SECRET SOURCE",
    "SECRET QUOTE",
    "secret.example.test",
    "SECRET CHANGE",
  ])
    expect(container.innerHTML).not.toContain(secret);
});

it("uses reserved synthetic contacts and explicitly fictional identities", () => {
  expect(fictionalProfile.biography).toContain("fictional");
  const contacts = fictionalProfile.facts.filter(
    (fact) => fact.fieldKey === "public_contact",
  );
  expect(contacts.every((fact) => fact.value.endsWith("@example.test"))).toBe(
    true,
  );
  expect(
    fictionalProfile.facts.find((fact) => fact.fieldKey === "phone")?.value,
  ).toBe("+1 202-555-0142");
});
