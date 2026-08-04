import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AddressEditForm,
  AddressForm,
  ArchiveContactButton,
  ContactEditForm,
  PhoneContactForm,
  PlaceForm,
  ProtectedAddressPresentation,
  ProtectedContactPresentation,
} from "@/components/locations/location-forms";

const execute = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("contact and location forms", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
  });

  it("submits a protected contact through GraphQL with safe defaults and never places it in navigation", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createPersonContact: {
          contact: { associationId: "association-a" },
          issues: [],
          code: null,
        },
      },
    });
    render(<PhoneContactForm personId="person-a" />);
    await user.type(screen.getByLabelText("Phone number"), "+1 (202) 555-0123");
    await user.type(screen.getByLabelText("Label"), "Mobile");
    await user.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      input: {
        personId: "person-a",
        kind: "PHONE",
        value: "+1 (202) 555-0123",
        label: "Mobile",
        sensitivity: "INTERNAL",
      },
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(window.location.href).not.toContain("202");
  });

  it("keeps protected presentation out of server/client props and loads exact visible projections", async () => {
    const phone = "+1 202 555 0188";
    const line1 = "188 Client Projection Lane";
    execute.mockImplementation((document: { toString(): string }) => {
      const operation = document.toString();
      if (operation.includes("ContactDisplayProjection"))
        return Promise.resolve({
          ok: true,
          data: {
            contactDisplayProjection: {
              associationId: "contact-association",
              displayValue: phone,
              label: "Mobile",
              usageKind: "personal",
            },
          },
        });
      return Promise.resolve({
        ok: true,
        data: {
          addressDisplayProjection: {
            associationId: "address-association",
            line1,
            line2: null,
            locality: "Richmond",
            region: "VA",
            postalCode: "23220",
            countryCode: "US",
            unstructuredText: null,
            place: { name: "Richmond" },
          },
        },
      });
    });
    const { container } = render(
      <>
        <ProtectedContactPresentation
          associationId="contact-association"
          version={1}
        />
        <ProtectedAddressPresentation
          associationId="address-association"
          version={1}
        />
      </>,
    );

    expect(container.innerHTML).not.toContain(phone);
    expect(container.innerHTML).not.toContain(line1);
    expect(await screen.findByText(phone)).toBeVisible();
    expect(await screen.findByText(line1)).toBeVisible();
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { associationId: "contact-association" },
      { associationId: "address-association" },
    ]);
  });

  it("preserves address input and exposes a safe validation alert", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        createPersonAddress: {
          address: null,
          code: "VALIDATION_FAILED",
          issues: [{ message: "The address is invalid." }],
        },
      },
    });
    render(
      <AddressForm
        personId="person-a"
        places={[{ id: "place-a", name: "Richmond" }]}
      />,
    );
    await user.type(screen.getByLabelText("Address line 1"), "123 Draft St");
    await user.selectOptions(
      screen.getByLabelText("Reusable place"),
      "place-a",
    );
    await user.click(screen.getByRole("button", { name: "Add address" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The address is invalid.",
    );
    expect(screen.getByLabelText("Address line 1")).toHaveValue("123 Draft St");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("mounts protected contact editor values only while explicitly expanded", async () => {
    const user = userEvent.setup();
    const secret = "+1 202 555 0199";
    execute.mockResolvedValue({
      ok: true,
      data: {
        contactEditProjection: {
          associationId: "association-a",
          displayValue: secret,
          label: "Private mobile",
          usageKind: "personal",
          sensitivity: "CONFIDENTIAL",
          isPrimary: true,
          version: 1,
          contactVersion: 1,
        },
      },
    });
    const { container } = render(
      <ContactEditForm associationId="association-a" />,
    );

    expect(
      screen.queryByRole("form", { name: "Edit protected contact" }),
    ).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(secret);

    const summary = screen.getByText("Edit contact", { exact: true });
    await user.click(summary);
    expect(
      await screen.findByRole("form", { name: "Edit protected contact" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Contact value")).toHaveValue(secret);

    await user.click(summary);
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Edit protected contact" }),
      ).not.toBeInTheDocument(),
    );
    expect(container.innerHTML).not.toContain(secret);

    await user.click(summary);
    expect(await screen.findByLabelText("Contact value")).toHaveValue(secret);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      associationId: "association-a",
    });
    expect(execute.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("shows accessible loading state and aborts an edit fetch on close", async () => {
    const user = userEvent.setup();
    execute.mockReturnValue(new Promise(() => undefined));
    const { container } = render(
      <ContactEditForm associationId="association-a" />,
    );
    const summary = screen.getByText("Edit contact", { exact: true });

    await user.click(summary);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading protected contact editor",
    );
    const signal = execute.mock.calls[0]?.[2]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    await user.click(summary);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
  });

  it("mounts complete address editor values only while explicitly expanded", async () => {
    const user = userEvent.setup();
    const secrets = [
      "817 Confidential Avenue",
      "Private Locality",
      "VA",
      "23220",
      "US",
    ];
    execute.mockResolvedValue({
      ok: true,
      data: {
        addressEditProjection: {
          associationId: "association-a",
          line1: secrets[0],
          locality: secrets[1],
          region: secrets[2],
          postalCode: secrets[3],
          countryCode: secrets[4],
          addressKind: "residence",
          place: { id: "place-a" },
          sensitivity: "RESTRICTED",
          isPrimary: true,
          version: 1,
          addressVersion: 1,
        },
      },
    });
    const { container } = render(
      <AddressEditForm
        associationId="association-a"
        places={[{ id: "place-a", name: "Private place" }]}
      />,
    );

    expect(
      screen.queryByRole("form", { name: "Edit address" }),
    ).not.toBeInTheDocument();
    for (const secret of secrets)
      expect(container.innerHTML).not.toContain(secret);

    const summary = screen.getByText("Edit address", { exact: true });
    await user.click(summary);
    expect(
      await screen.findByRole("form", { name: "Edit address" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Address line 1")).toHaveValue(secrets[0]);
    expect(screen.getByLabelText("Locality")).toHaveValue(secrets[1]);
    expect(screen.getByLabelText("Region")).toHaveValue(secrets[2]);
    expect(screen.getByLabelText("Postal code")).toHaveValue(secrets[3]);
    expect(screen.getByLabelText("Country code")).toHaveValue(secrets[4]);

    await user.click(summary);
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Edit address" }),
      ).not.toBeInTheDocument(),
    );
    for (const secret of secrets)
      expect(container.innerHTML).not.toContain(secret);

    await user.click(summary);
    expect(await screen.findByLabelText("Address line 1")).toHaveValue(
      secrets[0],
    );
  });

  it("shows a safe editor load failure and retries without retaining data", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce({
        ok: false,
        errors: [{ code: "NOT_FOUND", message: "Sensitive upstream text" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          contactEditProjection: {
            associationId: "association-a",
            displayValue: "retry-secret",
            label: null,
            usageKind: "personal",
            sensitivity: "INTERNAL",
            isPrimary: false,
            version: 2,
            contactVersion: 2,
          },
        },
      });
    const { container } = render(
      <ContactEditForm associationId="association-a" />,
    );

    await user.click(screen.getByText("Edit contact", { exact: true }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The protected contact editor could not be loaded.",
    );
    expect(alert).not.toHaveTextContent("Sensitive upstream text");
    expect(container.innerHTML).not.toContain("retry-secret");

    await user.click(
      screen.getByRole("button", { name: "Retry contact editor" }),
    );
    expect(await screen.findByLabelText("Contact value")).toHaveValue(
      "retry-secret",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("form", { name: "Edit protected contact" }),
    ).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("retry-secret");
  });

  it("renders keyboard-accessible place and archive controls", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        archivePersonContact: {
          contact: null,
          code: "ARCHIVED",
        },
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <>
        <PlaceForm />
        <ArchiveContactButton
          associationId="association-a"
          expectedVersion={1}
          expectedContactVersion={1}
        />
      </>,
    );
    expect(
      screen.getByRole("form", { name: "Add reusable place" }),
    ).toBeVisible();
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
    await user.click(screen.getByRole("button", { name: "Archive contact" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("keeps archive conflicts visible for assistive technology", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: {
        archivePersonContact: {
          contact: null,
          code: "CONFLICT",
          currentVersion: 2,
          issues: [],
        },
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ArchiveContactButton
        associationId="association-a"
        expectedVersion={1}
        expectedContactVersion={1}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive contact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This record changed in another request. Reload and try again.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
