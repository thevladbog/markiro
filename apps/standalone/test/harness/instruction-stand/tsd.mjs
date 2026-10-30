/* global document */
// The handheld (ТСД) session of the instruction stand (MKR-INS-14). The handheld is the real
// Android app on an emulator, so this script does not drive it: it keeps the site's host running
// on the stand's port for the emulator (`10.0.2.2`) and shoots the office's side of the pairing.
//   STAND_ROOT=… STAND_TIME=<now> node stand.mjs seed      once, near the emulator's clock
//   node tsd.mjs serve [--out <dir>]                        then pair the handheld by hand
// `serve` opens «Устройства» → «Подключить устройство», shoots the code, writes it to
// `<root>/tsd-code.json`, waits until a device joins, shoots the list and keeps the host up
// until it is stopped (Ctrl-C), so the handheld can go on working against it.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ADMIN, HOST_ADDRESS } from "./site.mjs";
import { loadChromium, openComputer, startHost, startVite } from "./stand-lib.mjs";

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "host-port": { type: "string", default: "45710" },
    "vite-port": { type: "string", default: "5274" },
  },
});
const root =
  process.env.STAND_ROOT ?? path.join(process.env.TMPDIR ?? "/tmp", "markiro-instruction-stand");
const snapshot = path.join(root, "snapshot");
const work = path.join(root, "work");
const out = path.resolve(values.out ?? path.join(root, "frames"));
if (!existsSync(snapshot)) throw new Error(`no snapshot at ${snapshot}: run stand.mjs seed`);
rmSync(work, { recursive: true, force: true });
cpSync(snapshot, work, { recursive: true });
mkdirSync(out, { recursive: true });

const stack = [];
const unwind = async () => {
  while (stack.length > 0)
    await stack
      .pop()()
      .catch(() => {});
};
process.on("SIGINT", () => void unwind().then(() => process.exit(0)));
process.on("SIGTERM", () => void unwind().then(() => process.exit(0)));

// The host runs on the real clock: the emulator's clock cannot be moved, and the handheld warns
// when the two differ by more than two minutes.
const host = await startHost({
  dataDir: path.join(work, "host"),
  port: Number(values["host-port"]),
  cacheDir: root,
  ...(process.env.STAND_HOST_BINARY ? { binary: process.env.STAND_HOST_BINARY } : {}),
});
stack.push(host.stop);
const vite = await startVite({ port: Number(values["vite-port"]) });
stack.push(vite.stop);
const browser = await loadChromium().launch();
stack.push(() => browser.close());
const office = await openComputer(browser, {
  name: "host",
  role: "host",
  connect: host.connect,
  displayAddress: HOST_ADDRESS,
  stateDir: path.join(work, "devices"),
  url: vite.url,
  log: (line) => {
    if (/pageerror/.test(line)) console.log(line);
  },
});
stack.push(() => office.close());
const { page } = office;

// The host lists this Mac's own addresses in the code (`h=`); the frame shows the stand's LAN
// address instead, as every other screen does. The handheld is paired by hand against 10.0.2.2.
const standAddress = new URL(HOST_ADDRESS).hostname;
const handle = office.shell.handle.bind(office.shell);
office.shell.handle = async (command, args) => {
  const value = await handle(command, args);
  if (
    command === "host_request" &&
    args?.path === "/v1/office/pairing-codes" &&
    typeof value?.body?.payload === "string"
  )
    value.body.payload = value.body.payload.replace(/([?&]h=)[^&]*/, `$1${standAddress}`);
  return value;
};

async function shoot(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}",
  });
  let previous = await page.screenshot({ animations: "disabled" });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(500);
    const current = await page.screenshot({ animations: "disabled" });
    if (current.equals(previous)) break;
    previous = current;
  }
  const file = path.join(out, `${name}.png`);
  writeFileSync(file, previous);
  console.log(`${name} -> ${file}`);
}

await page.getByRole("heading", { name: "Вход в офис" }).waitFor();
await page.getByLabel("Логин").fill(ADMIN.login);
await page.getByRole("textbox", { name: "Пароль" }).fill(ADMIN.password);
await page.getByRole("button", { name: "Войти" }).click();
await page.getByRole("heading", { name: "Обзор" }).waitFor();
await page
  .getByRole("navigation", { name: "Разделы офиса" })
  .getByRole("link", { name: "Устройства", exact: true })
  .click();
await page.getByRole("heading", { name: "Устройства", exact: true }).waitFor();
await page.waitForTimeout(600);
await shoot("tsd--office-devices-before");
await page.getByRole("button", { name: "Подключить устройство" }).first().click();
const dialog = page.getByRole("dialog");
await dialog.waitFor();
await page.waitForTimeout(1500);
const text = await dialog.innerText();
await shoot("tsd--office-pairing-code");
writeFileSync(path.join(root, "tsd-code.json"), JSON.stringify({ text }, null, 2));
console.log("code dialog:\n" + text);

// The dialog reads the device list every few seconds and says when a device joined.
await page.getByText(/подключено\./).waitFor({ timeout: 30 * 60_000 });
await page.waitForTimeout(800);
await shoot("tsd--office-pairing-joined");
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
await shoot("tsd--office-devices");
console.log("serving; Ctrl-C to stop");
await new Promise(() => {});
