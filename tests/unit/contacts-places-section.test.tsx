import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeServer = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: executeServer,
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("@/components/locations/location-forms", () => ({
  AddressEditForm: () => null,
  AddressForm: () => null,
  ArchiveAddressButton: () => null,
  ArchiveContactButton: () => null,
  ArchivePlaceButton: () => null,
  ContactEditForm: () => null,
  PhoneContactForm: () => null,
  PlaceEditForm: () => null,
  PlaceForm: () => null,
  ProtectedAddressPresentation: () => <p>Authorized address</p>,
  ProtectedContactPresentation: () => <p>Authorized contact</p>,
}));

import { ContactsPlacesSection } from "@/components/locations/contacts-places-section";

const personId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d0";
const pageInfo = { endCursor: null, hasNextPage: false };

describe("ContactsPlacesSection", () => {
  beforeEach(() => {
    executeServer.mockReset();
  });

  it("renders an address's stored effective period without false date precision", async () => {
    executeServer
      .mockResolvedValueOnce({
        person: { contacts: { nodes: [], pageInfo } },
      })
      .mockResolvedValueOnce({
        person: {
          addresses: {
            nodes: [
              {
                addressId: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d1",
                addressKind: "residence",
                addressVersion: 1,
                associationId: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d2",
                isPrimary: false,
                sensitivity: "INTERNAL",
                temporalPrecision: "year",
                validFrom: "2019-01-01T00:00:00.000Z",
                validUntil: "2021-12-31T23:59:59.999Z",
                version: 1,
              },
            ],
            pageInfo,
          },
        },
      });

    render(
      await ContactsPlacesSection({
        canCreateAddress: false,
        canCreateContact: false,
        canCreatePlace: false,
        canDeleteAddress: false,
        canDeleteContact: false,
        canDeletePlace: false,
        canReadPlaces: false,
        canUpdateAddress: false,
        canUpdateContact: false,
        canUpdatePlace: false,
        personId,
        search: {},
      }),
    );

    expect(screen.getByText("Residence")).toBeVisible();
    expect(screen.getByText("Effective period")).toBeVisible();
    expect(screen.getByText("2019 – 2021")).toBeVisible();
    expect(screen.queryByText(/Jan 1, 2019/)).not.toBeInTheDocument();
  });
});
