import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceRoot = resolve(repositoryRoot, "docs/acceptance");
const screenshotRoot = resolve(evidenceRoot, "screenshots");
const artifactMode = process.env.INVENTORY_ACCEPTANCE_ARTIFACTS === "1";
const testedCommit = process.env.INVENTORY_ACCEPTANCE_COMMIT ?? "UNCOMMITTED";

const states = [
  "inventory-task-selection",
  "inventory-other-line-confirmation",
  "inventory-simple-box-accepted",
  "inventory-duplicate-other-terminal",
  "inventory-known-ineligible",
  "inventory-protected-moving-by-ud",
  "inventory-not-in-snapshot",
  "inventory-repack-awaiting-old-box",
  "inventory-repack-scanning",
  "inventory-repack-capacity-20",
  "inventory-repack-box-ready",
  "inventory-repack-corrections",
  "inventory-production-date-change",
  "inventory-source-date-mismatch",
  "inventory-mixed-box",
  "inventory-repack-source-date-mismatch",
  "inventory-leave-open-box",
  "inventory-print-recovery",
  "inventory-same-sscc-reprint-confirmation",
] as const;
const locales = ["ru", "en"] as const;
const viewports = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1280, height: 1024 },
] as const;

const representativeScreenshots = new Map([
  ["inventory-repack-capacity-20:ru:1024x768", "inventory-repack-capacity-20-1024x768-ru.png"],
  ["inventory-repack-corrections:ru:1024x768", "inventory-repack-corrections-1024x768-ru.png"],
  ["inventory-print-recovery:ru:1024x768", "inventory-print-recovery-1024x768-ru.png"],
  [
    "inventory-protected-moving-by-ud:ru:1024x768",
    "inventory-protected-moving-by-ud-1024x768-ru.png",
  ],
  [
    "inventory-other-line-confirmation:ru:1024x768",
    "inventory-other-line-confirmation-1024x768-ru.png",
  ],
  ["inventory-simple-box-accepted:ru:1280x800", "inventory-simple-box-accepted-1280x800-ru.png"],
]);

interface BrowserRow {
  state: (typeof states)[number];
  locale: (typeof locales)[number];
  requestedViewport: { width: number; height: number };
  actualState: string | null;
  actualLocale: string | null;
  window: { width: number; height: number; devicePixelRatio: number };
  document: { width: number; height: number; bodyWidth: number; bodyHeight: number };
  documentScroll: boolean;
  nestedScrollRegions: string[];
  interactiveCount: number;
  clippedInteractives: string[];
  occludedInteractives: string[];
  overlappingInteractives: string[];
  actionContentOverlaps: string[];
  targetsBelow64: Array<{ label: string; width: number; height: number }>;
  focus: { label: string; outline: string; visible: boolean } | null;
  statusSignals: Array<{ label: string; hasText: boolean; hasIcon: boolean }>;
  statusDefects: string[];
  sensitiveLeaks: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  networkFailures: string[];
  responseFailures: string[];
  screenshot: string | null;
  passed: boolean;
}

const results: BrowserRow[] = [];
let browserVersion = "unknown";

test.beforeAll(({ browser }) => {
  browserVersion = browser.version();
  if (artifactMode && !/^[0-9a-f]{40}$/.test(testedCommit)) {
    throw new Error("INVENTORY_ACCEPTANCE_COMMIT must be the immutable 40-character code commit");
  }
});

