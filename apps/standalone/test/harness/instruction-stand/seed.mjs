// Builds the stand's site from nothing, the way a site gets it: the host's wizard in the
// webview, then the office's records through the host API (PINs and badges hashed by the
// webview's own `lib/credentials.ts`), then a station paired by code that opens a shift and
// scans. The result is a snapshot (`<snapshot>/host`, `<snapshot>/devices`) every capture
// starts from.
import { readFileSync } from "node:fs";

import {
  ADMIN,
  LINES,
  NEXT_DATE,
  OPERATORS,
  ORG,
  PRODUCTION_DATE,
  PRODUCTS,
  STATION,
} from "./site.mjs";

const next = async (page) => {
  await page.getByRole("button", { name: "Далее" }).click();
  await page.waitForTimeout(300);
};

/** The host's first start: the six steps of «Первый запуск», without demo data. */
export async function runWizard(page, { stopAt } = {}) {
  await page.getByLabel("Имя и фамилия").waitFor();
  if (stopAt === "admin") return;
  await page.getByLabel("Имя и фамилия").fill(ADMIN.name);
  await page.getByLabel("Пароль", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Повторите пароль").fill(ADMIN.password);
  await next(page);
  if (stopAt === "org-empty") return;
  await page.getByLabel("Название организации").fill(ORG.name);
  await page.getByLabel("ИНН").fill(ORG.inn);
  await page.getByLabel("GLN организации").fill(ORG.gln);
  if (stopAt === "org") return;
  await next(page);
  if (stopAt === "sscc") return;
  await next(page);
  await page.getByLabel("Линия 1").fill(LINES[0]);
  for (let index = 1; index < LINES.length; index += 1) {
    await page.getByRole("button", { name: "Добавить линию" }).click();
    await page.getByLabel(`Линия ${index + 1}`).fill(LINES[index]);
  }
  if (stopAt === "lines") return;
  await next(page);
  await page.getByLabel("Я зарезервировал адрес (или задал статический)").check();
  if (stopAt === "address") return;
  await next(page);
  // The demo set is on by default; the stand's site is a real one.
  await page.getByLabel("Установить демо-данные").uncheck();
  if (stopAt === "review") return;
  await page.getByRole("button", { name: "Создать" }).click();
}

async function api(shell, token, method, path, body) {
  const answer = await shell.request(method, path, body ?? null, token);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${method} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer.body;
}

export async function officeLogin(shell) {
  return (
    await api(shell, undefined, "POST", "/v1/office/login", {
      login: ADMIN.login,
      password: ADMIN.password,
    })
  ).token;
}

/** Hashes with the webview's own module, as the office dialogs do. */
async function hashInPage(page, kind, value, salt) {
  return page.evaluate(
    async ([kind, value, salt]) => {
      const credentials = await import("/src/lib/credentials.ts");
      return kind === "pin" ? credentials.hashPin(value) : credentials.hashBadge(value, salt);
    },
    [kind, value, salt],
  );
}

/** The catalog, the staff and the planned shifts. */
export async function seedOffice({ page, shell }) {
  const token = await officeLogin(shell);
  const lines = await api(shell, token, "GET", "/v1/office/lines");
  const templates = await api(shell, token, "GET", "/v1/office/templates");
  const boxTemplate = templates.find(
    (template) => template.purpose === "box" && template.name === "Коробка 100×100",
  );
  const palletTemplate = templates.find((template) => template.purpose === "pallet");
  if (!boxTemplate || !palletTemplate) throw new Error("the wizard's stock templates are missing");

  const products = {};
  for (const { key, photo, ...product } of PRODUCTS) {
    products[key] = await api(shell, token, "POST", "/v1/office/products", product);
    if (photo) {
      // The host's own 480×480 bottle (`host/assets/demo-product.png`): a water product's look.
      const bytes = readFileSync(new URL("../../../host/assets/demo-product.png", import.meta.url));
      await api(shell, token, "PUT", `/v1/office/products/${products[key].id}/photo`, {
        width: 480,
        height: 480,
        dataBase64: bytes.toString("base64"),
      });
    }
  }

  const { badgeSalt } = await api(shell, token, "GET", "/v1/office/badge-salt");
  for (const operator of OPERATORS) {
    const created = await api(shell, token, "POST", "/v1/office/operators", {
      login: operator.login,
      name: operator.name,
      role: operator.role,
      pinPhc: await hashInPage(page, "pin", operator.pin),
    });
    if (operator.badge) {
      await api(shell, token, "POST", `/v1/office/operators/${created.id}/badges`, {
        badgePhc: await hashInPage(page, "badge", operator.badge, badgeSalt),
        label: "Бейдж",
      });
    }
  }

  const shift = (product, line, plannedDate, extra = {}) =>
    api(shell, token, "POST", "/v1/office/shifts", {
      productId: products[product].id,
      lineId: lines[line].id,
      productionDate: plannedDate,
      plannedDate,
      boxTemplateId: boxTemplate.id,
      mode: "aggregation",
      ...extra,
    });
  const today = await shift("still05", 0, PRODUCTION_DATE, {
    plannedQty: 2400,
    palletsEnabled: true,
    palletTemplateId: palletTemplate.id,
  });
  await shift("sparkling15", 1, PRODUCTION_DATE, { plannedQty: 1200 });
  await shift("kids033", 0, NEXT_DATE, { plannedQty: 4800 });
  return { token, lines, products, todayShift: today };
}

/** A one-time code from the office, claimed by the station's shell, and the station's line. */
export async function pairStation({ hostShell, token, stationShell, lines }) {
  const code = await api(hostShell, token, "POST", "/v1/office/pairing-codes", {});
  await stationShell.handle("host_claim", {
    address: stationShell.displayAddress,
    fingerprint: hostShell.device.fingerprint,
    code: code.code,
    name: STATION.name,
  });
  await stationShell.handle("device_select_line", { lineId: lines[STATION.line].id });
}
