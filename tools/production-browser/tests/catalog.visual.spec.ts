import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * MKR-INS-10 (printed catalog instruction) screenshot targets. Mock shapes
 * follow the real response contracts in
 * apps/admin/src/pages/{catalog,counterparties,integrations}/api.ts. These
 * clients do not re-parse responses with `zod`, so a wrong shape renders as
 * a blank cell instead of throwing -- every fixture below therefore mirrors
 * its DTO field for field.
 *
 * Same synthetic "Марка Ко" organisation and manager (Игорь Волков) as the
 * shift and inventory evidence suites, so the printed series reads as one
 * cabinet.
 */
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-10/ru",
);
function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, `${name}.png`);
}

/**
 * Product panels (`ProductPanelRoute`) slide in over the list, and an
 * assertion on their content passes while the transition is still running --
 * without this wait the capture catches a half-open panel with the list
 * bleeding through. Infinite animations (spinners) are excluded: they never
 * finish by definition.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => (animation.effect?.getTiming().iterations ?? 1) !== Infinity)
      .every((animation) => animation.playState === "finished"),
  );
  // The caret blinks forever and overlay scrollbars fade on their own
  // schedule, so whether either is drawn depends purely on when the capture
  // lands. Both carry no information for this document.
  await page.addStyleTag({
    content:
      "* { caret-color: transparent !important; }\n" +
      "::-webkit-scrollbar { display: none !important; }",
  });
}

/**
 * `AppShell` pins the shell to `height: 100vh; overflow: hidden` and scrolls
 * internally, so a fixed 1280x800 screenshot silently crops anything below
 * the fold instead of failing. Grow the viewport by the page's actual
 * overflow before capturing; a no-op when everything already fits.
 */
async function screenshotFullMain(page: Page, path: string): Promise<void> {
  await settle(page);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")].reduce(
      (worst, element) => {
        const style = getComputedStyle(element);
        const scrollable = (value: string) => value === "auto" || value === "scroll";
        return {
          y: scrollable(style.overflowY)
            ? Math.max(worst.y, element.scrollHeight - element.clientHeight)
            : worst.y,
          x: scrollable(style.overflowX)
            ? Math.max(worst.x, element.scrollWidth - element.clientWidth)
            : worst.x,
        };
      },
      { x: 0, y: 0 },
    ),
  );
  if (overflow.x > 0 || overflow.y > 0) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.setViewportSize({
      width: viewport.width + overflow.x,
      height: viewport.height + overflow.y,
    });
    await settle(page);
  }
  await page.screenshot({ path, scale: "css", fullPage: true });
}

/**
 * The card is one tall side panel, so a full-page capture of the photo
 * section and of the defaults section would be the same picture twice. Each
 * section is its own `<section aria-labelledby="product-form-*">`, so the
 * steps that discuss one section get that section alone.
 */
