import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { eq } from "drizzle-orm";

import { personAddresses, personContactPoints } from "@/db/schema/evidence";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  AddressDetailsFragmentDoc,
  ContactDetailsFragmentDoc,
  CreatePersonAddressDocument,
  CreatePersonContactDocument,
  CreatePlaceDocument,
  PageDetailsFragmentDoc,
  PersonAddressesDocument,
  PersonContactsDocument,
  PlaceOptionsDocument,
  UpdatePersonAddressDocument,
  UpdatePersonContactDocument,
  type CreatePersonAddressMutation,
  type CreatePersonContactMutation,
  type CreatePlaceMutation,
  type PersonAddressesQuery,
  type PersonContactsQuery,
  type PlaceOptionsQuery,
  type UpdatePersonAddressMutation,
  type UpdatePersonContactMutation,
} from "@/graphql/generated/graphql";
import type { CookieJar } from "../support/auth";
import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
const baseURL = "http://127.0.0.1:3106";
type Actor = Awaited<ReturnType<ResearchFixture["createActor"]>>;

async function authenticate(context: BrowserContext, jar: CookieJar) {
  const cookies = jar
    .toString()
    .split(";")
    .flatMap((pair) => {
      const separator = pair.indexOf("=");
      return separator > 0
        ? [
            {
              name: pair.slice(0, separator).trim(),
              value: pair.slice(separator + 1).trim(),
              domain: "127.0.0.1",
              path: "/",
            },
          ]
        : [];
    });
  await context.addCookies(cookies);
}

