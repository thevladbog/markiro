// Boxes for the handheld's warehouse pallet (MKR-INS-14), made against the host `tsd.mjs serve`
// keeps running: a pallet-less shift of «Вода «Родник» газ. 1,5 л» on line 1, which the line 1
// station opens after leaving OCT26-001, scanning three full boxes of six. A warehouse pallet
// takes only boxes that are on no pallet, and the seed's shift puts every box on its own.
//   node tsd-boxes.mjs [--host-port 45710] [--vite-url http://127.0.0.1:5274/]
import path from "node:path";
import { parseArgs } from "node:util";

import { officeLogin } from "./seed.mjs";
import { HOST_ADDRESS, markingCode, OPERATORS, PRODUCTION_DATE, PRODUCTS } from "./site.mjs";
import { loadChromium, openComputer } from "./stand-lib.mjs";
import { scan, shiftCard } from "./states.mjs";

const { values } = parseArgs({
  options: {
    "host-port": { type: "string", default: "45710" },
    "vite-url": { type: "string", default: "http://127.0.0.1:5274/" },
    // A later run goes on in the shift the first one made (the list pages past five shifts).
    shift: { type: "string" },
    from: { type: "string", default: "1001" },
  },
});
const root =
  process.env.STAND_ROOT ?? path.join(process.env.TMPDIR ?? "/tmp", "markiro-instruction-stand");
const stateDir = path.join(root, "work", "devices");
// The host `tsd.mjs serve` runs keeps its data, and so its certificate, in work/host.
const connect = {
  host: "127.0.0.1",
  port: Number(values["host-port"]),
  certFile: path.join(root, "work", "host", "tls", "cert.der"),
};
const product = PRODUCTS[1];
const BOXES = 3;

const browser = await loadChromium().launch();
const open = (name, role, openPage) =>
  openComputer(browser, {
    name,
    role,
    connect,
    displayAddress: HOST_ADDRESS,
    stateDir,
    url: values["vite-url"],
    openPage,
    log: (line) => {
      if (/pageerror/.test(line)) console.log(line);
    },
  });
try {
  const host = await open("host", "host", false);
  const token = await officeLogin(host.shell);
  const call = async (method, route, body) => {
    const answer = await host.shell.request(method, route, body ?? null, token);
    if (answer.status < 200 || answer.status >= 300)
      throw new Error(`${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  let number = values.shift;
  if (number === undefined) {
    const lines = await call("GET", "/v1/office/lines");
    const products = await call("GET", "/v1/office/products");
    const templates = await call("GET", "/v1/office/templates");
    const list = (value) => (Array.isArray(value) ? value : (value.items ?? value.products ?? []));
    const box = list(templates).find(
      (template) => template.purpose === "box" && template.name === "Коробка 100×100",
    );
    const line = list(lines)[0];
    const item = list(products).find((entry) => entry.gtin14 === product.gtin14);
    const shift = await call("POST", "/v1/office/shifts", {
      productId: item.id,
      lineId: line.id,
      productionDate: PRODUCTION_DATE,
      plannedDate: PRODUCTION_DATE,
      boxTemplateId: box.id,
      mode: "aggregation",
      plannedQty: 600,
    });
    number = shift.number;
  }
  console.log(`shift ${number}`);
  await host.close();

  const station = await open("station-1", "station", true);
  const { page } = station;
  await page.getByText("Отсканируйте бейдж").waitFor();
  await page.waitForTimeout(1500);
  await scan(page, OPERATORS[0].badge);
  // The station opens on the shift it works, or on its list.
  await page
    .getByRole("button", { name: "Выйти из смены" })
    .or(page.getByRole("heading", { name: "Смены линии" }))
    .first()
    .waitFor();
  const working = page.getByText(number, { exact: false }).first();
  if (await page.getByRole("button", { name: "Выйти из смены" }).isVisible()) {
    if (!(await working.isVisible())) {
      await page.getByRole("button", { name: "Выйти из смены" }).click();
      await page.getByRole("heading", { name: "Смены линии" }).waitFor({ timeout: 30_000 });
    }
  }
  if (await page.getByRole("heading", { name: "Смены линии" }).isVisible()) {
    await page.waitForTimeout(800);
    await shiftCard(page, number)
      .getByRole("button", { name: /^(Открыть|Продолжить)$/ })
      .click();
  }
  await page.getByText("Отсканируйте код маркировки.").waitFor();
  await page.waitForTimeout(800);
  for (let n = 1; n <= BOXES * product.boxCapacity; n += 1)
    await scan(page, markingCode(product.gtin14, Number(values.from) + n - 1));
  // The facts reach the host before the station goes.
  await page.waitForTimeout(3000);
  await station.close();
} finally {
  await browser.close();
}
