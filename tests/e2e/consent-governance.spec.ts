import { expect, test } from "@playwright/test";
import { ResearchFixture } from "../support/research-fixture";
import { fictionalProfile } from "../support/fixtures";

const fixture = new ResearchFixture();
test.beforeAll(async () => {
  await fixture.reset();
});
test.afterAll(async () => {
  await fixture.close();
});

test("consent panel checks explicit purpose without granting access for missing consent", async ({
  context,
  page,
}) => {
  const actor = await fixture.createActor();
  const created = await fixture.createPerson(actor, {
    displayName: fictionalProfile.displayName,
  });
  const id = created.body?.data?.createPerson?.person?.id;
  if (!id) throw new Error("Synthetic person creation failed");
  await context.addCookies(
    actor.jar
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
      }),
  );
  await page.goto(`/people/${id}?view=governance`);
  await expect(
    page.getByRole("button", { name: "Check coverage" }),
  ).toBeDisabled();
  await page.getByLabel("Research purpose").fill("fictional_archive_review");
  await page.getByRole("button", { name: "Check coverage" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "No consent covers this request",
  );
  await expect(
    page.getByText("Covered for this request", { exact: false }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/fictional_archive_review/);
});
