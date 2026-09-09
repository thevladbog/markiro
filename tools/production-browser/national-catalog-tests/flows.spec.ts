import { expect, test } from "@playwright/test";
import {
  importApplySchema,
  importApplyRetrySchema,
  importItemsResponseSchema,
  importPrepareResponseSchema,
  importPrepareSchema,
  importResultSchema,
  importSelectionSchema,
  importSessionSchema,
  importStartSchema,
  chzLinkChangeSchema,
  chzLinkDetailSchema,
} from "../../../packages/platform-contracts/dist/index.js";
import {
  capabilitiesFixture,
  id,
  itemsFixture,
  linkFixture,
  photoFixtureBase64,
  previewFixture,
  productFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";
import ru from "../../../apps/admin/src/i18n/ru.json" with { type: "json" };
const origin = "http://127.0.0.1:43183";
const open = (route: string) =>
  `/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`;
const t = ru.pages.catalog.import;
const c = ru.pages.catalog.chz;

test("own partial feed, cross-page choices, link-only and draft, independent photo retry, saved and read-only routes", async ({
  page,
}) => {
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let readOnly = false;
  let exact = false;
  let session = { ...sessionFixture };
  let generation = 0;
  let detail = structuredClone(linkFixture);
  let preparation = structuredClone(previewFixture);
  let receipt = importResultSchema.parse({ operationId: id(20), state: "finished", items: [] });
  const selectionWrites: ReturnType<typeof importSelectionSchema.parse>[] = [];
  const prepareWrites: ReturnType<typeof importPrepareSchema.parse>[] = [];
  const applyWrites: ReturnType<typeof importApplySchema.parse>[] = [];
  const retryWrites: ReturnType<typeof importApplyRetrySchema.parse>[] = [];
  const starts: ReturnType<typeof importStartSchema.parse>[] = [];
  const removals: ReturnType<typeof chzLinkChangeSchema.parse>[] = [];
  const item = itemsFixture.items[0]!;
  const existing = {
    ...item,
    name: "Молоко фермерское пастеризованное 3,2 %",
    productId: productFixture.id,
    match: "existing",
  };
  const draft = {
    ...item,
    id: id(3),
    gtin14: "04601234567893",
    cardId: "draft-card",
    name: null,
    statusKeys: ["draft"],
  };
  await page.route(`${origin}/api/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.includes("/images/")) {
      await route.fulfill({
        contentType: "image/webp",
        body: Buffer.from(photoFixtureBase64, "base64"),
      });
      return;
    }
    let body: unknown;
    if (path === "/api/access/me")
      body = {
        roles: ["manager"],
        capabilities: readOnly ? ["operations.read"] : ["operations.read", "operations.write"],
      };
    else if (path === "/api/profile")
      body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
    else if (path === "/api/products")
      body = { items: [{ ...productFixture, name: existing.name, chz: detail.summary }] };
    else if (["/api/counterparties", "/api/pickup-orders"].includes(path)) body = { items: [] };
    else if (path === "/api/national-catalog/capabilities") body = capabilitiesFixture;
    else if (path.endsWith("/national-catalog/link/refresh")) {
      expect(method).toBe("POST");
      detail = chzLinkDetailSchema.parse({
        ...detail,
        summary: {
          ...detail.summary,
          lastOutcome: "error",
          lastErrorCode: "request_timeout",
          lastAttemptAt: "2026-09-09T01:00:00.000Z",
        },
      });
      body = detail.summary;
    } else if (path.endsWith("/national-catalog/link")) {
      if (method === "DELETE") {
        removals.push(chzLinkChangeSchema.parse(route.request().postDataJSON()));
        detail = chzLinkDetailSchema.parse({
          link: null,
          summary: {
            ...detail.summary,
            linkId: null,
            revision: null,
            statusKeys: [],
            rawStatus: null,
            rawDetailedStatuses: [],
            lastSuccessAt: null,
            lastAttemptAt: null,
            lastOutcome: "never",
            lastErrorCode: null,
            hasChanges: false,
          },
        });
        body = detail.summary;
      } else body = detail;
    } else if (path === "/api/national-catalog/import-sessions" && method === "POST") {
      const input = importStartSchema.parse(route.request().postDataJSON());
      starts.push(input);
      exact = input.mode === "gtins";
      session = importSessionSchema.parse({
        ...sessionFixture,
        mode: input.mode,
        complete: exact,
        state: exact ? "ready" : "partial",
      });
      body = session;
    } else if (path.endsWith("/selection")) {
      const input = importSelectionSchema.parse(route.request().postDataJSON());
      selectionWrites.push(input);
      expect(input.expectedRevision).toBe(session.revision);
      session = {
        ...session,
        revision: session.revision + 1,
        selectedItemIds: input.itemIds,
        selected: input.itemIds.length,
      };
      body = session;
    } else if (path.endsWith("/items")) {
      const second = url.searchParams.get("cursor") === "page2";
      body = importItemsResponseSchema.parse({
        items: exact
          ? [
              second
                ? { ...existing, id: id(41), match: "linked" }
                : { ...existing, id: id(40), cardId: "other-card" },
            ]
          : [second ? draft : existing],
        nextCursor: second ? null : "page2",
      });
    } else if (path.endsWith("/previews")) {
      const input = importPrepareSchema.parse(route.request().postDataJSON());
      prepareWrites.push(input);
      generation++;
      const manual = input.manualNames.find((value) => value.itemId === draft.id)?.name;
      const category = input.categoryChoices.find((value) => value.itemId === draft.id)?.optionId;
      preparation = importPrepareResponseSchema.parse({
        preparation: {
          ...previewFixture.preparation,
          id: id(100 + generation),
          requestId: input.requestId,
          total: input.itemIds.length,
          completed: input.itemIds.length,
        },
        items: input.itemIds.map((itemId, index) => {
          const isDraft = itemId === draft.id;
          return {
            ...previewFixture.items[0],
            id: id(200 + generation * 10 + index),
            itemId,
            identity: {
              gtin14: isDraft ? draft.gtin14 : existing.gtin14,
              cardId: isDraft ? draft.cardId : existing.cardId,
              name: isDraft ? null : existing.name,
            },
            productId: isDraft ? null : productFixture.id,
            fields: [
              {
                ...previewFixture.items[0]!.fields[0],
                id: id(300 + index),
                before: isDraft ? null : "Молоко",
                after: isDraft ? (manual ?? "Новый товар") : existing.name,
                source: isDraft && manual ? "manual" : "national_catalog",
              },
              ...(isDraft && category
                ? [
                    {
                      ...previewFixture.items[0]!.fields[0],
                      id: id(600),
                      label: "Категория",
                      before: null,
                      after: "Молочная продукция",
                    },
                  ]
                : []),
            ],
            categoryOptions: isDraft
              ? [{ optionId: id(500), label: "Молочная продукция", selected: !!category }]
              : [],
            photos: isDraft
              ? [
                  {
                    candidateId: id(30),
                    state: "ready",
                    previewPath: null,
                    primary: true,
                    selectedByDefault: false,
                    reason: null,
                  },
                  {
                    candidateId: id(31),
                    state: "ready",
                    previewPath: null,
                    primary: false,
                    selectedByDefault: false,
                    reason: null,
                  },
                ]
              : [],
          };
        }),
      });
      body = preparation;
    } else if (path.includes("/preparations/")) body = preparation;
    else if (path.endsWith("/applies")) {
      const input = importApplySchema.parse(route.request().postDataJSON());
      applyWrites.push(input);
      receipt = importResultSchema.parse({
        operationId: id(20),
        state: "finished",
        items: input.decisions.map((decision, index) => ({
          previewId: decision.previewId,
          productId: index === 0 ? productFixture.id : id(98),
          product: "applied",
          image: index === 0 ? "unchanged" : "failed",
          productReason: null,
          imageReason: index === 0 ? null : "download_failed",
          reason: index === 0 ? null : "download_failed",
        })),
      });
      body = receipt;
    } else if (path.endsWith("/retries") && path.includes("/applies/")) {
      const input = importApplyRetrySchema.parse(route.request().postDataJSON());
      retryWrites.push(input);
      receipt = importResultSchema.parse({
        ...receipt,
        items: receipt.items.map((row) =>
          input.previewIds.includes(row.previewId)
            ? {
                ...row,
                image: "applied",
                imageReason: null,
                reason: null,
              }
            : row,
        ),
      });
      body = receipt;
    } else if (path.endsWith("/cancel")) {
      session = { ...session, state: "cancelled" };
      receipt = { ...receipt, state: "cancelled" };
      body = session;
    } else if (path.includes("/applies/")) body = receipt;
    else if (path.includes("/import-sessions/")) body = session;
    else {
      unexpected.push(`${method} ${path}`);
      await route.abort();
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(open("/catalog/import"));
  await page.getByRole("button", { name: t.loadOwn, exact: true }).click();
  await expect(page.getByText(t.partialList)).toBeVisible();
  await page.getByRole("checkbox", { name: /04006381333931/ }).click();
  await page.getByRole("button", { name: t.nextPage, exact: true }).click();
  await page.getByRole("checkbox", { name: /04601234567893/ }).click();
  expect(selectionWrites.map((value) => value.itemIds)).toEqual([[id(2)], [id(2), id(3)]]);
  await page.getByRole("button", { name: t.previousPage, exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /04006381333931/ })).toBeChecked();
  await page.getByRole("button", { name: t.compare, exact: true }).click();
  await expect(page.locator("fieldset")).toHaveCount(2);
  const newProduct = page.locator("fieldset").nth(1);
  await newProduct
    .getByLabel(t.manualName, { exact: true })
    .fill("Йогурт фермерский натуральный 3,5 %, 500 г");
  await expect(page.getByRole("button", { name: t.apply, exact: true })).toBeDisabled();
  await newProduct.getByLabel(t.initialCategory, { exact: true }).selectOption(id(500));
  await expect(page.getByRole("button", { name: t.apply, exact: true })).toBeEnabled();
  expect(prepareWrites.at(-1)).toMatchObject({
    itemIds: [id(2), id(3)],
    manualNames: [{ itemId: id(3), name: "Йогурт фермерский натуральный 3,5 %, 500 г" }],
    categoryChoices: [{ itemId: id(3), optionId: id(500) }],
  });
  await page
    .locator("fieldset")
    .first()
    .getByRole("button", { name: t.linkOnly, exact: true })
    .click();
  await newProduct.getByRole("button", { name: t.viewPhoto, exact: true }).nth(1).click();
  await expect(newProduct.getByRole("img")).toHaveJSProperty("naturalWidth", 120);
  const choose = newProduct.getByRole("button", { name: t.choosePhoto, exact: true }).nth(1);
  await choose.focus();
  await page.keyboard.press("Enter");
  await expect(choose).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: t.apply, exact: true }).click();
  await expect(page.getByText(t.imageFailed)).toBeVisible();
  expect(applyWrites).toHaveLength(1);
  expect(applyWrites[0]?.decisions).toMatchObject([
    { acceptedEntryIds: [], linkAction: "attach", photo: { kind: "keep" } },
    { acceptedEntryIds: [id(301), id(600)], photo: { kind: "candidate", candidateId: id(31) } },
  ]);
  const firstReceipt = structuredClone(receipt.items[0]);
  const resultRoute = `/catalog/import?sessionId=${id(1)}&operationId=${id(20)}`;
  // Explicit saved-route reopen and reload; MemoryRouter does not update the address bar.
  await page.goto(open(resultRoute));
  await page.reload();
  await expect(page.getByText(t.imageFailed)).toBeVisible();
  expect(applyWrites).toHaveLength(1);
  await page.getByRole("button", { name: t.retryImage, exact: true }).click();
  await expect(page.getByText(t.imageFailed)).toHaveCount(0);
  expect(retryWrites).toEqual([{ previewIds: [receipt.items[1]?.previewId] }]);
  expect(receipt.items[0]).toEqual(firstReceipt);
  expect(receipt.items.map((value) => value.product)).toEqual(["applied", "applied"]);
  readOnly = true;
  await page.goto(open(resultRoute));
  await expect(page.getByRole("link", { name: t.openProduct })).toHaveCount(2);
  await expect(page.getByRole("button", { name: t.retryImage })).toHaveCount(0);
  await page.goto(
    open(`/catalog/import?sessionId=${id(1)}&preparationId=${preparation.preparation.id}`),
  );
  await expect(page.locator("fieldset")).toHaveCount(2);
  await expect(page.getByLabel(t.manualName, { exact: true }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: t.apply })).toHaveCount(0);
  await page.goto(open(`/catalog/${productFixture.id}/chz`));
  await expect(page.getByText("card-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: c.remove, exact: true })).toHaveCount(0);
  readOnly = false;
  await page.goto(open(`/catalog/${productFixture.id}/chz`));
  const panel = page.getByRole("dialog");
  await panel.getByRole("button", { name: c.refresh, exact: true }).click();
  await expect(panel.getByText(c.checkError)).toBeVisible();
  await expect(panel.getByText(t.statuses.published, { exact: true }).first()).toBeVisible();
  await panel.locator("summary").click();
  await expect(panel.getByText(c.errors.request_timeout)).toBeVisible();
  await expect(panel.locator('time[datetime="2026-09-09T00:00:00.000Z"]')).toHaveCount(1);
  await panel.getByRole("button", { name: c.compare, exact: true }).click();
  await page.getByRole("button", { name: c.exactSelect, exact: true }).click();
  expect(starts.at(-1)).toEqual({ mode: "gtins", text: "04006381333931" });
  expect(selectionWrites.at(-1)?.itemIds).toEqual([id(41)]);
  await page.getByRole("button", { name: t.compare, exact: true }).click();
  await expect(page.locator("fieldset")).toHaveCount(1);
  expect(prepareWrites.at(-1)?.itemIds).toEqual([id(41)]);
  await page.getByRole("button", { name: ru.common.close, exact: true }).click();
  await expect(panel.getByText("card-1", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: c.remove, exact: true }).click();
  await page.getByRole("button", { name: c.removeConfirm, exact: true }).click();
  await expect(page.getByText(c.unlinked, { exact: true }).last()).toBeVisible();
  expect(removals).toEqual([{ action: "remove", expectedRevision: 4 }]);
  receipt = { ...receipt, state: "running" };
  await page.goto(open(resultRoute));
  await page.getByRole("button", { name: t.cancel, exact: true }).click();
  await expect(page.getByText(t.operationStates.cancelled, { exact: true })).toBeVisible();
  expect(receipt.items[0]).toEqual(firstReceipt);
  expect(applyWrites).toHaveLength(1);
  expect(retryWrites).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
