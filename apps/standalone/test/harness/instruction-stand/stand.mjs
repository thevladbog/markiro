/* global document */
// The instruction stand's entry point (see README.md).
//   node stand.mjs seed [--snapshot <dir>]                 build the site once
//   node stand.mjs capture [--out <dir>] [state …]         shoot states (all by default)
//   node stand.mjs list                                    list the states
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { BROWSER_TIME, HOST_ADDRESS } from "./site.mjs";
import { loadChromium, openComputer, startHost, startVite } from "./stand-lib.mjs";
import { pairStation, runWizard, seedOffice } from "./seed.mjs";
import { seedOfficeExtras } from "./seed-office.mjs";
import { STATES, seedStationWork } from "./states.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    snapshot: { type: "string" },
    out: { type: "string" },
    "host-port": { type: "string", default: "45710" },
    "vite-port": { type: "string", default: "5274" },
    verbose: { type: "boolean", default: false },
  },
});
const [command = "capture", ...requested] = positionals;
// `STAND_ROOT` keeps two stands on one machine apart (with `--host-port` and `--vite-port`).
const root =
  process.env.STAND_ROOT ?? path.join(process.env.TMPDIR ?? "/tmp", "markiro-instruction-stand");
const snapshot = path.resolve(values.snapshot ?? path.join(root, "snapshot"));
const out = path.resolve(values.out ?? path.join(root, "frames"));
const work = path.join(root, "work");
const hostPort = Number(values["host-port"]);
const log = (line) => {
  if (values.verbose || /pageerror|unhandled/.test(line)) console.log(line);
};

if (command === "list") {
  for (const [name, state] of Object.entries(STATES))
    console.log(`${name.padEnd(32)} ${state.title}`);
  process.exit(0);
}
if (command !== "seed" && command !== "capture") {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
const names = requested.length > 0 ? requested : Object.keys(STATES);
for (const name of command === "capture" ? names : []) {
  if (!(name in STATES)) throw new Error(`unknown state ${name}; see \`node stand.mjs list\``);
}
if (command === "capture" && !existsSync(snapshot)) {
  throw new Error(`no snapshot at ${snapshot}: run \`node stand.mjs seed\` first`);
}

const chromium = loadChromium();
/** What to stop, last started first. */
const stack = [];
async function unwind(until = 0) {
  while (stack.length > until)
    await stack
      .pop()()
      .catch(() => {});
}
process.on("SIGINT", () => void unwind().then(() => process.exit(130)));

/** A fresh copy of `from` as the run's data, or nothing. */
function prepareWork(from) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  if (from) cpSync(from, work, { recursive: true });
}

/** The host over the run's data, and a way to open the site's computers against it. */
async function site({ empty = false, clockAt, browserClock }) {
  const host = await startHost({
    dataDir: path.join(work, empty ? "empty-host" : "host"),
    port: hostPort,
    clockAt,
    cacheDir: root,
    // A host built with `--features markiro-proto/test-keys` trusts the seed's test license.
    ...(process.env.STAND_HOST_BINARY ? { binary: process.env.STAND_HOST_BINARY } : {}),
  });
  stack.push(host.stop);
  const pages = [];
  const computer = async (name, role, options = {}) => {
    const opened = await openComputer(browser, {
      name: empty ? `${name}-empty` : name,
      role,
      connect: host.connect,
      displayAddress: HOST_ADDRESS,
      stateDir: path.join(work, "devices"),
      url: vite.url,
      log,
      ...browserClock,
      ...options,
    });
    stack.push(() => opened.close());
    pages.push(opened.page);
    return opened;
  };
  return { host, computer, pages };
}

const vite = await startVite({ port: Number(values["vite-port"]) });
stack.push(vite.stop);
const browser = await chromium.launch();
stack.push(() => browser.close());

try {
  if (command === "seed") {
    prepareWork(null);
    const at = new Date(BROWSER_TIME);
    const startedAt = Date.now();
    const mark = stack.length;
    const { computer } = await site({ clockAt: at, browserClock: { clock: at } });
    const host = await computer("host", "host");
    await runWizard(host.page);
    await host.page.getByRole("heading", { name: "Обзор" }).waitFor({ timeout: 30_000 });
    const seeded = await seedOffice({ page: host.page, shell: host.shell });
    await seedOfficeExtras({ shell: host.shell, token: seeded.token });
    const station = await computer("station-1", "station", { openPage: false });
    await pairStation({
      hostShell: host.shell,
      token: seeded.token,
      stationShell: station.shell,
      lines: seeded.lines,
    });
    await station.open();
    await seedStationWork({ station, seeded });
    // The stand's time when the seed ended: frames are shot a minute later, on the next whole
    // minute, so the office sees the station as just heard from.
    const ended = at.getTime() + (Date.now() - startedAt);
    const captureAt = new Date(Math.ceil((ended + 60_000) / 60_000) * 60_000);
    await unwind(mark);
    rmSync(snapshot, { recursive: true, force: true });
    mkdirSync(path.dirname(snapshot), { recursive: true });
    cpSync(work, snapshot, { recursive: true });
    writeFileSync(
      path.join(snapshot, "seeded.json"),
      JSON.stringify(
        {
          seededAt: new Date().toISOString(),
          standStart: BROWSER_TIME,
          captureAt: captureAt.toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`snapshot ${snapshot}`);
  } else {
    mkdirSync(out, { recursive: true });
    const at = new Date(
      JSON.parse(readFileSync(path.join(snapshot, "seeded.json"), "utf8")).captureAt,
    );
    // Every state starts from the snapshot, so no state sees what another one did.
    for (const name of names) {
      const state = STATES[name];
      prepareWork(snapshot);
      const mark = stack.length;
      const opened = await site({
        empty: state.empty === true,
        clockAt: at,
        browserClock: { fixedClock: at },
      });
      const file = path.join(out, `${name.replaceAll("/", "--")}.png`);
      try {
        await state.run({
          host: opened.host,
          computer: opened.computer,
          shoot: (page) => shoot(page, file),
        });
      } catch (error) {
        // What the screen showed when the state went wrong, beside the frames.
        for (const [index, page] of opened.pages.entries()) {
          const failed = file.replace(/\.png$/, `.failed-${index}.png`);
          await page.screenshot({ path: failed }).catch(() => {});
          console.error(`${name}: failed; the screen is in ${failed}`);
          if (values.verbose)
            console.error(
              (
                await page
                  .locator("body")
                  .innerText()
                  .catch(() => "")
              ).slice(0, 3000),
            );
        }
        throw error;
      }
      await unwind(mark);
      console.log(`${name} -> ${file}`);
    }
  }
} finally {
  await unwind();
}

/** The frame: fonts loaded, nothing moving, the caret hidden. */
async function shoot(page, file) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}",
  });
  // Settled: two screenshots half a second apart agree (a slow fade would differ).
  let previous = await page.screenshot({ animations: "disabled" });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(500);
    const current = await page.screenshot({ animations: "disabled" });
    if (current.equals(previous)) break;
    previous = current;
  }
  writeFileSync(file, previous);
}