test.afterAll(async () => {
  if (!artifactMode) return;
  const failed = results.filter((row) => !row.passed);
  const matrix = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    testedCommit,
    browser: `Chromium ${browserVersion}`,
    server: "isolated local Station Vite on 127.0.0.1:43179",
    fixtureDate: "2026-08-19",
    summary: {
      rows: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      states: states.length,
      locales,
      viewports,
      consoleErrors: results.reduce((sum, row) => sum + row.consoleErrors.length, 0),
      consoleWarnings: results.reduce((sum, row) => sum + row.consoleWarnings.length, 0),
      pageErrors: results.reduce((sum, row) => sum + row.pageErrors.length, 0),
      networkFailures: results.reduce((sum, row) => sum + row.networkFailures.length, 0),
      responseFailures: results.reduce((sum, row) => sum + row.responseFailures.length, 0),
      nestedScrollRegions: results.reduce((sum, row) => sum + row.nestedScrollRegions.length, 0),
      clippedInteractives: results.reduce((sum, row) => sum + row.clippedInteractives.length, 0),
      occludedInteractives: results.reduce((sum, row) => sum + row.occludedInteractives.length, 0),
      overlappingInteractives: results.reduce(
        (sum, row) => sum + row.overlappingInteractives.length,
        0,
      ),
      actionContentOverlaps: results.reduce(
        (sum, row) => sum + row.actionContentOverlaps.length,
        0,
      ),
      targetsBelow64: results.reduce((sum, row) => sum + row.targetsBelow64.length, 0),
      focusPassed: results.filter((row) => row.focus?.visible).length,
      statusDefects: results.reduce((sum, row) => sum + row.statusDefects.length, 0),
      sensitiveLeaks: results.reduce((sum, row) => sum + row.sensitiveLeaks.length, 0),
    },
    screenshots: Object.fromEntries(representativeScreenshots),
    results,
  };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    resolve(evidenceRoot, "inventory-station-browser-matrix.json"),
    `${JSON.stringify(matrix, null, 2)}\n`,
  );
});

