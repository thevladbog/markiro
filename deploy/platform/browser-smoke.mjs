import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../tools/production-browser/package.json", import.meta.url),
);

// Docker bridge changes can invalidate Chromium's initial network snapshot.
// Retry only this explicit transport error on local, idempotent navigation;
// never retry assertions, authentication, HTTP errors or generic timeouts.
export async function navigateLocalPage(page, url, wait = delay) {
  const target = new URL(url);
  assert.equal(target.protocol, "https:");
  assert.ok(["saas-admin.localhost", "landing.localhost"].includes(target.hostname));
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.goto(url);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("net::ERR_NETWORK_CHANGED") ||
        attempt === 2
      )
        throw error;
      await wait(1000);
    }
  }
}

export async function browserSmoke(port, evidenceDir, options = {}) {
  const { chromium } = options.chromium ? options : require("@playwright/test");
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
  });
  let page;
  const errors = [];
  const failedRequests = [];
  const failedResponses = [];
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.on("pageerror", (error) => {
      if (errors.length < 20) errors.push(error.message.slice(0, 2000));
    });
    page.on("requestfailed", (request) => {
      if (failedRequests.length < 40)
        failedRequests.push({
          path: new URL(request.url()).pathname,
          resourceType: request.resourceType(),
          error: request.failure()?.errorText,
        });
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && failedResponses.length < 40)
        failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    await navigateLocalPage(page, `https://saas-admin.localhost:${port}/login`);
    await page.locator('input[type="email"]').waitFor();
    await page.locator('input[type="password"]').waitFor();
    await page.screenshot({ path: `${evidenceDir}/platform-login.png`, fullPage: true });
    await page.locator('input[type="email"]').fill("nobody@markiro.local");
    await page.locator('input[type="password"]').fill("test-invalid-password");
    const response = page.waitForResponse((r) =>
      r.url().includes("/api/platform-auth/sign-in/email"),
    );
    await page.locator('button[type="submit"]').click();
    assert.equal((await response).status(), 401);
    await navigateLocalPage(page, `https://landing.localhost:${port}/`);
    await page.locator("h1").waitFor();
    await page.screenshot({ path: `${evidenceDir}/platform-landing.png`, fullPage: true });
    assert.deepEqual(errors, [], "browser JavaScript errors");
    await context.close();
  } catch (error) {
    // This harness uses only synthetic CI accounts. Do not record bodies,
    // headers, cookies or URL queries, even when navigation fails.
    await Promise.allSettled([
      writeFile(
        `${evidenceDir}/platform-browser-failure.json`,
        JSON.stringify({ errors, failedRequests, failedResponses }, null, 2) + "\n",
        { mode: 0o600 },
      ),
      ...(page
        ? [
            page.screenshot({
              path: `${evidenceDir}/platform-browser-failure.png`,
              fullPage: true,
              timeout: 5000,
            }),
          ]
        : []),
    ]);
    throw error;
  } finally {
    await browser.close();
  }
}
