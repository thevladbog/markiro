import { expect, test } from "@playwright/test";

const routes = [
  { path: "/legal/", copiedLabel: "Скопировано" },
  {
    path: "/d/MKR-PD-01/2026.08/01/15.08.2026",
    copiedLabel: "Скопировано",
  },
] as const;

for (const route of routes) {
  test(`${route.path} keeps legal controls executable under the production CSP`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    const response = await page.goto(route.path, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");

    const copyButton = page.locator("[data-copy-artifact]").first();
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await expect(copyButton).toHaveText(route.copiedLabel);
    expect(errors).toEqual([]);
  });
}