async function screenshotSection(page: Page, sectionId: string, path: string): Promise<void> {
  await settle(page);
  await page.locator(`section[aria-labelledby="${sectionId}"]`).screenshot({ path, scale: "css" });
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const PROFILE = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
/**
 * The 1С plaque is gated on `integrations.read` and unlinking on
 * `integrations.write`, neither of which the manager role carries, so the
 * catalog evidence runs under an admin -- and the document says which rights
 * each step needs instead of pretending a manager can do all of it.
 */
const ACCESS = {
  roles: ["admin"],
  capabilities: [
    "operations.read",
    "operations.write",
    "integrations.read",
    "integrations.write",
    "billing.read",
  ],
};
const PICKUP_ORDERS_EMPTY = { items: [] };

const PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_PRODUCT_ID = "20000000-0000-4000-8000-000000000002";
const ARCHIVED_PRODUCT_ID = "20000000-0000-4000-8000-000000000003";
const COUNTERPARTY_ID = "70000000-0000-4000-8000-000000000001";

const PRODUCT = {
  id: PRODUCT_ID,
  gtin14: "04600000000008",
  name: "Сироп «Клюква», 0.5 л",
  productGroup: "Соковая продукция и безалкогольные напитки",
  chzProductGroupCode: 23,
  boxCapacity: 12,
  palletCapacity: 48,
  unitPrice: "189.00",
  printName: "Сироп Клюква 0.5",
  egaisCode: null,
  shelfLifeDays: 365,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: COUNTERPARTY_ID,
  createdAt: "2026-08-03T07:12:00.000Z",
  image: {
    checksum: "a".repeat(64),
    contentType: "image/webp",
    byteSize: 474,
    width: 16,
    height: 16,
  },
};
/**
 * A draft is a card MISSING the three fields that make it usable, so this
 * fixture clears them: the server computes `status` from
 * chzProductGroupCode/boxCapacity/palletCapacity, and a "draft" carrying all
 * three would be a state the cabinet never produces.
 */
const DRAFT_PRODUCT = {
  ...PRODUCT,
  id: DRAFT_PRODUCT_ID,
  gtin14: "04600000000015",
  name: "Сироп «Малина», 0.5 л",
  printName: "Сироп Малина 0.5",
  productGroup: null,
  chzProductGroupCode: null,
  boxCapacity: null,
  palletCapacity: null,
  unitPrice: null,
  shelfLifeDays: null,
  status: "draft",
  defaultCounterpartyId: null,
  image: null,
  createdAt: "2026-08-24T09:40:00.000Z",
};
const ARCHIVED_PRODUCT = {
  ...PRODUCT,
  id: ARCHIVED_PRODUCT_ID,
  gtin14: "04600000000022",
  name: "Сироп «Груша», 0.5 л",
  printName: "Сироп Груша 0.5",
  archived: true,
  defaultCounterpartyId: null,
  image: null,
  createdAt: "2026-05-18T11:05:00.000Z",
};

const COUNTERPARTY = {
  id: COUNTERPARTY_ID,
  name: "ООО «Ягодный дом»",
  gln: "4600000000001",
  inn: "7701234567",
  gs1Prefixes: ["460000"],
  notes: null,
  createdAt: "2026-07-01T08:00:00.000Z",
};
const PRODUCT_GROUPS = {
  items: [
    // Codes, aliases and names copied from the real seed
    // (packages/db/migrations/0099_chz_product_groups.sql) so the card and
    // the list agree with the catalogue a cabinet actually shows.
    { code: 23, alias: "softdrinks", name: "Соковая продукция и безалкогольные напитки" },
    { code: 13, alias: "water", name: "Упакованная вода" },
  ],
};
const CANDIDATES = {
  candidates: [
    {
      id: "c0000000-0000-4000-8000-000000000001",
      externalRef: "1c-0001",
      name: "Сироп «Вишня», 0.5 л",
      article: "SYR-CHR-05",
      unit: "шт",
      gtin: null,
      price: "205.00",
      priceType: "Розничная",
    },
    {
      id: "c0000000-0000-4000-8000-000000000002",
      externalRef: "1c-0002",
      name: "Сироп «Смородина», 0.5 л",
      article: "SYR-BLC-05",
      unit: "шт",
      gtin: null,
      price: "199.00",
      priceType: "Розничная",
    },
  ],
};
/**
 * A 120x120 WebP served for the product's image endpoint. Copied from
 * `apps/admin/test/national-catalog-fixtures.ts` rather than imported: that
 * module also pulls zod schemas from `@markiro/platform-contracts`, whose
 * built output this `--ignore-workspace` project resolves separately, and
 * this suite needs nothing from it but the bytes.
 */
const PRODUCT_IMAGE_BASE64 =
  "UklGRtABAABXRUJQVlA4IMQBAACwDgCdASp4AHgAPm00mEckIyKhKhWZGIANiWcA1OTATP+ynyjg57xAWK6mrhcvK4uEOEJOeKcf68ccMaTvrvXuFK8HkwkvF9qI/5W9qQ4ziV0yXsdpwU1bSgSqpLThYrtGfCUP38EDWeNBmTKxkvTNs3vUY9k5uqRyhulTZIAA/vo8Ly0lehcyDUOF0mwMucDqrz8TB1AUgnCSKYyf6i0GiEISFpEah96xvzuKxlWPHGXpVerx9h049ZZZUPNCdLytMBUXTtqsdj3X2LIBRkGcpqUkQy8BR4bu61Q74IBFl2Q5EXUhYbNGgbBgkEzFdc/LtBHm+BUm7Io8DqEleiFF9NXysIZN3jIIrTXSlzWFjlq+s6fH/N/pvNfIPpzCGS/Vj1Mv0cYT+9r/c6bIj3/5SCP7A/cK/TnU34NI4hdSeP2/BIZUH6C+4mX08y/yPUxTadyZ/XrAVm1T4991HgkUgl1U6XqYApaTXt0I36QmwJL+RJATyfb6HuWUYvrnZu8sxmNLJAMk7H5haduYgcEiP3XoD0mwifGsmMRplQEM0d1W9m/o/xhYy1r6K++Nl3ErUqob73rOCKf7gdQ+afmAAAAAAA==";
const PRODUCT_IMAGE_BYTES = Buffer.from(PRODUCT_IMAGE_BASE64, "base64");

type Scenario = "list" | "listWithPlaque" | "productActive" | "productDraft" | "productNew";

/**
 * Every scenario shares the shell fetches (profile, access, pending
 * pickup-order count, billing badge) and adds only what its screen needs.
 * Anything not matched aborts and is recorded in `unexpected`, so a screen
 * that quietly needs one more endpoint fails the test instead of rendering a
 * false-positive empty state.
 */
async function installApi(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/profile") return json(route, PROFILE);
    if (path === "/api/access/me") return json(route, ACCESS);
    if (path === "/api/pickup-orders") return json(route, PICKUP_ORDERS_EMPTY);
    if (path === "/api/billing/attention") return json(route, { count: 0 });

    if (path === "/api/products") {
      // The catalog filters on the server (`buildListPath`), so the mock has
      // to honour the query it is given: answering with the full list for a
      // narrowed filter would produce a screenshot the cabinet never shows.
      const status = url.searchParams.get("status");
      const archived = url.searchParams.get("archived");
      if (status === "draft") return json(route, { items: [DRAFT_PRODUCT] });
      if (status === "active") return json(route, { items: [PRODUCT] });
      if (archived === "true") return json(route, { items: [ARCHIVED_PRODUCT] });
      return json(route, { items: [PRODUCT, DRAFT_PRODUCT, ARCHIVED_PRODUCT] });
    }
    if (path === "/api/counterparties") return json(route, { items: [COUNTERPARTY] });
    if (path === "/api/chz-product-groups") return json(route, PRODUCT_GROUPS);
    if (path === "/api/integrations/commerceml/candidates") {
      return json(route, scenario === "listWithPlaque" ? CANDIDATES : { candidates: [] });
    }
    if (path === `/api/products/${PRODUCT_ID}`) return json(route, PRODUCT);
    if (path === `/api/products/${DRAFT_PRODUCT_ID}`) return json(route, DRAFT_PRODUCT);
    if (path === `/api/products/${ARCHIVED_PRODUCT_ID}`) return json(route, ARCHIVED_PRODUCT);
    if (path.startsWith(`/api/products/${PRODUCT_ID}/image/`)) {
      return route.fulfill({ status: 200, contentType: "image/webp", body: PRODUCT_IMAGE_BYTES });
    }
    if (path === "/api/products/gtin-check") {
      return json(route, {
        gtin14: "04600000000015",
        owner: "counterparty",
        counterpartyId: COUNTERPARTY_ID,
        counterpartyName: COUNTERPARTY.name,
      });
    }

    unexpected.push(`${route.request().method()} ${path}${url.search}`);
    return route.abort();
  });
  return unexpected;
}

