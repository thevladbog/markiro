import { expect, test } from "@playwright/test";

type CspViolation = {
  blockedURI: string;
  columnNumber: number;
  effectiveDirective: string;
  lineNumber: number;
  sample: string;
  sourceFile: string;
  violatedDirective: string;
};

declare global {
  interface Window {
    __markiroCspViolations: CspViolation[];
  }
}

test("renders the same-origin OpenAPI document under the production CSP", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const productionOrigin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  await page.addInitScript(() => {
    window.__markiroCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__markiroCspViolations.push({
        blockedURI: event.blockedURI,
        columnNumber: event.columnNumber,
        effectiveDirective: event.effectiveDirective,
        lineNumber: event.lineNumber,
        sample: event.sample,
        sourceFile: event.sourceFile,
        violatedDirective: event.violatedDirective,
      });
    });
  });
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (["data:", "blob:"].includes(requestUrl.protocol)) return;
    if (
      !["http:", "https:"].includes(requestUrl.protocol) ||
      requestUrl.origin !== productionOrigin
    )
      externalRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const openApiResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${productionOrigin}/openapi.json` &&
      response.request().method() === "GET",
  );
  const navigation = await page.goto("/docs", { waitUntil: "domcontentloaded" });

  expect(navigation?.status()).toBe(200);
  await expect(page).toHaveTitle("Markiro API");
  await expect(
    page.getByRole("heading", { name: "Markiro API", exact: true }).first(),
  ).toBeVisible();
  const openApiResponse = await openApiResponsePromise;
  expect(openApiResponse.status()).toBe(200);
  expect(openApiResponse.headers()["content-type"]).toContain("application/json");

  const cspViolations = await page.evaluate(() => window.__markiroCspViolations);
  expect(cspViolations, "CSP violations").toEqual([]);
  expect(externalRequests, "requests outside the production origin").toEqual([]);
  expect(pageErrors, "uncaught page errors").toEqual([]);
  expect(consoleErrors, "browser console errors").toEqual([]);
});
