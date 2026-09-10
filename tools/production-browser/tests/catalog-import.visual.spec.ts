import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import {
  catalogCapabilitiesSchema,
  chzLinkDetailSchema,
  importPrepareResponseSchema,
  importResultSchema,
} from "../../../packages/platform-contracts/dist/index.js";

import {
  capabilitiesFixture,
  id,
  itemsFixture,
  linkFixture,
  photoFixtureBase64,
  previewFixture,
  productFixture,
  resultFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";

/**
 * MKR-INS-11 (printed National Catalog import instruction) screenshot
 * targets. Unlike the other cabinet suites this one does not hand-write its
 * fixtures: `apps/admin/test/national-catalog-fixtures.ts` already parses
 * every shape through the real zod schemas from `@markiro/platform-contracts`,
 * so a drifted contract breaks the fixture module instead of producing a
 * screenshot of a screen the product cannot render.
 */
const SCREENSHOT_DIR = join(
  import.meta.dirname,
  "../../../packages/legal-documents/assets/instructions/mkr-ins-11/ru",
);
function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, `${name}.png`);
}

/**
 * The import panel slides in over the catalog, and an assertion on its
 * content passes while the transition is still running -- without this wait
 * the capture catches a half-open panel. Infinite animations (spinners) are
 * excluded: they never finish by definition.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => (animation.effect?.getTiming().iterations ?? 1) !== Infinity)
      .every((animation) => animation.playState === "finished"),
  );
  await page.addStyleTag({
    content:
      "* { caret-color: transparent !important; }\n" +
      "::-webkit-scrollbar { display: none !important; }",
  });
}

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
    const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
    await page.setViewportSize({
      width: viewport.width + overflow.x,
      height: viewport.height + overflow.y,
    });
    await settle(page);
  }
  await page.screenshot({ path, scale: "css", fullPage: true });
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const PROFILE = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
const ACCESS = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };

/**
 * Connection missing: both load paths are refused, each with its reason.
 * Parsed through the real schema so an invented enum value fails here rather
 * than rendering a generic "could not load" panel that documents nothing.
 */
const CAPABILITIES_UNAVAILABLE = catalogCapabilitiesSchema.parse({
  ownCatalog: false,
  gtinLookup: false,
  photos: false,
  connection: { state: "missing", reason: "integration_missing" },
  unavailableReason: {
    ownCatalog: "connection_unavailable",
    gtinLookup: "connection_unavailable",
    images: "connection_unavailable",
  },
});
const SESSION_READY = { ...sessionFixture, state: "ready", complete: true, loaded: 1 };

/** `noUncheckedIndexedAccess` is on; assert the shape the fixture promises. */
function first<T>(values: readonly T[], what: string): T {
  const [head] = values;
  if (head === undefined) throw new Error(`the ${what} fixture must carry at least one entry`);
  return head;
}
const BASE_ITEM = first(previewFixture.items, "preview item");

/**
 * The shared fixture carries a single field and no photos -- enough for a
 * functional assertion, too thin for a printed page. This one shows the
 * comparison the manager actually reviews: several fields, a photo candidate
 * and a product group that the National Catalog can fill in.
 */
const PREVIEW_RICH = importPrepareResponseSchema.parse({
  preparation: { ...previewFixture.preparation },
  items: [
    {
      ...BASE_ITEM,
      fields: [
        {
          ...first(BASE_ITEM.fields, "preview field"),
          label: "Название товара",
          labelKey: "name",
          before: "Молоко 3,2%",
          after: "Молоко питьевое пастеризованное 3,2%",
        },
        {
          id: id(14),
          label: "Наименование для печати",
          labelKey: "print_name",
          before: null,
          after: "Молоко 3,2%",
          applicable: true,
          reason: null,
          source: "national_catalog",
          selectedByDefault: true,
          requiresEntryIds: [],
        },
        {
          id: id(15),
          label: "Группа продукции",
          labelKey: "chz_product_group_code",
          before: null,
          after: "Молочная продукция",
          applicable: true,
          reason: null,
          source: "national_catalog",
          selectedByDefault: true,
          requiresEntryIds: [],
        },
      ],
      photos: [
        {
          candidateId: id(30),
          previewPath: "/photo/1",
          state: "ready",
          primary: true,
          selectedByDefault: true,
          reason: null,
        },
      ],
    },
  ],
});