test("all inventory gallery fixtures satisfy the bilingual floor viewport contract", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const pageErrors: string[] = [];
  const networkFailures: string[] = [];
  const responseFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning") consoleWarnings.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    networkFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const locale of locales) {
      for (const state of states) {
        consoleErrors.length = 0;
        consoleWarnings.length = 0;
        pageErrors.length = 0;
        networkFailures.length = 0;
        responseFailures.length = 0;

        await page.goto(`/?gallery=1&state=${state}&locale=${locale}`, {
          waitUntil: "domcontentloaded",
        });
        const gallery = page.getByTestId("station-screen-gallery");
        await expect(gallery).toHaveAttribute("data-gallery-state", state);
        await expect(gallery).toHaveAttribute("data-gallery-locale", locale);
        if (state === "inventory-task-selection") {
          const warehouseLabel = locale === "ru" ? /Складские операции/ : /Warehouse operations/;
          await expect(page.getByRole("tab", { name: warehouseLabel })).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await expect(
            page.getByRole("button", {
              name: locale === "ru" ? "Продолжить INV-00047" : "Continue INV-00047",
            }),
          ).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await focusVisibleAction(page);

        const measured = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(
            "[data-testid='station-screen-gallery']",
          );
          if (!root) throw new Error("inventory gallery root is absent");
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const label = (element: Element) => {
            const text =
              element.getAttribute("aria-label") ?? element.textContent ?? element.tagName;
            return text.replace(/\s+/g, " ").trim().slice(0, 100);
          };
          const rendered = (element: HTMLElement) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return !(
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity) === 0 ||
              rect.width <= 0 ||
              rect.height <= 0
            );
          };
          const centerIsVisible = (element: HTMLElement) => {
            if (!rendered(element)) return false;
            const rect = element.getBoundingClientRect();
            const top = document.elementFromPoint(
              Math.min(viewportWidth - 1, Math.max(0, rect.left + rect.width / 2)),
              Math.min(viewportHeight - 1, Math.max(0, rect.top + rect.height / 2)),
            );
            return top !== null && (element.contains(top) || top.contains(element));
          };
          const activeModal = Array.from(
            root.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"),
          ).find(rendered);
          const candidates = Array.from(
            new Set(
              root.querySelectorAll<HTMLElement>(
                "button, input, select, textarea, a[href], [role='button'], [role='tab']",
              ),
            ),
          ).filter(
            (element) => rendered(element) && (!activeModal || activeModal.contains(element)),
          );
          const clippedInteractives: string[] = [];
          const occludedInteractives = candidates
            .filter((element) => !centerIsVisible(element))
            .map(label);
          const targetsBelow64: Array<{ label: string; width: number; height: number }> = [];
          const rects = candidates.map((element) => {
            const rect = element.getBoundingClientRect();
            let clipped =
              rect.left < -0.5 ||
              rect.top < -0.5 ||
              rect.right > viewportWidth + 0.5 ||
              rect.bottom > viewportHeight + 0.5;
            let ancestor = element.parentElement;
            while (!clipped && ancestor && ancestor !== document.body) {
              const style = getComputedStyle(ancestor);
              if (
                [style.overflowX, style.overflowY].some((value) =>
                  ["hidden", "clip", "auto", "scroll"].includes(value),
                )
              ) {
                const boundary = ancestor.getBoundingClientRect();
                clipped =
                  rect.left < boundary.left - 0.5 ||
                  rect.top < boundary.top - 0.5 ||
                  rect.right > boundary.right + 0.5 ||
                  rect.bottom > boundary.bottom + 0.5;
              }
              if (style.position === "fixed") break;
              ancestor = ancestor.parentElement;
            }
            const elementStyle = getComputedStyle(element);
            const contentClipped =
              ["hidden", "clip"].includes(elementStyle.overflowX) &&
              element.scrollWidth > element.clientWidth + 1;
            if (clipped || contentClipped) {
              clippedInteractives.push(label(element));
            }
            if (rect.width < 63.5 || rect.height < 63.5) {
              targetsBelow64.push({
                label: label(element),
                width: Number(rect.width.toFixed(2)),
                height: Number(rect.height.toFixed(2)),
              });
            }
            return { element, rect, label: label(element) };
          });
          const overlappingInteractives: string[] = [];
          for (let left = 0; left < rects.length; left += 1) {
            for (let right = left + 1; right < rects.length; right += 1) {
              const a = rects[left]!;
              const b = rects[right]!;
              const overlapWidth =
                Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
              const overlapHeight =
                Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
              if (overlapWidth > 1 && overlapHeight > 1) {
                overlappingInteractives.push(`${a.label} <> ${b.label}`);
              }
            }
          }
          const contentSignals = Array.from(
            root.querySelectorAll<HTMLElement>(
              ".mk-alert, .repack-prompt, .inventory-box-print__status, [role='status']",
            ),
          ).filter(
            (element) => rendered(element) && (!activeModal || activeModal.contains(element)),
          );
          const actionContentOverlaps: string[] = [];
          for (const action of rects) {
            for (const content of contentSignals) {
              if (action.element.contains(content) || content.contains(action.element)) continue;
              const contentRect = content.getBoundingClientRect();
              const overlapWidth =
                Math.min(action.rect.right, contentRect.right) -
                Math.max(action.rect.left, contentRect.left);
              const overlapHeight =
                Math.min(action.rect.bottom, contentRect.bottom) -
                Math.max(action.rect.top, contentRect.top);
              if (overlapWidth > 1 && overlapHeight > 1) {
                actionContentOverlaps.push(`${action.label} <> ${label(content)}`);
              }
            }
          }
          const nestedScrollRegions = Array.from(root.querySelectorAll<HTMLElement>("*"))
            .filter((element) => {
              const style = getComputedStyle(element);
              const x =
                ["auto", "scroll"].includes(style.overflowX) &&
                element.scrollWidth > element.clientWidth + 1;
              const y =
                ["auto", "scroll"].includes(style.overflowY) &&
                element.scrollHeight > element.clientHeight + 1;
              return x || y;
            })
            .map(label);
          const statusSignals = Array.from(contentSignals)
            .filter(centerIsVisible)
            .map((element) => ({
              label: label(element),
              hasText: Boolean(element.textContent?.trim()),
              hasIcon: Boolean(
                element.querySelector("[aria-hidden='true'], svg, .mk-badge") ??
                element.matches("[aria-hidden='true'], svg, .mk-badge"),
              ),
            }));
          const statusDefects = statusSignals
            .filter((signal) => !signal.hasText && !signal.hasIcon)
            .map((signal) => signal.label || "unnamed status");
          const bodyText = document.body.textContent ?? "";
          const sensitiveLeaks = [
            /01\d{14}21[A-Za-z0-9]{4,}/.test(bodyText) ? "full-raw-km" : null,
            bodyText.includes("gallery-demo-pin-hash") ? "pin-hash" : null,
            bodyText.includes("pairing code") && /\b\d{6}\b/.test(bodyText) ? "pairing-code" : null,
          ].filter((value): value is string => value !== null);
          const active = document.activeElement as HTMLElement | null;
          const focusStyle = active ? getComputedStyle(active) : null;
          const focusRect = active?.getBoundingClientRect();
          const focus =
            active && active !== document.body && focusStyle && focusRect
              ? {
                  label: label(active),
                  outline: `${focusStyle.outlineWidth} ${focusStyle.outlineStyle} ${focusStyle.outlineColor}`,
                  visible:
                    active.matches(":focus-visible") &&
                    (!activeModal || activeModal.contains(active)) &&
                    centerIsVisible(active) &&
                    ((Number.parseFloat(focusStyle.outlineWidth) >= 2 &&
                      focusStyle.outlineStyle !== "none") ||
                      focusStyle.boxShadow !== "none") &&
                    focusRect.left >= -0.5 &&
                    focusRect.top >= -0.5 &&
                    focusRect.right <= viewportWidth + 0.5 &&
                    focusRect.bottom <= viewportHeight + 0.5,
                }
              : null;
          return {
            actualState: root.dataset.galleryState ?? null,
            actualLocale: root.dataset.galleryLocale ?? null,
            window: {
              width: window.innerWidth,
              height: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio,
            },
            document: {
              width: document.documentElement.scrollWidth,
              height: document.documentElement.scrollHeight,
              bodyWidth: document.body.scrollWidth,
              bodyHeight: document.body.scrollHeight,
            },
            documentScroll:
              document.documentElement.scrollWidth > window.innerWidth + 1 ||
              document.documentElement.scrollHeight > window.innerHeight + 1 ||
              document.body.scrollWidth > window.innerWidth + 1 ||
              document.body.scrollHeight > window.innerHeight + 1,
            nestedScrollRegions,
            interactiveCount: candidates.length,
            clippedInteractives,
            occludedInteractives,
            overlappingInteractives,
            actionContentOverlaps,
            targetsBelow64,
            focus,
            statusSignals,
            statusDefects,
            sensitiveLeaks,
          };
        });

        const screenshotKey = `${state}:${locale}:${viewport.width}x${viewport.height}`;
        const screenshot = representativeScreenshots.get(screenshotKey) ?? null;
        if (artifactMode && screenshot) {
          await mkdir(screenshotRoot, { recursive: true });
          await page.screenshot({
            path: resolve(screenshotRoot, screenshot),
            animations: "disabled",
            fullPage: false,
          });
        }
        const row: BrowserRow = {
          state,
          locale,
          requestedViewport: viewport,
          ...measured,
          consoleErrors: [...consoleErrors],
          consoleWarnings: [...consoleWarnings],
          pageErrors: [...pageErrors],
          networkFailures: [...networkFailures],
          responseFailures: [...responseFailures],
          screenshot,
          passed: false,
        };
        row.passed = rowPasses(row);
        results.push(row);
      }
    }
  }

  const failed = results.filter((row) => !row.passed);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  expect(results).toHaveLength(states.length * locales.length * viewports.length);
});

