import { commercialDocumentListItemSchema } from "../../../packages/platform-contracts/src/index.js";
import { test, expect, ID, NOW } from "./fixture.js";

declare global {
  interface Window {
    offerDocumentRequestStarts: number;
  }
}

test("pending files stop automatic polling, recover manually and stop on leaving the detail", async ({
  page,
  fixture,
}) => {
  // Fake time is confined to polling. Download activation uses real Chromium time
  // in workspace.spec.ts and must never share this clock setup.
  await page.clock.install();
  await page.addInitScript((offerId) => {
    window.offerDocumentRequestStarts = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname === `/api/platform/offers/${offerId}/documents` && method === "GET") {
        // This increment happens in the timer's fetch call, before Node can
        // receive a route event. Negative assertions cannot race that delivery.
        window.offerDocumentRequestStarts++;
      }
      return originalFetch(input, init);
    };
  }, ID);
  fixture.workspace.offer = {
    ...fixture.workspace.offer,
    status: "published",
    number: "КП-ТЕСТ-0042",
    publishedAt: NOW,
    publishedByPlatformUserId: "fixture-admin",
    paidAt: null,
  };
  fixture.workspace.actions.publish = false;
  fixture.workspace.documents = [
    commercialDocumentListItemSchema.parse({
      id: "b1111111-1111-4111-8111-111111111111",
      revision: 2,
      format: "html",
      printVariant: "clean",
      status: "pending",
      contentType: null,
      byteSize: null,
      sha256: null,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ];
  const reads = () => page.evaluate(() => window.offerDocumentRequestStarts);
  await page.goto(`/offers/${ID}`);
  await expect(
    page.getByText(
      "Формирование занимает больше времени. Обновите состояние или восстановите файлы.",
    ),
  ).toBeVisible();
  await expect.poll(reads).toBe(1);
  const automatic = page.waitForResponse((response) => response.url().endsWith("/documents"));
  await page.clock.fastForward(2100);
  await automatic;
  await expect.poll(reads).toBe(2);
  await expect(page.getByRole("status").filter({ hasText: "Загружаем раздел" })).toHaveCount(0);
  // One already scheduled interval can finish at the cutoff. Settle that actual
  // response before counting further requests, rather than racing route dispatch.
  const cutoff = page.waitForResponse((response) => response.url().endsWith("/documents"));
  await page.clock.fastForward(31_000);
  await cutoff;
  await expect(page.getByRole("status").filter({ hasText: "Загружаем раздел" })).toHaveCount(0);
  const stopped = await reads();
  await page.clock.fastForward(10_000);
  expect(await reads()).toBe(stopped);
  const manual = page.waitForResponse((response) => response.url().endsWith("/documents"));
  await page.getByRole("button", { name: "Обновить состояние файлов" }).click();
  await manual;
  expect(await reads()).toBe(stopped + 1);
  await page.getByRole("link", { name: "К реестру предложений" }).click();
  await expect(page.getByRole("textbox", { name: "Поиск предложений" })).toBeVisible();
  const left = await reads();
  await page.clock.fastForward(10_000);
  expect(await reads()).toBe(left);
});
