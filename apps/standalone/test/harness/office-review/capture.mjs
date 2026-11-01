/* global document, window */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE);
const out = process.env.OFFICE_REVIEW_OUT;
if (!out) throw new Error("Set OFFICE_REVIEW_OUT");
mkdirSync(out, { recursive: true });
const server = await createServer({
  root: resolve(import.meta.dirname, "../../.."),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const address = server.httpServer.address();
if (typeof address !== "object" || !address) throw new Error("No preview port");
const url = `http://127.0.0.1:${address.port}/test/harness/office-review/index.html`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
  colorScheme: "dark",
  reducedMotion: "reduce",
});
const page = await context.newPage();
await page.clock.setFixedTime(new Date("2026-11-01T08:00:00Z"));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const manifest = [];
async function open(path = "/", theme = "dark") {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${url}?${new URLSearchParams({ path, theme })}`);
  await page.getByRole("banner").waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("Загрузка…"));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}
async function shot(name, title) {
  if (errors.length) throw new Error(errors.join("\n"));
  if (await page.getByText(/Не удалось (загрузить|получить)/).count())
    throw new Error(`Failed data block on ${name}`);
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(out, file), fullPage: true, animations: "disabled" });
  manifest.push({ file, title });
  console.log(file);
}
try {
  for (const [name, path, title] of [
    ["01-overview", "/", "Обзор"],
    ["02-shifts", "/shifts", "Смены"],
    ["03-products", "/products", "Товары"],
    ["04-lines", "/lines", "Линии"],
    [
      "05-pallet",
      "/codes/warehouse-pallet/a1000000-0000-4000-8000-000000000001",
      "Карточка палета",
    ],
    ["06-codes", "/codes?period=all", "Поиск кодов"],
  ]) {
    await open(path);
    await page
      .getByRole("heading", {
        name: title === "Карточка палета" ? /Палет \(00\)/ : title,
        exact: title !== "Карточка палета",
        level: 1,
      })
      .waitFor();
    await shot(name, title);
  }
  await open("/products");
  await page.getByRole("button", { name: "Поиск по системе", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Поиск по системе" });
  await search.fill("Молоко");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await page.getByRole("region", { name: "Складские палеты", exact: true }).waitFor();
  await shot("07-global-search", "Поиск из бокового меню");
  await page.keyboard.press("Escape");
  await page.locator(".user-menu__trigger").click();
  await page.getByRole("menuitem", { name: "Выйти в цех", exact: true }).waitFor();
  await shot("08-profile-menu", "Меню профиля");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Настройки сканера", exact: true }).click();
  await page.getByRole("heading", { name: "Сканеры", exact: true }).waitFor();
  await page.getByText("COM3, 9600 бод", { exact: true }).waitFor();
  const setupBox = await page.locator(".office-scanner-dialog .workstation-setup").boundingBox();
  if (!setupBox || setupBox.height < 600)
    throw new Error("Scanner setup collapsed inside Office modal");
  await page.waitForTimeout(200);
  await shot("09-scanner-settings", "Настройки USB/COM-сканеров");
  await page.getByRole("button", { name: "Показать на экране", exact: true }).click();
  await page.getByRole("heading", { name: "Отсканируйте тестовый код", exact: true }).waitFor();
  await shot("10-scanner-test-code", "Тестовый Data Matrix");
  await page.keyboard.press("Escape");
  const code = (await page.getByTestId("self-test-code").first().innerText()).replaceAll(
    "␝",
    "\u001d",
  );
  await page.evaluate((raw) => window.officeReviewEmitScan(raw), code);
  await page.getByTestId("self-test-verdict").waitFor();
  await page.getByTestId("self-test-verdict").scrollIntoViewIfNeeded();
  await shot("11-scanner-test-result", "Результат тестового считывания");

  await open("/", "light");
  await shot("12-overview-light", "Обзор, светлая тема");
  await page.getByRole("button", { name: "Настройки сканера", exact: true }).click();
  await page.getByRole("heading", { name: "Сканеры", exact: true }).waitFor();
  await page.getByText("COM3, 9600 бод", { exact: true }).waitFor();
  await shot("13-scanner-settings-light", "Настройки сканеров, светлая тема");
  await page.getByRole("combobox", { name: "COM-порт", exact: true }).click();
  await page.getByRole("option", { name: "COM4", exact: true }).waitFor();
  await shot("14-scanner-port-select", "Выбор COM-порта");
  await open("/");
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator(".office-menu--collapsed").waitFor();
  await shot("15-collapsed-menu", "Свёрнутое меню");
  await page.getByRole("button", { name: "Поиск по системе", exact: true }).click();
  await page.getByRole("textbox", { name: "Поиск по системе" }).fill("Молоко");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await page.getByRole("region", { name: "Складские палеты", exact: true }).waitFor();
  await shot("16-collapsed-search", "Поиск из свёрнутого меню");
  writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
} catch (error) {
  await page
    .screenshot({ path: resolve(out, "capture-error.png"), fullPage: true })
    .catch(() => {});
  console.error((await page.locator("body").innerText()).slice(0, 4500));
  throw error;
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
