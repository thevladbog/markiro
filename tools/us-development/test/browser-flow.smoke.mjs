import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startUsBrowserFixture } from "../browser-fixture.mjs";

// Use the separately pinned browser tool workspace. No browser dependency enters
// the product bundle. NODE_PATH can supply an already installed read-only runtime.
const browserRequire = createRequire(
  new URL("../../production-browser/package.json", import.meta.url),
);
const { chromium, expect } = browserRequire("@playwright/test");
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const authRequire = createRequire(apiRequire.resolve("better-auth"));
const { createOTP } = authRequire("@better-auth/utils/otp");
const { base32 } = authRequire("@better-auth/utils/base32");

test(
  "US browser: real MFA, organization, profile persistence, EN/ES and mobile",
  { timeout: 90000 },
  async () => {
    const fixture = await startUsBrowserFixture(process.env.US_TEST_DATABASE_URL);
    let browser;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
      });
      // No screenshots/traces of MFA material; only explicitly safe states below.
      const page = await context.newPage();
      const pageErrors = [];
      const externalRequests = [];
      page.on("pageerror", () => pageErrors.push("pageerror"));
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === "http://localhost:5174")
          await route.continue();
        else {
          externalRequests.push(new URL(route.request().url()).origin);
          await route.abort();
        }
      });
      const screenshots = await mkdtemp(join(tmpdir(), "markiro-us-browser-"));
      await page.goto("http://localhost:5174");
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: /register|sign up|forgot/i })).toHaveCount(0);
      await page.screenshot({ path: join(screenshots, "sign-in-en.png"), fullPage: true });

      await page.getByLabel("Email", { exact: true }).fill(fixture.email);
      await page.getByRole("button", { name: "Language", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Iniciar sesión", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Correo electrónico", { exact: true })).toHaveValue(
        fixture.email,
      );
      await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByLabel("Correo electrónico", { exact: true }).fill("");
      await page.screenshot({ path: join(screenshots, "sign-in-es-mobile.png"), fullPage: true });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.getByRole("button", { name: "Idioma", exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });

      async function login() {
        await page.getByLabel("Email", { exact: true }).fill(fixture.email);
        await page.getByLabel("Password", { exact: true }).fill(fixture.password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
      }
      await login();
      await expect(
        page.getByRole("heading", { name: "Set up multi-factor authentication" }),
      ).toBeVisible();
      await page.getByLabel("Confirm password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
      const key = page.getByText("Manual authenticator setup key", { exact: true }).locator("+ dd");
      await expect(key).toBeVisible();
      const secret = new TextDecoder().decode(base32.decode((await key.textContent()).trim()));
      const backupCode = (
        await page.getByText("Backup codes", { exact: true }).locator("+ dd").textContent()
      ).trim();
      await expect(page.getByRole("button", { name: "Verify", exact: true })).toBeDisabled();
      await page.getByRole("checkbox", { name: "I saved these backup codes" }).check();
      // Sequential typing catches accidental component remount/focus loss.
      await page
        .getByLabel("6-digit authenticator code", { exact: true })
        .pressSequentially(await createOTP(secret).totp());
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Select an organization" })).toBeVisible();
      await expect(key).toHaveCount(0);
      await page.getByRole("button", { name: "Synthetic US development", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Set up traceability profile" }),
      ).toBeVisible();
      await expect(page.getByLabel("Regulatory profile", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Time zone", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Retention (calendar years)", { exact: true })).toHaveValue("5");
      await page
        .getByLabel("Regulatory profile", { exact: true })
        .selectOption("US_FSMA204_PROCESSOR");
      await page.getByLabel("Time zone", { exact: true }).selectOption("America/Chicago");
      await page.screenshot({ path: join(screenshots, "profile-setup-en.png"), fullPage: true });
      await page.getByRole("button", { name: "Save profile", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Traceability profile", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("America/Chicago", { exact: true })).toBeVisible();
      await page.screenshot({ path: join(screenshots, "profile-en.png"), fullPage: true });
      await page.getByRole("button", { name: "Change theme", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.getByRole("button", { name: "Language", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Perfil de trazabilidad", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(screenshots, "profile-es-dark.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: join(screenshots, "profile-es-dark-mobile.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Idioma", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      assert.equal(
        (await context.cookies()).some((cookie) => cookie.name === "markiro-us.session_token"),
        false,
      );

      await login();
      await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
      await page.getByRole("button", { name: "Use a backup code", exact: true }).click();
      await page.getByLabel("Backup code", { exact: true }).fill(backupCode);
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Select an organization" })).toBeVisible();
      await page.getByRole("button", { name: "Synthetic US development", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Traceability profile", exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Traceability profile", exact: true }),
      ).toBeVisible();
      assert.equal(
        await page.evaluate(() => {
          const permitted = new Set(["markiro.theme"]);
          return (
            Object.keys(localStorage).every((key) => permitted.has(key)) &&
            sessionStorage.length === 0
          );
        }),
        true,
      );
      await context.clearCookies();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      // Hold the real verification request, then request logout before it can
      // install its session cookie. Logout must be sent last, not race Set-Cookie.
      await login();
      await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
      const held = Promise.withResolvers();
      const release = Promise.withResolvers();
      const authOrder = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/sign-out")) authOrder.push("sign-out");
      });
      await page.route("**/api/us-auth/two-factor/verify-totp", async (route) => {
        held.resolve();
        await release.promise;
        authOrder.push("verification-released");
        await route.continue();
      });
      await page
        .getByLabel("6-digit authenticator code", { exact: true })
        .fill(await createOTP(secret).totp());
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await held.promise;
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      release.resolve();
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      assert.deepEqual(authOrder, ["verification-released", "sign-out"]);
      const sessionAfterLogout = await context.request.get(
        "http://localhost:5174/api/us-auth/get-session",
      );
      assert.equal(sessionAfterLogout.status(), 200);
      assert.equal(await sessionAfterLogout.json(), null);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(externalRequests, []);
      const audits = await fixture.pool.query(
        "SELECT actor_user_id, action, outcome, target_type, target_id FROM tenant_audit_events WHERE organization_id = $1 AND action = $2",
        [fixture.tenantId, "traceability.profile.updated"],
      );
      assert.deepEqual(audits.rows, [
        {
          actor_user_id: fixture.userId,
          action: "traceability.profile.updated",
          outcome: "success",
          target_type: "tenant",
          target_id: fixture.tenantId,
        },
      ]);
      console.log(`US browser screenshots (safe states only): ${screenshots}`);
    } finally {
      try {
        await browser?.close();
      } finally {
        await fixture.close();
      }
    }
  },
);
