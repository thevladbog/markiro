import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { catalogCapabilitiesSchema } from "../../../packages/platform-contracts/dist/index.js";

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
const RESULT_RUNNING = {
  ...resultFixture,
  state: "running",
  items: resultFixture.items.map((item) => ({ ...item, outcome: "applied", image: "pending" })),
};

type Scenario =
  "unavailable" | "start" | "selection" | "review" | "result" | "resultPhoto" | "link";

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
      return json(route, { items: scenario === "link" ? [productFixture] : [] });
    }
    if (path === "/api/national-catalog/capabilities") {
      return json(
        route,
        scenario === "unavailable" ? CAPABILITIES_UNAVAILABLE : capabilitiesFixture,
      );
    }
    if (path.endsWith("/national-catalog/link")) return json(route, linkFixture);
    if (path.endsWith("/items")) return json(route, { ...itemsFixture, nextCursor: null });
    if (path.endsWith("/selection")) {
      return json(route, { ...SESSION_READY, selected: 1, selectedItemIds: [id(2)], revision: 1 });
    }
    if (path.endsWith("/previews") || path.includes("/preparations/")) {
      return json(route, previewFixture);
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
