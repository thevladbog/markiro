import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../tools/production-browser/package.json", import.meta.url),
);

export async function browserSmoke(port, evidenceDir) {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`https://saas-admin.localhost:${port}/login`);
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
    await page.goto(`https://landing.localhost:${port}/`);
    await page.locator("h1").waitFor();
    await page.screenshot({ path: `${evidenceDir}/platform-landing.png`, fullPage: true });
    assert.deepEqual(errors, [], "browser JavaScript errors");
    await context.close();
  } finally {
    await browser.close();
  }
}