function watchBrowser(page: Page) {
  const consoleMessages: string[] = [];
  const failures: string[] = [];
  page.on("console", (message) => {
    consoleMessages.push(message.text());
    if (message.type() === "error") {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    const body = request.postData() ?? "";
    if (
      failure === "net::ERR_ABORTED" &&
      (request.url().includes("_rsc=") ||
        request.url().includes("/__nextjs_font/") ||
        (request.url().endsWith("/api/graphql") &&
          (body.includes("ContactDisplayProjection") ||
            body.includes("AddressDisplayProjection") ||
            body.includes("ContactEditProjection") ||
            body.includes("AddressEditProjection"))))
    ) {
      return;
    }
    failures.push(
      `requestfailed: ${request.url()} ${failure ?? "unknown failure"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  return {
    consoleMessages,
    failures,
    expectClean() {
      expect(failures, failures.join("\n")).toEqual([]);
    },
  };
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    results.violations.map((item) => `${item.id}: ${item.help}`).join("\n"),
  ).toEqual([]);
}

async function expectBrowserSecretsAbsent(
  page: Page,
  browser: ReturnType<typeof watchBrowser>,
  secrets: readonly string[],
) {
  const state = await page.evaluate(() => ({
    href: window.location.href,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  const artifacts = JSON.stringify({
    console: browser.consoleMessages,
    failures: browser.failures,
    state,
  });
  const decodedUrl = decodeURIComponent(page.url());
  for (const secret of secrets) {
    expect(decodedUrl).not.toContain(secret);
    expect(artifacts).not.toContain(secret);
  }
}

async function expectSecretsAbsentFromControls(
  scope: Locator,
  secrets: readonly string[],
) {
  const controls = await scope
    .locator("input, textarea, select")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        markup: element.outerHTML,
        value:
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element.value
            : null,
      })),
    );
  const artifact = JSON.stringify(controls);
  for (const secret of secrets) expect(artifact).not.toContain(secret);
}

async function expectSecretsAbsentFromSerializedPayload(
  page: Page,
  secrets: readonly string[],
) {
  const payload = await page
    .locator('script:not([src]), input[type="hidden"]')
    .evaluateAll((elements) => elements.map((element) => element.outerHTML));
  const artifact = JSON.stringify(payload);
  for (const secret of secrets) expect(artifact).not.toContain(secret);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function ensureDetailsOpen(card: Locator, summary: string) {
  const details = card.locator("details").first();
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    await details.getByText(summary, { exact: true }).click();
  }
  await expect(details.locator("form")).toBeVisible();
}

async function createGeneratedContact(
  actor: Actor,
  personId: string,
  value: string,
  label: string,
) {
  const result = await fixture.execute<CreatePersonContactMutation>({
    jar: actor.jar,
    query: CreatePersonContactDocument,
    variables: {
      input: {
        personId,
        kind: "PHONE",
        value,
        label,
        usageKind: "personal",
        sensitivity: "INTERNAL",
        idempotencyKey: crypto.randomUUID(),
      },
    },
  });
  expect(result.body?.errors).toBeUndefined();
  return readFragment(
    ContactDetailsFragmentDoc,
    required(
      result.body?.data?.createPersonContact.contact,
      `Generated contact ${label} was not created`,
    ),
  );
}

async function createGeneratedAddress(
  actor: Actor,
  personId: string,
  line1: string,
) {
  const result = await fixture.execute<CreatePersonAddressMutation>({
    jar: actor.jar,
    query: CreatePersonAddressDocument,
    variables: {
      input: {
        personId,
        addressKind: "residence",
        line1,
        locality: "Richmond",
        region: "VA",
        postalCode: "23219",
        countryCode: "US",
        sensitivity: "INTERNAL",
        idempotencyKey: crypto.randomUUID(),
      },
    },
  });
  expect(result.body?.errors).toBeUndefined();
  return readFragment(
    AddressDetailsFragmentDoc,
    required(
      result.body?.data?.createPersonAddress.address,
      `Generated address ${line1} was not created`,
    ),
  );
}

async function createGeneratedPlace(actor: Actor, name: string) {
  const result = await fixture.execute<CreatePlaceMutation>({
    jar: actor.jar,
    query: CreatePlaceDocument,
    variables: {
      input: {
        name,
        kind: "locality",
        locality: name,
        region: "VA",
        countryCode: "US",
        sensitivity: "INTERNAL",
        idempotencyKey: crypto.randomUUID(),
      },
    },
  });
  expect(result.body?.errors).toBeUndefined();
  return required(
    result.body?.data?.createPlace.place,
    `Generated place ${name} was not created`,
  );
}

async function currentContact(
  actor: Actor,
  personId: string,
  displayValue: string,
) {
  const result = await fixture.execute<PersonContactsQuery>({
    jar: actor.jar,
    query: PersonContactsDocument,
    variables: { id: personId, first: 5 },
  });
  expect(result.body?.errors).toBeUndefined();
  const contacts =
    result.body?.data?.person?.contacts.nodes.map((node) =>
      readFragment(ContactDetailsFragmentDoc, node),
    ) ?? [];
  return required(
    contacts.find((contact) => contact.displayValue === displayValue),
    `Contact ${displayValue} was not returned by the generated query`,
  );
}

async function currentAddress(actor: Actor, personId: string, line1: string) {
  const result = await fixture.execute<PersonAddressesQuery>({
    jar: actor.jar,
    query: PersonAddressesDocument,
    variables: { id: personId, first: 5 },
  });
  expect(result.body?.errors).toBeUndefined();
  const addresses =
    result.body?.data?.person?.addresses.nodes.map((node) =>
      readFragment(AddressDetailsFragmentDoc, node),
    ) ?? [];
  return required(
    addresses.find((address) => address.line1 === line1),
    `Address ${line1} was not returned by the generated query`,
  );
}

test.beforeEach(async () => fixture.reset());
test.afterAll(async () => fixture.close());

test("owner completes phone, address, and place CRUD with visible conflict and precondition recovery", async ({
  context,
  page,
}) => {
  test.slow();
  const browser = watchBrowser(page);
  const editProjectionRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/graphql"))
      return;
    const body = request.postData() ?? "";
    if (
      body.includes("ContactEditProjection") ||
      body.includes("AddressEditProjection")
    ) {
      editProjectionRequests.push(body);
    }
  });
  const actor = await fixture.createActor();
  const person = await fixture.createPerson(actor, {
    displayName: "Location Browser Person",
  });
  const personId = required(
    person.body?.data?.createPerson?.person?.id,
    "Location browser person was not created",
  );
  await authenticate(context, actor.jar);
  await page.goto(`/people/${personId}?view=contacts`);
  await expect(
    page.getByRole("heading", { name: "Protected contacts" }),
  ).toBeVisible();

  const originalPhone = "+1 804 555 0101";
  const updatedPhone = "+1 804 555 0102";
  const externalPhone = "+1 804 555 0103";
  const rejectedPhone = "+1 804 555 0104";
  await page.getByLabel("Contact kind").selectOption("PHONE");
  await page.getByLabel("Phone number").fill(originalPhone);
  await page.getByLabel("Label").first().fill("Task 18 mobile phone");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByText(originalPhone)).toBeVisible();
  await page.reload();
  await expect(page.getByText(originalPhone)).toBeVisible();

  let contactCard = page
    .getByRole("region", { name: "Protected contacts" })
    .locator("li")
    .filter({ hasText: originalPhone });
  await expect(
    contactCard.getByRole("form", { name: "Edit protected contact" }),
  ).toHaveCount(0);
  await expectSecretsAbsentFromControls(contactCard, [originalPhone]);
  await expectSecretsAbsentFromSerializedPayload(page, [originalPhone]);
  expect(editProjectionRequests).toHaveLength(0);
  const contactSummary = contactCard.getByText("Edit contact", { exact: true });
  await contactSummary.focus();
  await page.keyboard.press("Enter");
  await expect(contactCard.locator("details form")).toBeVisible();
  let contactForm = contactCard.getByRole("form", {
    name: "Edit protected contact",
  });
  await expect(contactForm.getByLabel("Contact value")).toHaveValue(
    originalPhone,
  );
  expect(
    editProjectionRequests.filter((body) =>
      body.includes("ContactEditProjection"),
    ),
  ).toHaveLength(1);
  await contactSummary.click();
  await expect(
    contactCard.locator('form[aria-label="Edit protected contact"]'),
  ).toHaveCount(0);
  await expectSecretsAbsentFromControls(contactCard, [originalPhone]);
  await ensureDetailsOpen(contactCard, "Edit contact");
  contactForm = contactCard.getByRole("form", {
    name: "Edit protected contact",
  });
  await expect(contactForm.getByLabel("Contact value")).toHaveValue(
    originalPhone,
  );
  expect(
    editProjectionRequests.filter((body) =>
      body.includes("ContactEditProjection"),
    ),
  ).toHaveLength(2);
  await contactForm.getByLabel("Contact value").fill(updatedPhone);
  await contactForm.getByLabel("Label").fill("Updated mobile phone");
  await contactForm.getByRole("button", { name: "Save contact" }).click();
  await expect(page.getByText(updatedPhone)).toBeVisible();
  await expect(page.getByText(originalPhone)).toHaveCount(0);

  const contact = await currentContact(actor, personId, updatedPhone);
  contactCard = page
    .getByRole("region", { name: "Protected contacts" })
    .locator("li")
    .filter({ hasText: updatedPhone });
  await ensureDetailsOpen(contactCard, "Edit contact");
  contactForm = contactCard.getByRole("form", {
    name: "Edit protected contact",
  });
  await expect(contactForm.getByLabel("Contact value")).toHaveValue(
    updatedPhone,
  );
  const externalContact = await fixture.execute<UpdatePersonContactMutation>({
    jar: actor.jar,
    query: UpdatePersonContactDocument,
    variables: {
      input: {
        associationId: contact.associationId,
        expectedVersion: contact.version,
        expectedContactVersion: contact.contactVersion,
        value: externalPhone,
        idempotencyKey: crypto.randomUUID(),
      },
    },
  });
  expect(externalContact.body?.errors).toBeUndefined();
  expect(externalContact.body?.data?.updatePersonContact.contact).toBeTruthy();

  await contactForm.getByLabel("Contact value").fill(rejectedPhone);
  await contactForm.getByRole("button", { name: "Save contact" }).click();
  await expect(contactForm.getByRole("alert")).toContainText(
    "changed in another request",
  );
  await contactForm.getByRole("button", { name: "Cancel" }).click();
  await expectSecretsAbsentFromControls(contactCard, [
    updatedPhone,
    rejectedPhone,
  ]);
  await ensureDetailsOpen(contactCard, "Edit contact");
  contactForm = contactCard.getByRole("form", {
    name: "Edit protected contact",
  });
  await expect(contactForm.getByLabel("Contact value")).toHaveValue(
    externalPhone,
  );
  await contactForm.getByRole("button", { name: "Cancel" }).click();

  const placeName = "Richmond Browser Place";
  const updatedPlaceName = "Richmond Browser District";
  await page.getByLabel("Place name").first().fill(placeName);
  await page.getByLabel("Locality").last().fill("Richmond");
  await page.getByRole("button", { name: "Add place" }).click();
  await expect(
    page.getByRole("region", { name: "Reusable places" }).getByText(placeName),
  ).toBeVisible();

  let placeCard = page
    .getByRole("region", { name: "Reusable places" })
    .locator("li")
    .filter({ hasText: placeName });
  await ensureDetailsOpen(placeCard, "Edit place");
  const placeForm = placeCard.getByRole("form", { name: `Edit ${placeName}` });
  await placeForm.getByLabel("Place name").fill(updatedPlaceName);
  await placeForm.getByLabel("Locality").fill("Richmond City");
  await placeForm.getByRole("button", { name: "Save place" }).click();
  await expect(
    page
      .getByRole("region", { name: "Reusable places" })
      .getByText(updatedPlaceName),
  ).toBeVisible();

  const originalAddress = "123 Private Browser Road";
  const updatedAddress = "124 Private Browser Road";
  const externalAddress = "125 Private Browser Road";
  const rejectedAddress = "126 Private Browser Road";
  await page.getByLabel("Address line 1").first().fill(originalAddress);
  await page.getByLabel("Locality").first().fill("Richmond");
  await page
    .getByLabel("Reusable place")
    .first()
    .selectOption({ label: updatedPlaceName });
  await page.getByRole("button", { name: "Add address" }).click();
  await expect(page.getByText(originalAddress)).toBeVisible();
  await expect(page.getByText(`Place: ${updatedPlaceName}`)).toBeVisible();
  await page.reload();
  await expect(page.getByText(originalAddress)).toBeVisible();
  await expect(page.getByText(`Place: ${updatedPlaceName}`)).toBeVisible();

  let addressCard = page
    .getByRole("region", { name: "Addresses & places" })
    .locator("li")
    .filter({ hasText: originalAddress });
  await expect(
    addressCard.getByRole("form", { name: "Edit address" }),
  ).toHaveCount(0);
  await expectSecretsAbsentFromControls(addressCard, [originalAddress]);
  await expectSecretsAbsentFromSerializedPayload(page, [originalAddress]);
  expect(
    editProjectionRequests.filter((body) =>
      body.includes("AddressEditProjection"),
    ),
  ).toHaveLength(0);
  await ensureDetailsOpen(addressCard, "Edit address");
  let addressForm = addressCard.getByRole("form", { name: "Edit address" });
  await expect(addressForm.getByLabel("Address line 1")).toHaveValue(
    originalAddress,
  );
  expect(
    editProjectionRequests.filter((body) =>
      body.includes("AddressEditProjection"),
    ),
  ).toHaveLength(1);
  await addressCard.getByText("Edit address", { exact: true }).click();
  await expect(
    addressCard.locator('form[aria-label="Edit address"]'),
  ).toHaveCount(0);
  await expectSecretsAbsentFromControls(addressCard, [originalAddress]);
  await ensureDetailsOpen(addressCard, "Edit address");
  addressForm = addressCard.getByRole("form", { name: "Edit address" });
  await expect(addressForm.getByLabel("Address line 1")).toHaveValue(
    originalAddress,
  );
  expect(
    editProjectionRequests.filter((body) =>
      body.includes("AddressEditProjection"),
    ),
  ).toHaveLength(2);
  await addressForm.getByLabel("Address line 1").fill(updatedAddress);
  await addressForm.getByLabel("Postal code").fill("23220");
  await addressForm.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText(updatedAddress)).toBeVisible();
  await expect(page.getByText(originalAddress)).toHaveCount(0);

  const address = await currentAddress(actor, personId, updatedAddress);
  addressCard = page
    .getByRole("region", { name: "Addresses & places" })
    .locator("li")
    .filter({ hasText: updatedAddress });
  await ensureDetailsOpen(addressCard, "Edit address");
  addressForm = addressCard.getByRole("form", { name: "Edit address" });
  await expect(addressForm.getByLabel("Address line 1")).toHaveValue(
    updatedAddress,
  );
  const externalAddressResult =
    await fixture.execute<UpdatePersonAddressMutation>({
      jar: actor.jar,
      query: UpdatePersonAddressDocument,
      variables: {
        input: {
          associationId: address.associationId,
          expectedVersion: address.version,
          expectedAddressVersion: address.addressVersion,
          line1: externalAddress,
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
  expect(externalAddressResult.body?.errors).toBeUndefined();
  expect(
    externalAddressResult.body?.data?.updatePersonAddress.address,
  ).toBeTruthy();

  await addressForm.getByLabel("Address line 1").fill(rejectedAddress);
  await addressForm.getByRole("button", { name: "Save address" }).click();
  await expect(addressForm.getByRole("alert")).toContainText(
    "changed in another request",
  );
  await addressForm.getByRole("button", { name: "Cancel" }).click();
  await expectSecretsAbsentFromControls(addressCard, [
    updatedAddress,
    rejectedAddress,
  ]);
  await ensureDetailsOpen(addressCard, "Edit address");
  addressForm = addressCard.getByRole("form", { name: "Edit address" });
  await expect(addressForm.getByLabel("Address line 1")).toHaveValue(
    externalAddress,
  );
  await addressForm.getByRole("button", { name: "Cancel" }).click();

  await page.reload();
  await expect(page.getByText(externalPhone)).toBeVisible();
  await expect(page.getByText(externalAddress)).toBeVisible();
  placeCard = page
    .getByRole("region", { name: "Reusable places" })
    .locator("li")
    .filter({ hasText: updatedPlaceName });
  page.once("dialog", (dialog) => dialog.accept());
  await placeCard.getByRole("button", { name: "Archive place" }).click();
  await expect(placeCard.getByRole("alert")).toContainText(
    "The place is still referenced.",
  );
  await expect(
    placeCard.getByRole("button", { name: "Archive place" }),
  ).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("form", { name: "Add protected contact" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expectAxeClean(page);

  const protectedValues = [
    originalPhone,
    updatedPhone,
    externalPhone,
    rejectedPhone,
    originalAddress,
    updatedAddress,
    externalAddress,
    rejectedAddress,
  ];
  await expectBrowserSecretsAbsent(page, browser, protectedValues);

  const visibleContactCard = page
    .getByRole("region", { name: "Protected contacts" })
    .locator("li")
    .filter({ hasText: externalPhone });
  page.once("dialog", (dialog) => dialog.accept());
  await visibleContactCard
    .getByRole("button", { name: "Archive contact" })
    .click();
  await expect(page.getByText(externalPhone)).toHaveCount(0);

  const visibleAddressCard = page
    .getByRole("region", { name: "Addresses & places" })
    .locator("li")
    .filter({ hasText: externalAddress });
  page.once("dialog", (dialog) => dialog.accept());
  await visibleAddressCard
    .getByRole("button", { name: "Archive address" })
    .click();
  await expect(page.getByText(externalAddress)).toHaveCount(0);

  placeCard = page
    .getByRole("region", { name: "Reusable places" })
    .locator("li")
    .filter({ hasText: updatedPlaceName });
  page.once("dialog", (dialog) => dialog.accept());
  await placeCard.getByRole("button", { name: "Archive place" }).click();
  await expect(page.getByText(updatedPlaceName)).toHaveCount(0);
  browser.expectClean();
});

test("pagination and lower-privilege access use generated operations without leaking protected values", async ({
  browser: playwrightBrowser,
  context,
  page,
}) => {
  test.slow();
  const browser = watchBrowser(page);
  const actor = await fixture.createActor();
  const person = await fixture.createPerson(actor, {
    displayName: "Location Pagination Person",
  });
  const personId = required(
    person.body?.data?.createPerson?.person?.id,
    "Location pagination person was not created",
  );

  const phoneValues: string[] = [];
  const addressValues: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const value = `+1 804 555 ${String(2000 + index)}`;
    phoneValues.push(value);
    const contact = await createGeneratedContact(
      actor,
      personId,
      value,
      `Pagination phone ${String(index).padStart(2, "0")}`,
    );
    await fixture.database
      .update(personContactPoints)
      .set({ createdAt: new Date(`2026-08-03T12:00:0${index}.000Z`) })
      .where(eq(personContactPoints.id, contact.associationId));
    const line1 = `${200 + index} Pagination Browser Avenue`;
    addressValues.push(line1);
    const address = await createGeneratedAddress(actor, personId, line1);
    await fixture.database
      .update(personAddresses)
      .set({ createdAt: new Date(`2026-08-03T12:01:0${index}.000Z`) })
      .where(eq(personAddresses.id, address.associationId));
  }
  const placeNames: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const name = `Pagination Place ${String(index).padStart(2, "0")}`;
    placeNames.push(name);
    await createGeneratedPlace(actor, name);
  }

  const firstContacts = await fixture.execute<PersonContactsQuery>({
    jar: actor.jar,
    query: PersonContactsDocument,
    variables: { id: personId, first: 5 },
  });
  const contactPage = readFragment(
    PageDetailsFragmentDoc,
    required(
      firstContacts.body?.data?.person?.contacts.pageInfo,
      "Contact page info was not returned",
    ),
  );
  expect(contactPage.hasNextPage).toBe(true);
  const secondContacts = await fixture.execute<PersonContactsQuery>({
    jar: actor.jar,
    query: PersonContactsDocument,
    variables: { id: personId, first: 5, after: contactPage.endCursor },
  });
  expect(secondContacts.body?.errors).toBeUndefined();
  const expectedSecondContact = readFragment(
    ContactDetailsFragmentDoc,
    required(
      secondContacts.body?.data?.person?.contacts.nodes[0],
      "Second contact page was empty",
    ),
  ).displayValue;

  const firstAddresses = await fixture.execute<PersonAddressesQuery>({
    jar: actor.jar,
    query: PersonAddressesDocument,
    variables: { id: personId, first: 5 },
  });
  const addressPage = readFragment(
    PageDetailsFragmentDoc,
    required(
      firstAddresses.body?.data?.person?.addresses.pageInfo,
      "Address page info was not returned",
    ),
  );
  expect(addressPage.hasNextPage).toBe(true);
  const secondAddresses = await fixture.execute<PersonAddressesQuery>({
    jar: actor.jar,
    query: PersonAddressesDocument,
    variables: { id: personId, first: 5, after: addressPage.endCursor },
  });
  expect(secondAddresses.body?.errors).toBeUndefined();
  const expectedSecondAddress = required(
    readFragment(
      AddressDetailsFragmentDoc,
      required(
        secondAddresses.body?.data?.person?.addresses.nodes[0],
        "Second address page was empty",
      ),
    ).line1,
    "Second address page did not return a display line",
  );

  const firstPlaces = await fixture.execute<PlaceOptionsQuery>({
    jar: actor.jar,
    query: PlaceOptionsDocument,
    variables: { first: 10 },
  });
  const placePage = readFragment(
    PageDetailsFragmentDoc,
    required(
      firstPlaces.body?.data?.places.pageInfo,
      "Place page info was not returned",
    ),
  );
  expect(placePage.hasNextPage).toBe(true);
  const secondPlaces = await fixture.execute<PlaceOptionsQuery>({
    jar: actor.jar,
    query: PlaceOptionsDocument,
    variables: { first: 10, after: placePage.endCursor },
  });
  expect(secondPlaces.body?.errors).toBeUndefined();
  const expectedSecondPlace = required(
    secondPlaces.body?.data?.places.nodes[0]?.name,
    "Second place page was empty",
  );

  await authenticate(context, actor.jar);
  await page.goto(`/people/${personId}?view=contacts`);
  await expect(page.getByRole("link", { name: "More contacts" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "More addresses" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "More reusable places" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "More contacts" }).click();
  await expect(page).toHaveURL(/contactAfter=/u);
  await expect(page.getByText(expectedSecondContact)).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "contact pages" }),
  ).toContainText("First page");
  await page
    .getByRole("navigation", { name: "contact pages" })
    .getByRole("link", { name: "First page" })
    .click();
  await expect(page).not.toHaveURL(/contactAfter=/u);

  await page.getByRole("link", { name: "More addresses" }).click();
  await expect(page).toHaveURL(/addressAfter=/u);
  await expect(page.getByText(expectedSecondAddress)).toBeVisible();
  await page
    .getByRole("navigation", { name: "address pages" })
    .getByRole("link", { name: "First page" })
    .click();
  await expect(page).not.toHaveURL(/addressAfter=/u);

  await page.getByRole("link", { name: "More reusable places" }).click();
  await expect(page).toHaveURL(/placeAfter=/u);
  await expect(
    page
      .getByRole("region", { name: "Reusable places" })
      .locator("p.font-semibold")
      .filter({ hasText: expectedSecondPlace }),
  ).toBeVisible();

  const viewer = await fixture.createWorkspaceMember(actor, "viewer");
  const viewerContext = await playwrightBrowser.newContext({ baseURL });
  await authenticate(viewerContext, viewer.jar);
  const viewerPage = await viewerContext.newPage();
  const viewerBrowser = watchBrowser(viewerPage);
  await viewerPage.goto(`/people/${personId}?view=contacts`);
  await expect(
    viewerPage.getByRole("heading", { name: "Protected contacts" }),
  ).toBeVisible();
  await expect(viewerPage.getByText(phoneValues[5]!)).toBeVisible();
  await expect(
    viewerPage.getByRole("heading", { name: "Contacts & places editor" }),
  ).toHaveCount(0);
  await expect(
    viewerPage.getByText("Edit contact", { exact: true }),
  ).toHaveCount(0);
  await expect(
    viewerPage.getByText("Edit address", { exact: true }),
  ).toHaveCount(0);
  await expect(viewerPage.getByText("Edit place", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    viewerPage.getByRole("button", { name: /^Archive /u }),
  ).toHaveCount(0);

  const scopedKey = await fixture.provisionKey(actor, {
    person: ["read"],
    contactPoint: ["read"],
    address: ["read"],
    place: ["read"],
  });
  const keyRead = await fixture.execute<PersonContactsQuery>({
    apiKey: scopedKey.key,
    query: PersonContactsDocument,
    variables: { id: personId, first: 5 },
  });
  expect(keyRead.body?.errors).toBeUndefined();
  expect(keyRead.body?.data?.person?.contacts.nodes).toHaveLength(5);
  const keyDenied = await fixture.execute<CreatePersonContactMutation>({
    apiKey: scopedKey.key,
    query: CreatePersonContactDocument,
    variables: {
      input: {
        personId,
        kind: "PHONE",
        value: "+1 804 555 2999",
        usageKind: "personal",
        idempotencyKey: crypto.randomUUID(),
      },
    },
  });
  expectGraphQLError(keyDenied, "FORBIDDEN");

  const keyContext = await playwrightBrowser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-api-key": scopedKey.key },
  });
  const keyPage = await keyContext.newPage();
  const keyBrowser = watchBrowser(keyPage);
  await keyPage.goto(`/people/${personId}?view=contacts`);
  await expect(keyPage).toHaveURL(/\/sign-in\?/u);
  await expect(
    keyPage.getByRole("heading", { name: "Contacts & places editor" }),
  ).toHaveCount(0);
  await expect(keyPage.locator("body")).not.toContainText(scopedKey.key);

  await expectBrowserSecretsAbsent(page, browser, [
    ...phoneValues,
    ...addressValues,
    scopedKey.key,
  ]);
  await expectBrowserSecretsAbsent(viewerPage, viewerBrowser, [
    ...phoneValues,
    ...addressValues,
    scopedKey.key,
  ]);
  await expectBrowserSecretsAbsent(keyPage, keyBrowser, [
    ...phoneValues,
    ...addressValues,
    scopedKey.key,
  ]);
  browser.expectClean();
  viewerBrowser.expectClean();
  keyBrowser.expectClean();
  await keyContext.close();
  await viewerContext.close();
});
