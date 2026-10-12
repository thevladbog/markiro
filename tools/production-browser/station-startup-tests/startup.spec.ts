import { expect, test } from "@playwright/test";

test("production Station renders before native storage initialization finishes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    // Keep device I/O pending: this test exercises the real production module graph and first paint.
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: () => new Promise(() => {}),
        transformCallback: () => 1,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#root main")).toBeVisible();
  await expect(page.getByRole("heading")).toBeVisible();
  expect(errors).toEqual([]);
});