/** The same position the cabinet refuses to apply: the group is ambiguous. */
const RICH_ITEM = first(PREVIEW_RICH.items, "rich preview item");
const PREVIEW_BLOCKED = importPrepareResponseSchema.parse({
  preparation: { ...previewFixture.preparation },
  items: [
    {
      ...RICH_ITEM,
      fields: RICH_ITEM.fields.map((field) =>
        field.labelKey === "chz_product_group_code"
          ? { ...field, after: null, applicable: false, reason: "product_group_ambiguous" }
          : field,
      ),
      canApply: false,
      reason: "product_group_ambiguous",
    },
  ],
});
/**
 * The shared result fixture is a finished operation whose photo failed. This
 * one is the state in between: the product is already in the catalog while
 * its photo is still being saved, which is what disables "Открыть товар в
 * каталоге" and prints the wait notice.
 */
const RESULT_RUNNING = importResultSchema.parse({
  ...resultFixture,
  state: "running",
  items: resultFixture.items.map((item) => ({
    ...item,
    product: "applied",
    image: "pending",
    imageReason: null,
    reason: null,
  })),
});

/**
 * A saved link whose last status check failed. The cabinet keeps showing the
 * stored card details and marks the check itself as failed -- the state the
 * refresh button leaves behind, and the one a reload shows again.
 */
const LINK_CHECK_FAILED = chzLinkDetailSchema.parse({
  summary: {
    ...linkFixture.summary,
    lastAttemptAt: "2026-09-09T09:12:00.000Z",
    lastOutcome: "error",
    lastErrorCode: "card_unavailable",
  },
  link: { ...linkFixture.link },
});

type Scenario =
  | "unavailable"
  | "start"
  | "selection"
  | "review"
  | "reviewBlocked"
  | "result"
  | "resultPhoto"
  | "link"
  | "linkError";

async function installApi(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith(`/images/${id(30)}`)) {
      return route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: Buffer.from(photoFixtureBase64, "base64"),
      });
    }
    if (path === "/api/access/me") return json(route, ACCESS);
    if (path === "/api/profile") return json(route, PROFILE);
    if (path === "/api/pickup-orders" || path === "/api/counterparties") {
      return json(route, { items: [] });
    }
    if (path === "/api/products") {
      const linked = scenario === "link" || scenario === "linkError";
      return json(route, { items: linked ? [productFixture] : [] });
    }
    if (path === "/api/national-catalog/capabilities") {
      return json(
        route,
        scenario === "unavailable" ? CAPABILITIES_UNAVAILABLE : capabilitiesFixture,
      );
    }
    const detail = scenario === "linkError" ? LINK_CHECK_FAILED : linkFixture;
    // The refresh answers with the summary alone, then the panel refetches the
    // detail -- both have to carry the same outcome or the frame would show a
    // failure that the very next request erases.
    if (path.endsWith("/national-catalog/link/refresh")) return json(route, detail.summary);
    if (path.endsWith("/national-catalog/link")) return json(route, detail);
    if (path.endsWith("/items")) return json(route, { ...itemsFixture, nextCursor: null });
    if (path.endsWith("/selection")) {
      return json(route, { ...SESSION_READY, selected: 1, selectedItemIds: [id(2)], revision: 1 });
    }
    if (path.endsWith("/previews") || path.includes("/preparations/")) {
      return json(route, scenario === "reviewBlocked" ? PREVIEW_BLOCKED : PREVIEW_RICH);
    }
    if (path.endsWith("/applies") || path.includes("/applies/")) {
      return json(route, scenario === "resultPhoto" ? RESULT_RUNNING : resultFixture);
    }
    if (path.includes("/import-sessions")) {
      return json(route, scenario === "start" ? sessionFixture : SESSION_READY);
    }

    unexpected.push(`${route.request().method()} ${path}${url.search}`);
    return route.abort();
  });
  return unexpected;
}

