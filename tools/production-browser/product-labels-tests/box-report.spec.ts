import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const renderer = fileURLToPath(
  new URL("../../../apps/admin/test/browser/box-report-render.mjs", import.meta.url),
);

const origin = "http://127.0.0.1:43181";
const box = {
  id: "00000000-0000-4000-8000-000000000321",
  sscc: "00123456789012345675",
  status: "disassembled" as const,
  shiftId: "00000000-0000-4000-8000-000000000123",
  shiftNumber: "SEP26-003/S",
  productId: "00000000-0000-4000-8000-000000000222",
  productName: "Молоко 1л",
  terminalId: null,
  operatorId: null,
  openedAt: "2026-09-09T21:58:00.000Z",
  closedAt: "2026-09-09T22:08:00.000Z",
  disassembledAt: "2026-09-09T23:08:00.000Z",
  items: [],
  exceptions: [],
  pickupOrders: [],
};

for (const sample of [
  {
    timeZone: "Europe/Moscow",
    date: "10.09.2026",
    opened: "00:58",
    closed: "01:08",
    disassembled: "02:08",
  },
  {
    timeZone: "Asia/Vladivostok",
    date: "10.09.2026",
    opened: "07:58",
    closed: "08:08",
    disassembled: "09:08",
  },
  {
    timeZone: "America/New_York",
    date: "09.09.2026",
    opened: "17:58",
    closed: "18:08",
    disassembled: "19:08",
  },
]) {
  test.describe(sample.timeZone, () => {
    test.use({
      timezoneId: sample.timeZone,
      locale: "ru-RU",
      viewport: { width: 1280, height: 900 },
    });

    test("box card and its print tab show the same lifecycle dates across midnight", async ({
      context,
      page,
    }, testInfo) => {
      const errors: string[] = [];
      context.on("weberror", (error) => errors.push(error.error().message));
      await context.addInitScript(() => {
        localStorage.setItem("i18nextLng", "ru");
        localStorage.setItem("markiro.theme", "light");
      });
      await context.route(`${origin}/api/**`, async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET")
          throw new Error(`Unexpected mutation: ${url.pathname}`);
        if (url.pathname === `/api/code-search/boxes/${box.id}/report`) {
          // Exercise the real server HTML renderer; only the tenant's data read is a fixture.
          await route.fulfill({
            contentType: "text/html",
            body: execFileSync(process.execPath, [renderer], {
              input: JSON.stringify({
                data: {
                  ...box,
                  org: { name: "Демонстрационная организация", inn: null, logo: null },
                  codes: [],
                },
                timeZone: url.searchParams.get("timeZone") ?? "UTC",
              }),
              encoding: "utf8",
            }),
          });
          return;
        }
        let body: unknown;
        if (url.pathname === `/api/code-search/boxes/${box.id}`) body = box;
        else if (url.pathname === "/api/access/me")
          body = { roles: ["manager"], capabilities: ["operations.read"] };
        else if (url.pathname === "/api/profile")
          body = { firstName: "Игорь", lastName: "Волков", middleName: null, hasAvatar: false };
        else if (url.pathname === "/api/pickup-orders") body = { items: [] };
        else throw new Error(`Unexpected request: ${url.pathname}`);
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });

      await page.goto(
        `${origin}/test/browser/national-catalog-harness.html?route=${encodeURIComponent(`/codes/box/${box.id}`)}`,
      );
      for (const time of [sample.opened, sample.closed, sample.disassembled]) {
        await expect(page.getByText(`${sample.date}, ${time}`, { exact: true })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath("box-card.png"), fullPage: true });

      const popup = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Распечатать", exact: true }).click();
      const report = await popup;
      await expect(report).toHaveURL(new RegExp(`timeZone=${encodeURIComponent(sample.timeZone)}`));
      await expect(report.locator(".rep-title-detail")).toContainText(
        `открыт ${sample.date} ${sample.opened}`,
      );
      const lifecycle = report.locator(".rep-meta-cell").filter({ hasText: "Расформирован" });
      for (const [label, time] of [
        ["открыт", sample.opened],
        ["закрыт", sample.closed],
        ["расформирован", sample.disassembled],
      ]) {
        await expect(lifecycle).toContainText(`${label} ${sample.date} ${time}`);
      }
      await report.emulateMedia({ media: "print" });
      await expect(lifecycle).toBeVisible();
      await report.screenshot({ path: testInfo.outputPath("box-print.png"), fullPage: true });
      expect(errors).toEqual([]);
    });
  });
}
