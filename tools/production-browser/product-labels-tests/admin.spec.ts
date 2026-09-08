import { expect, test, type Page } from "@playwright/test";
import {
  buildDuplicateLabelTemplate,
  productLabelValueDigest,
} from "../../../packages/domain/dist/index.js";
const origin = "http://127.0.0.1:43181";
const productId = "11111111-1111-4111-8111-111111111111",
  shiftId = "22222222-2222-4222-8222-222222222222",
  templateId = "33333333-3333-4333-8333-333333333333",
  deviceId = "44444444-4444-4444-8444-444444444444",
  jobId = "55555555-5555-4555-8555-555555555555";
const product = {
  id: productId,
  gtin14: "04600000000015",
  name: "Кега светлого пива, 30 л",
  productGroup: null,
  chzProductGroupCode: 15,
  boxCapacity: null,
  palletCapacity: null,
  unitPrice: null,
  printName: null,
  egaisCode: null,
  shelfLifeDays: 30,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  image: null,
};
const template = { id: templateId, name: "Дубликат 58×40", spec: buildDuplicateLabelTemplate() };
const active = {
  id: shiftId,
  number: "SEP26-001",
  status: "active",
  mode: "validation",
  productId,
  productName: product.name,
  lineId: null,
  lineName: null,
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: 120,
  plannedDate: "2026-09-08",
  productionDate: "2026-09-08",
  boxCapacity: null,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: "2026-09-08T10:00:00.000Z",
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  validationPrint: {
    mode: "duplicate_dm",
    verification: "required",
    templateId,
    snapshot: { ...template, digest: productLabelValueDigest(template) },
    policyRevision: "66666666-6666-4666-8666-666666666666",
  },
};
async function setup(page: Page, language = "ru", theme = "light") {
  const unexpected: string[] = [];
  const writes: unknown[] = [];
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem("i18nextLng", language);
      localStorage.setItem("markiro.theme", theme);
    },
    { language, theme },
  );
  await page.route(`${origin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/profile")
      body = { firstName: "Мария", middleName: null, lastName: "Волкова", hasAvatar: false };
    else if (path === "/api/access/me")
      body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
    else if (path === "/api/pickup-orders") body = { items: [] };
    else if (path === "/api/products") body = { items: [product] };
    else if (["/api/lines", "/api/counterparties", "/api/label-templates"].includes(path))
      body = { items: [] };
    else if (path === "/api/shifts/planning-config")
      body = {
        defaultBoxLabelTemplateId: null,
        validationPrintProtocol: "validation-dm-duplicate-v1",
      };
    else if (path === "/api/shifts/product-label-templates")
      body = {
        items: [{ id: templateId, name: template.name, widthMm: 58, heightMm: 40, dpi: 203 }],
      };
    else if (path === "/api/shifts") {
      if (route.request().method() === "POST") {
        writes.push(route.request().postDataJSON());
        body = { ...active, status: "planned" };
      } else body = { items: [active] };
    } else if (path === `/api/shifts/${shiftId}/summary`)
      body = {
        generatedAt: active.openedAt,
        output: { mode: "validation", acceptedUnits: 1 },
        participants: [],
        unattributed: { eventCount: 0, acceptedScans: 0, closedBoxes: 0 },
      };
    else if (path === `/api/shifts/${shiftId}/product-labels`)
      body = {
        summary: { sentAttempts: 2, verifiedAttempts: 1, unresolvedJobs: 0, reprintAttempts: 1 },
        items: [
          {
            jobId,
            deviceId,
            codeSuffix: "IAL-42",
            acceptedAt: active.openedAt,
            status: "completed",
            verificationOutcome: "verified",
            attemptNo: 2,
            ownershipConflict: false,
          },
        ],
        nextCursor: null,
      };
    else {
      unexpected.push(`${route.request().method()} ${path}`);
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  return { unexpected, writes };
}
async function open(page: Page, route: string, language = "ru") {
  await page.goto(
    `${origin}/test/browser/product-labels.html?route=${encodeURIComponent(route)}&locale=${language}`,
  );
}
for (const language of ["ru", "en"])
  for (const theme of ["light", "dark"])
    test(`admin duplicate settings use the existing desktop panel ${language} ${theme}`, async ({
      page,
    }, info) => {
      const { unexpected } = await setup(page, language, theme);
      await open(page, "/shifts/new", language);
      await page
        .getByRole("radio", { name: language === "ru" ? "Валидация" : "Validation", exact: true })
        .check();
      await page
        .getByRole("combobox", { name: language === "ru" ? "Продукт" : "Product", exact: true })
        .click();
      await page.getByRole("option", { name: product.name, exact: true }).click();
      const duplicate = page.getByRole("radio", {
        name: language === "ru" ? "Дублировать Data Matrix" : "Duplicate Data Matrix",
        exact: true,
      });
      await duplicate.check();
      const checkbox = page.getByRole("checkbox", {
        name: language === "ru" ? "Обязательная проверка этикетки" : "Require label verification",
        exact: true,
      });
      await expect(checkbox).toBeChecked();
      await checkbox.uncheck();
      await expect(checkbox).not.toBeChecked();
      await expect(
        page.getByText(
          language === "ru"
            ? "После отправки на принтер можно сканировать следующую единицу"
            : "After sending to the printer, the next unit can be scanned",
          { exact: true },
        ),
      ).toBeVisible();
      await checkbox.check();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`admin-create-${language}-${theme}.png`) });
      expect(unexpected).toEqual([]);
    });
test("admin freezes active policy and shows distinct production and label totals", async ({
  page,
}, info) => {
  const { unexpected } = await setup(page);
  await open(page, `/shifts/${shiftId}/edit`);
  await expect(
    page.getByRole("checkbox", { name: "Обязательная проверка этикетки", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("radio", { name: "Дублировать Data Matrix", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: info.outputPath("admin-active-policy.png") });
  await open(page, `/shifts/${shiftId}`);
  await expect(page.getByText("…IAL-42", { exact: true })).toBeVisible();
  await expect(page.getByText("Отправки на принтер", { exact: true })).toBeVisible();
  await expect(page.getByText("Проверенные этикетки", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("admin-history.png") });
  expect(unexpected).toEqual([]);
});

for (const verification of ["required", "none", "off"])
  test(`admin saves ${verification} verification through the actual form and mock API`, async ({
    page,
  }, info) => {
    const { unexpected, writes } = await setup(page);
    await open(page, "/shifts/new");
    await page.getByRole("combobox", { name: "Продукт", exact: true }).click();
    await page.getByRole("option", { name: product.name, exact: true }).click();
    await page.getByRole("radio", { name: "Валидация", exact: true }).check();
    if (verification !== "off") {
      await page.getByRole("radio", { name: "Дублировать Data Matrix", exact: true }).check();
      await page.getByRole("combobox", { name: "Шаблон этикетки продукции", exact: true }).click();
      await page.getByRole("option", { name: /Дубликат 58×40/ }).click();
      if (verification === "none")
        await page
          .getByRole("checkbox", { name: "Обязательная проверка этикетки", exact: true })
          .uncheck();
    }
    await page.screenshot({ path: info.outputPath(`admin-ready-${verification}.png`) });
    await page.getByRole("button", { name: "Запланировать", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      mode: "validation",
      productId,
      validationPrint:
        verification === "off"
          ? { mode: "none" }
          : { mode: "duplicate_dm", verification, templateId },
    });
    expect(unexpected).toEqual([]);
  });