async function focusVisibleAction(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.keyboard.press("Tab");
    const visible = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.matches(":focus-visible")) return false;
      const style = getComputedStyle(active);
      const rect = active.getBoundingClientRect();
      const top = document.elementFromPoint(
        Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2)),
        Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2)),
      );
      return (
        (top !== null &&
          (active.contains(top) || top.contains(active)) &&
          Number.parseFloat(style.outlineWidth) >= 2 &&
          style.outlineStyle !== "none") ||
        (top !== null &&
          (active.contains(top) || top.contains(active)) &&
          style.boxShadow !== "none")
      );
    });
    if (visible) return;
  }
}

function rowPasses(row: BrowserRow): boolean {
  return (
    row.actualState === row.state &&
    row.actualLocale === row.locale &&
    row.window.width === row.requestedViewport.width &&
    row.window.height === row.requestedViewport.height &&
    row.document.width === row.requestedViewport.width &&
    row.document.height === row.requestedViewport.height &&
    row.document.bodyWidth === row.requestedViewport.width &&
    row.document.bodyHeight === row.requestedViewport.height &&
    !row.documentScroll &&
    row.nestedScrollRegions.length === 0 &&
    row.interactiveCount > 0 &&
    row.clippedInteractives.length === 0 &&
    row.occludedInteractives.length === 0 &&
    row.overlappingInteractives.length === 0 &&
    row.actionContentOverlaps.length === 0 &&
    row.targetsBelow64.length === 0 &&
    row.focus?.visible === true &&
    row.statusDefects.length === 0 &&
    row.sensitiveLeaks.length === 0 &&
    row.consoleErrors.length === 0 &&
    row.pageErrors.length === 0 &&
    row.networkFailures.length === 0 &&
    row.responseFailures.length === 0
  );
}
