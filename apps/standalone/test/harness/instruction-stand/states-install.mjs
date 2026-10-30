/* global document */
// The installation and backup instructions' states (MKR-INS-12 install and first start,
// MKR-INS-13 backups and restore). The wizard states run against a host that was never set up;
// the rest open the office on the host PC as its administrator. MKR-INS-12 shows the trial, so
// its frames come from a snapshot seeded with `STAND_TRIAL=1` on a test-keys host (README).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { officeLogin, runWizard } from "./seed.mjs";
import { testLicense } from "./seed-office.mjs";
import { ADMIN, HOST_ADDRESS } from "./site.mjs";
import { clockLibrary, startHost } from "./stand-lib.mjs";

const settle = (page, ms = 700) => page.waitForTimeout(ms);

/** The site's license file, loaded through the host API the way the office loads it. */
async function loadLicense(shell) {
  const token = await officeLogin(shell);
  const license = await shell.request("GET", "/v1/office/license", null, token);
  const file = testLicense(license.body.binding.hostId);
  const loaded = await shell.request("PUT", "/v1/office/license", { file }, token);
  if (loaded.status !== 200) throw new Error(`license: ${loaded.status}`);
}

/**
 * The office on the host PC: the administrator's login, then «Обзор». `licensed` loads the
 * license first: the backup frames (MKR-INS-13) come from MKR-INS-12's trial snapshot and need
 * no trial banner.
 */
async function office(computer, { licensed = false } = {}) {
  const opened = await computer("host", "host");
  const { page } = opened;
  if (licensed) {
    await loadLicense(opened.shell);
    await page.reload();
  }
  await page.getByRole("heading", { name: "Вход в офис" }).waitFor();
  await page.getByLabel("Логин").fill(ADMIN.login);
  await page.getByRole("textbox", { name: "Пароль" }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("heading", { name: "Обзор" }).waitFor();
  await settle(page);
  return opened;
}

/** The section `name` from the side menu. */
async function section(page, name, heading = name) {
  await page
    .getByRole("navigation", { name: "Разделы офиса" })
    .getByRole("link", { name, exact: true })
    .click();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  await settle(page);
}

/** Scrolls heading `name` to the top of the page. */
async function scrollToHeading(page, name) {
  await page.getByRole("heading", { name, exact: true }).first().scrollIntoViewIfNeeded();
  await page
    .getByRole("heading", { name, exact: true })
    .first()
    .evaluate((node) => {
      node.scrollIntoView({ block: "start" });
    });
  await settle(page, 400);
}

/** Where the installed host keeps its copies (`standalone-backup-restore.md`, section 1). */
const WINDOWS_BACKUPS = "C:\\ProgramData\\Markiro\\Host\\backups";

/**
 * «Резервные копии». The host names the stand's own temporary folder; the frame shows the
 * folder an installed host uses on Windows.
 */
async function backupsPage(page) {
  await section(page, "Резервные копии");
  await page
    .getByText(/\/work\/host\/backups$/)
    .first()
    .waitFor();
  await page.evaluate((folder) => {
    for (const node of document.querySelectorAll("dd, p, span")) {
      if (node.children.length === 0 && /\/work\/host\/backups$/.test(node.textContent ?? ""))
        node.textContent = folder;
    }
  }, WINDOWS_BACKUPS);
}

/** One wizard step of a host that was never set up. */
const wizardStep = (title, stopAt) => ({
  title,
  empty: true,
  async run({ computer, shoot }) {
    const { page } = await computer("host", "host");
    await runWizard(page, { stopAt });
    await settle(page, 400);
    await shoot(page);
  },
});

/** One office state on the host PC: login, `steps`, shoot. */
const officeState = (title, steps, options = {}) => ({
  title,
  async run({ computer, shoot }) {
    const opened = await office(computer, options);
    await steps(opened.page, opened);
    await shoot(opened.page);
  },
});

/** The same with the license loaded (MKR-INS-13). */
const licensedState = (title, steps) => officeState(title, steps, { licensed: true });

/** «Информация», scrolled to «Лицензия». */
async function licenseSection(page) {
  await section(page, "Информация");
  await scrollToHeading(page, "Лицензия");
}

/** A test-signed license file for this host in a temporary folder (`seed-office.mjs`). */
async function licenseFile(opened) {
  const token = await officeLogin(opened.shell);
  const answer = await opened.shell.request("GET", "/v1/office/license", null, token);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "stand-license-")), "markiro.mklic");
  writeFileSync(file, testLicense(answer.body.binding.hostId));
  return file;
}

/** The license file chosen in «Загрузка файла лицензии»: the preview «Было → станет». */
async function chooseLicense(page, opened) {
  await licenseSection(page);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(await licenseFile(opened));
  await page.getByRole("heading", { name: "Было → станет" }).waitFor();
  await page.getByRole("heading", { name: "Было → станет" }).evaluate((node) => {
    node.scrollIntoView({ block: "center" });
  });
  await settle(page);
}

/** The stand's folders, as `stand.mjs` lays them out. */
const standRoot = () =>
  process.env.STAND_ROOT ?? path.join(process.env.TMPDIR ?? "/tmp", "markiro-instruction-stand");