async function openRoute(page: Page, route: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`);
}

test("the import panel explains a missing Chestny Znak connection", async ({ page }) => {
  const unexpected = await installApi(page, "unavailable");
  await openRoute(page, "/catalog/import");
  await expect(page.getByRole("dialog", { name: "Национальный каталог" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-unavailable"));
  expect(unexpected).toEqual([]);
});

test("the import panel offers both ways to load products", async ({ page }) => {
  const unexpected = await installApi(page, "start");
  await openRoute(page, "/catalog/import");
  await expect(page.getByRole("button", { name: "Загрузить мои товары" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Найти по GTIN" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-start"));
  expect(unexpected).toEqual([]);
});

/** Shared path into the selection step: load the organization's own cards. */
async function openSelection(page: Page) {
  await openRoute(page, "/catalog/import");
  await page.getByRole("button", { name: "Загрузить мои товары" }).click();
  await expect(page.getByRole("checkbox", { name: /4006381333931/ })).toBeVisible();
}

test("the selection step lists loaded cards with their match", async ({ page }) => {
  const unexpected = await installApi(page, "selection");
  await openSelection(page);
  await screenshotFullMain(page, screenshotPath("import-selection"));
  expect(unexpected).toEqual([]);
});

test("the review step compares current and proposed values", async ({ page }) => {
  const unexpected = await installApi(page, "review");
  await openSelection(page);
  await page.getByRole("checkbox", { name: /4006381333931/ }).click();
  await page.getByRole("button", { name: "Проверить выбранные товары" }).click();
  await expect(page.getByLabel("Название вручную")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-review"));
  expect(unexpected).toEqual([]);
});

test("a position the cabinet cannot apply says why", async ({ page }) => {
  const unexpected = await installApi(page, "reviewBlocked");
  await openSelection(page);
  await page.getByRole("checkbox", { name: /4006381333931/ }).click();
  await page.getByRole("button", { name: "Проверить выбранные товары" }).click();
  await expect(page.getByLabel("Название вручную")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-review-blocked"));
  expect(unexpected).toEqual([]);
});

test("the review step offers the National Catalog photo", async ({ page }) => {
  const unexpected = await installApi(page, "review");
  await openSelection(page);
  await page.getByRole("checkbox", { name: /4006381333931/ }).click();
  await page.getByRole("button", { name: "Проверить выбранные товары" }).click();
  // `<fieldset><legend>Фото</legend>` -- take the section itself: the photo
  // step is one block of a very tall panel, and a full-page capture would
  // repeat the review frame.
  const photos = page.getByRole("group", { name: "Фото" });
  await expect(photos).toBeVisible();
  await settle(page);
  await photos.screenshot({ path: screenshotPath("import-photo"), scale: "css" });
  expect(unexpected).toEqual([]);
});

/**
 * The result step is addressed by `operationId` in the query string, so the
 * frames below open it directly instead of re-walking selection and review --
 * the same URL the cabinet writes when the manager applies the import.
 */
function resultRoute(): string {
  return `/catalog/import?sessionId=${id(1)}&operationId=${id(20)}`;
}

test("the result step reports the product and its photo separately", async ({ page }) => {
  const unexpected = await installApi(page, "result");
  await openRoute(page, resultRoute());
  await expect(page.getByRole("button", { name: "Открыть товар в каталоге" })).toBeEnabled();
  await screenshotFullMain(page, screenshotPath("import-result"));
  expect(unexpected).toEqual([]);
});

test("an unfinished photo holds back the link to the product", async ({ page }) => {
  const unexpected = await installApi(page, "resultPhoto");
  await openRoute(page, resultRoute());
  await expect(page.getByRole("button", { name: "Открыть товар в каталоге" })).toBeDisabled();
  await expect(
    page.getByText("Сохраняем фото. После завершения можно открыть карточку товара."),
  ).toBeVisible();
  await screenshotFullMain(page, screenshotPath("import-result-photo"));
  expect(unexpected).toEqual([]);
});

test("the link panel shows the bound card and its actions", async ({ page }) => {
  const unexpected = await installApi(page, "link");
  await openRoute(page, `/catalog/${id(99)}/chz`);
  await expect(page.getByRole("dialog", { name: "Связь с Честным знаком" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Обновить статус" })).toBeEnabled();
  await screenshotFullMain(page, screenshotPath("chz-link"));
  expect(unexpected).toEqual([]);
});

test("a failed status check keeps the saved details and names the reason", async ({ page }) => {
  const unexpected = await installApi(page, "linkError");
  await openRoute(page, `/catalog/${id(99)}/chz`);
  await page.getByRole("button", { name: "Обновить статус" }).click();
  await expect(
    page.getByText("Последняя проверка не удалась. Показаны сохранённые сведения."),
  ).toBeVisible();
  // The reason itself lives behind the collapsed `<details>`; open it so the
  // frame shows where the manager reads what went wrong.
  await page.locator("details > summary").click();
  await expect(page.getByText("Связанная карточка недоступна в ЧЗ.")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("chz-refresh-error"));
  expect(unexpected).toEqual([]);
});
