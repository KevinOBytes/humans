import { notFound } from "next/navigation";

import {
  AddressForm,
  AddressEditForm,
  ArchiveAddressButton,
  ArchiveContactButton,
  ArchivePlaceButton,
  ContactEditForm,
  PhoneContactForm,
  PlaceEditForm,
  PlaceForm,
  ProtectedAddressPresentation,
  ProtectedContactPresentation,
} from "@/components/locations/location-forms";
import { Badge } from "@/components/ui/badge";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  AddressDetailsFragmentDoc,
  ContactDetailsFragmentDoc,
  PageDetailsFragmentDoc,
  PersonAddressesDocument,
  PersonContactsDocument,
  PlaceOptionsDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { stringParam, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

const locationCursor = (search: SearchState, key: string) => {
  const value = stringParam(search, key, 2048);
  return value && /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u.test(value)
    ? value
    : undefined;
};

export async function ContactsPlacesSection(props: {
  canCreateAddress: boolean;
  canCreateContact: boolean;
  canCreatePlace: boolean;
  canDeleteAddress: boolean;
  canDeleteContact: boolean;
  canDeletePlace: boolean;
  canReadPlaces: boolean;
  canUpdateAddress: boolean;
  canUpdateContact: boolean;
  canUpdatePlace: boolean;
  personId: string;
  search: SearchState;
}) {
  const contactAfter = locationCursor(props.search, "contactAfter");
  const addressAfter = locationCursor(props.search, "addressAfter");
  const placeAfter = locationCursor(props.search, "placeAfter");
  const [contactData, addressData, placeData] = await Promise.all([
    executeServerGraphQL(PersonContactsDocument, {
      id: props.personId,
      first: 5,
      after: contactAfter,
    }),
    executeServerGraphQL(PersonAddressesDocument, {
      id: props.personId,
      first: 5,
      after: addressAfter,
    }),
    props.canReadPlaces
      ? executeServerGraphQL(PlaceOptionsDocument, {
          first: 10,
          after: placeAfter,
        })
      : Promise.resolve(null),
  ]);
  if (!contactData.person || !addressData.person) notFound();
  const contacts = contactData.person.contacts.nodes.map((node) =>
    readFragment(ContactDetailsFragmentDoc, node),
  );
  const addresses = addressData.person.addresses.nodes.map((node) =>
    readFragment(AddressDetailsFragmentDoc, node),
  );
  const contactPage = readFragment(
    PageDetailsFragmentDoc,
    contactData.person.contacts.pageInfo,
  );
  const addressPage = readFragment(
    PageDetailsFragmentDoc,
    addressData.person.addresses.pageInfo,
  );
  const placePage = readFragment(
    PageDetailsFragmentDoc,
    placeData?.places.pageInfo,
  );
  const places = placeData?.places.nodes ?? [];

  return (
    <div className="space-y-8">
      {props.canCreateContact ||
      props.canCreateAddress ||
      props.canCreatePlace ? (
        <section
          aria-labelledby="location-editor-heading"
          className="space-y-4"
        >
          <h2 id="location-editor-heading" className="text-lg font-semibold">
            Contacts & places editor
          </h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {props.canCreateContact ? (
              <PhoneContactForm personId={props.personId} />
            ) : null}
            {props.canCreateAddress ? (
              <AddressForm personId={props.personId} places={places} />
            ) : null}
            {props.canCreatePlace ? <PlaceForm /> : null}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="contacts-heading" className="space-y-4">
        <div>
          <h2 id="contacts-heading" className="text-lg font-semibold">
            Protected contacts
          </h2>
          <p className="text-muted-foreground text-sm">
            Values are returned only after server authorization.
          </p>
        </div>
        {contacts.length === 0 ? (
          <p className="border-border bg-card text-muted-foreground rounded-2xl border border-dashed p-8 text-center text-sm">
            No authorized contacts are available.
          </p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {contacts.map((contact) => (
              <li
                key={contact.associationId}
                className="border-border bg-card rounded-2xl border p-5"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <ProtectedContactPresentation
                    associationId={contact.associationId}
                    version={contact.contactVersion}
                  />
                  <div className="flex gap-2">
                    <Badge>{contact.sensitivity.toLowerCase()}</Badge>
                    {contact.isPrimary ? (
                      <Badge variant="selected">Primary</Badge>
                    ) : null}
                  </div>
                </div>
                {props.canUpdateContact ? (
                  <ContactEditForm associationId={contact.associationId} />
                ) : null}
                {props.canDeleteContact ? (
                  <div className="mt-4">
                    <ArchiveContactButton
                      associationId={contact.associationId}
                      expectedVersion={contact.version}
                      expectedContactVersion={contact.contactVersion}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pagination
          personId={props.personId}
          contactAfter={contactAfter}
          addressAfter={addressAfter}
          placeAfter={placeAfter}
          reset={Boolean(contactAfter)}
          next={contactPage?.hasNextPage ? contactPage.endCursor : null}
          kind="contact"
        />
      </section>
      <section aria-labelledby="addresses-heading" className="space-y-4">
        <h2 id="addresses-heading" className="text-lg font-semibold">
          Addresses & places
        </h2>
        {addresses.length === 0 ? (
          <p className="border-border bg-card text-muted-foreground rounded-2xl border border-dashed p-8 text-center text-sm">
            No authorized addresses are available.
          </p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {addresses.map((address) => (
              <li
                key={address.associationId}
                className="border-border bg-card rounded-2xl border p-5"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <ProtectedAddressPresentation
                    associationId={address.associationId}
                    version={address.addressVersion}
                  />
                  <div className="flex gap-2">
                    <Badge>{address.sensitivity.toLowerCase()}</Badge>
                    {address.isPrimary ? (
                      <Badge variant="selected">Primary</Badge>
                    ) : null}
                  </div>
                </div>
                {props.canUpdateAddress ? (
                  <AddressEditForm
                    associationId={address.associationId}
                    places={places}
                  />
                ) : null}
                {props.canDeleteAddress ? (
                  <div className="mt-4">
                    <ArchiveAddressButton
                      associationId={address.associationId}
                      expectedVersion={address.version}
                      expectedAddressVersion={address.addressVersion}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pagination
          personId={props.personId}
          contactAfter={contactAfter}
          addressAfter={addressAfter}
          placeAfter={placeAfter}
          reset={Boolean(addressAfter)}
          next={addressPage?.hasNextPage ? addressPage.endCursor : null}
          kind="address"
        />
      </section>
      {props.canReadPlaces && places.length ? (
        <section aria-labelledby="places-heading" className="space-y-4">
          <h2 id="places-heading" className="text-lg font-semibold">
            Reusable places
          </h2>
          <ul className="grid gap-4 lg:grid-cols-2">
            {places.map((place) => (
              <li
                key={place.id}
                className="border-border bg-card space-y-3 rounded-2xl border p-5"
              >
                <div>
                  <p className="font-semibold">{place.name}</p>
                  <p className="text-muted-foreground text-sm">
                    {[place.locality, place.region, place.countryCode]
                      .filter(Boolean)
                      .join(", ") || place.kind}
                  </p>
                </div>
                {props.canUpdatePlace ? (
                  <PlaceEditForm
                    id={place.id}
                    expectedVersion={place.version}
                    name={place.name}
                    kind={place.kind}
                    locality={place.locality}
                    region={place.region}
                    countryCode={place.countryCode}
                  />
                ) : null}
                {props.canDeletePlace ? (
                  <ArchivePlaceButton
                    id={place.id}
                    expectedVersion={place.version}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {placePage?.hasNextPage ? (
        <a
          className="text-primary text-sm font-semibold underline-offset-4 hover:underline"
          href={profilePageHref(props.personId, "contacts", {
            contactAfter,
            addressAfter,
            placeAfter: placePage.endCursor,
          })}
        >
          More reusable places
        </a>
      ) : null}
    </div>
  );
}

function Pagination(props: {
  personId: string;
  contactAfter?: string;
  addressAfter?: string;
  placeAfter?: string;
  reset: boolean;
  next?: string | null;
  kind: "contact" | "address";
}) {
  if (!props.reset && !props.next) return null;
  const values = {
    contactAfter: props.contactAfter,
    addressAfter: props.addressAfter,
    placeAfter: props.placeAfter,
  };
  return (
    <nav aria-label={`${props.kind} pages`} className="mt-4 flex gap-4 text-sm">
      {props.reset ? (
        <a
          className="text-primary font-semibold"
          href={profilePageHref(props.personId, "contacts", {
            ...values,
            [props.kind === "contact" ? "contactAfter" : "addressAfter"]: null,
          })}
        >
          First page
        </a>
      ) : null}
      {props.next ? (
        <a
          className="text-primary font-semibold"
          href={profilePageHref(props.personId, "contacts", {
            ...values,
            [props.kind === "contact" ? "contactAfter" : "addressAfter"]:
              props.next,
          })}
        >
          More {props.kind === "contact" ? "contacts" : "addresses"}
        </a>
      ) : null}
    </nav>
  );
}