/** `markiro-host restore` of the newest copy in the host's own folder, the host stopped. */
async function restoreNewestCopy(host) {
  const dataDir = path.join(standRoot(), "work", "host");
  const backups = path.join(dataDir, "backups");
  const copy = readdirSync(backups)
    .filter((name) => name.startsWith("markiro-host-") && name.endsWith(".db"))
    .sort()
    .at(-1);
  if (copy === undefined) throw new Error(`no copy in ${backups}`);
  await host.stop();
  const binary = process.env.STAND_HOST_BINARY;
  const { captureAt } = JSON.parse(
    readFileSync(path.join(standRoot(), "snapshot", "seeded.json"), "utf8"),
  );
  // The restore stamps its hold with the stand's time, as the host does (`stand-clock.c`).
  const env = {
    ...process.env,
    DYLD_INSERT_LIBRARIES: clockLibrary(standRoot()),
    STAND_CLOCK_OFFSET: String(Math.round((Date.parse(captureAt) - Date.now()) / 1000)),
  };
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ["restore", path.join(backups, copy), "--data-dir", dataDir], {
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`restore exited ${code}: ${stderr}`)),
    );
  });
  return startHost({
    dataDir,
    port: host.connect.port,
    clockAt: new Date(captureAt),
    cacheDir: standRoot(),
    binary,
  });
}

export const INSTALL_STATES = {
  "ins12/wizard-org": wizardStep("Первый запуск, шаг 2: организация", "org"),
  "ins12/wizard-sscc": wizardStep("Первый запуск, шаг 3: номера SSCC", "sscc"),
  "ins12/wizard-lines": wizardStep("Первый запуск, шаг 4: линии", "lines"),
  "ins12/wizard-address": wizardStep("Первый запуск, шаг 5: адрес хоста", "address"),
  "ins12/office-login": {
    title: "ПК хоста после мастера: вход в офис",
    async run({ computer, shoot }) {
      const { page } = await computer("host", "host");
      await page.getByRole("heading", { name: "Вход в офис" }).waitFor();
      await page.getByLabel("Логин").fill(ADMIN.login);
      await settle(page);
      await shoot(page);
    },
  },
  "ins12/overview-trial": officeState("Офис: обзор в пробный период", async () => {}),
  "ins12/devices-pairing": officeState("Офис: подключение устройства", async (page) => {
    await section(page, "Устройства");
    await page.getByRole("button", { name: "Подключить устройство" }).click();
    await page.getByRole("dialog").getByText("Код подключения", { exact: true }).waitFor();
    await settle(page, 1200);
    // The host lists this Mac's own addresses; the frame shows the stand's fixed one.
    await page
      .getByRole("dialog")
      .locator("dd.font-mono")
      .filter({ hasText: /:\d+/ })
      .evaluate(
        (node, address) => {
          node.textContent = address;
        },
        `${new URL(HOST_ADDRESS).hostname}:45710`,
      );
  }),
  "ins12/license-trial": officeState("Офис: лицензия в пробный период", licenseSection),
  "ins12/license-preview": officeState(
    "Офис: файл лицензии выбран, «Было → станет»",
    chooseLicense,
  ),
  "ins12/license-loaded": officeState("Офис: лицензия загружена", async (page, opened) => {
    await chooseLicense(page, opened);
    await page.getByRole("button", { name: "Загрузить", exact: true }).click();
    await page
      .getByText(/Лицензия загружена/)
      .first()
      .waitFor();
    await licenseSection(page);
  }),
  "ins12/update": officeState("Офис: обновление из файла", async (page) => {
    await section(page, "Информация");
    await scrollToHeading(page, "Обновление");
  }),
  "ins13/backups": licensedState("Офис: резервные копии", async (page) => {
    await backupsPage(page);
  }),
  "ins13/backup-now": licensedState("Офис: копия сделана по кнопке", async (page) => {
    await backupsPage(page);
    await page.getByRole("button", { name: "Сделать копию сейчас" }).click();
    await page.getByText("Копия сделана и проверена.").waitFor({ timeout: 30_000 });
    await settle(page);
  }),
  "ins13/second-folder": licensedState("Офис: вторая папка для копий", async (page) => {
    await backupsPage(page);
    await page.getByLabel("Путь ко второй папке").fill("\\\\ПК-АДМИНИСТРАТОРА\\Копии");
    await page.getByLabel("Путь ко второй папке").evaluate((node) => {
      node.scrollIntoView({ block: "center" });
    });
    await page.getByLabel("Путь ко второй папке").blur();
    await settle(page);
  }),
  "ins13/yandex": licensedState("Офис: Яндекс Диск", async (page) => {
    await backupsPage(page);
    await scrollToHeading(page, "Яндекс Диск");
  }),
  "ins13/restore-help": licensedState("Офис: как восстановить копию", async (page) => {
    await backupsPage(page);
    await scrollToHeading(page, "Восстановление");
  }),
  "ins13/hold": {
    title: "Офис после восстановления: приём данных станций остановлен",
    async run({ computer, host, shoot }) {
      const restored = await restoreNewestCopy(host);
      try {
        const opened = await office(computer, { licensed: true });
        await backupsPage(opened.page);
        await opened.page.getByText("Приём данных станций остановлен").first().waitFor();
        await settle(opened.page);
        await shoot(opened.page);
      } finally {
        await restored.stop();
      }
    },
  },
  "ins13/hold-confirm": {
    title: "Офис после восстановления: подтверждение возобновления приёма",
    async run({ computer, host, shoot }) {
      const restored = await restoreNewestCopy(host);
      try {
        const opened = await office(computer, { licensed: true });
        await backupsPage(opened.page);
        await opened.page.getByRole("button", { name: "Возобновить приём данных станций" }).click();
        await opened.page.getByText("Возобновить приём данных станций?").waitFor();
        await settle(opened.page);
        await shoot(opened.page);
      } finally {
        await restored.stop();
      }
    },
  },
};