async function openHarness(page: Page, route: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/test/browser/production.html?route=${encodeURIComponent(route)}`);
}

test("catalog list shows all three Markiro statuses", async ({ page }) => {
  const unexpected = await installApi(page, "list");
  await openHarness(page, "/catalog");
  await expect(page.getByRole("heading", { name: "Каталог продукции" })).toBeVisible();
  await expect(page.getByText("Активен", { exact: true })).toBeVisible();
  await expect(page.getByText("Черновик", { exact: true })).toBeVisible();
  await expect(page.getByText("Не используется", { exact: true })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("catalog-list"));
  expect(unexpected).toEqual([]);
});

test("catalog filters narrow the list to drafts", async ({ page }) => {
  const unexpected = await installApi(page, "list");
  await openHarness(page, "/catalog");
  await expect(page.getByRole("heading", { name: "Каталог продукции" })).toBeVisible();
  await page.getByRole("combobox", { name: "Статус", exact: true }).click();
  await page.getByRole("option", { name: "Черновик", exact: true }).click();
  await expect(page.getByText("Сироп «Клюква», 0.5 л")).toBeHidden();
  await expect(page.getByText("Сироп «Малина», 0.5 л")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("catalog-filters"));
  expect(unexpected).toEqual([]);
});

test("unmatched 1C products surface as a plaque above the list", async ({ page }) => {
  const unexpected = await installApi(page, "listWithPlaque");
  await openHarness(page, "/catalog");
  await expect(page.getByRole("link", { name: "Перейти в очередь" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("candidates-plaque"));
  expect(unexpected).toEqual([]);
});

test("deleting a product asks for confirmation", async ({ page }) => {
  const unexpected = await installApi(page, "list");
  await openHarness(page, "/catalog");
  await page.getByRole("button", { name: "Удалить" }).first().click();
  await expect(page.getByText("Удалить продукт?")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("catalog-delete"));
  expect(unexpected).toEqual([]);
});

test("a new product card opens on the basics", async ({ page }) => {
  const unexpected = await installApi(page, "productNew");
  await openHarness(page, "/catalog/new");
  await expect(page.getByText("Новый продукт")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Основное" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("product-new"));
  expect(unexpected).toEqual([]);
});

/**
 * The owner lookup only fires for a checksum-valid GTIN (`isValidGtin`
 * guards the effect in ProductForm), which is why every fixture GTIN in this
 * suite carries a real GS1 check digit -- a made-up number would silently
 * skip the request and produce a frame without the hint.
 */
test("a GTIN owned by a counterparty is named on the card", async ({ page }) => {
  const unexpected = await installApi(page, "productNew");
  await openHarness(page, "/catalog/new");
  await page.getByLabel("ГТИН").fill("04600000000015");
  await expect(page.getByText("Владелец ГТИН — ООО «Ягодный дом»")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подставить контрагента" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("product-gtin-owner"));
  expect(unexpected).toEqual([]);
});

test("a draft card explains what is missing", async ({ page }) => {
  const unexpected = await installApi(page, "productDraft");
  await openHarness(page, `/catalog/${DRAFT_PRODUCT_ID}/edit`);
  await expect(
    page.getByText("Черновик — заполните группу и вместимости, чтобы запускать смены"),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath("product-draft-banner"));
  expect(unexpected).toEqual([]);
});

test("an active card carries the group and both capacities", async ({ page }) => {
  const unexpected = await installApi(page, "productActive");
  await openHarness(page, `/catalog/${PRODUCT_ID}/edit`);
  await expect(page.getByRole("heading", { name: "Агрегация и цена" })).toBeVisible();
  await expect(page.getByLabel("Вместимость короба, шт")).toHaveValue("12");
  await expect(page.getByLabel("Вместимость поддона, шт")).toHaveValue("48");
  await screenshotFullMain(page, screenshotPath("product-active"));
  expect(unexpected).toEqual([]);
});

test("the photo section shows the stored image", async ({ page }) => {
  const unexpected = await installApi(page, "productActive");
  await openHarness(page, `/catalog/${PRODUCT_ID}/edit`);
  await expect(page.getByRole("heading", { name: "Фотография" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Удалить фотографию" })).toBeVisible();
  await screenshotSection(page, "product-form-image", screenshotPath("product-image"));
  expect(unexpected).toEqual([]);
});

test("default values name the counterparty", async ({ page }) => {
  const unexpected = await installApi(page, "productActive");
  await openHarness(page, `/catalog/${PRODUCT_ID}/edit`);
  await expect(page.getByRole("heading", { name: "Значения по умолчанию" })).toBeVisible();
  await screenshotSection(page, "product-form-defaults", screenshotPath("product-defaults"));
  expect(unexpected).toEqual([]);
});

test("a retired product carries the do-not-use flag", async ({ page }) => {
  const unexpected = await installApi(page, "productActive");
  await openHarness(page, `/catalog/${ARCHIVED_PRODUCT_ID}/edit`);
  await expect(page.getByText("Не использовать")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("product-archived"));
  expect(unexpected).toEqual([]);
});
