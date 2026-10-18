import assert from "node:assert/strict";
import { fileChecksum } from "../../../../../tools/standalone-export/canonical.mjs";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { SHIFT_EXPORT_FORMATS } from "@markiro/domain";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const fixture = JSON.parse(
  await readFile(
    new URL("../../../proto/fixtures/cloud-history-read.json", import.meta.url),
    "utf8",
  ),
);
const request = fixture.request;
const shift = request.part.payload.shifts[0];
const box = request.part.payload.boxes.find((row) => row.shiftId === shift.id);
const pallet = fixture.palletSources.find((row) => row.pallet.id === box.palletId);
const out = process.env.HISTORY_BROWSER_EVIDENCE ?? "/private/tmp/markiro-task4-browser";
await mkdir(out, { recursive: true });
const server = await createServer({
  root: process.cwd(),
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/test/harness/cloud-history/index.html`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.name));
async function measureReplacement() {
  page.setDefaultTimeout(10_000);
  await page.clock.install();
  await page.goto(url);
  await page.getByRole("heading", { name: "Перенос из облака", exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Заменить существующие данные", exact: true }).check();
  assert.equal(await page.getByRole("button", { name: "Проверить", exact: true }).count(), 0);
  const catalog = await readFile(
    new URL("../../../proto/fixtures/cloud-export-file.json", import.meta.url),
  );
  await page
    .locator('input[type="file"][accept*=".json,"]')
    .setInputFiles({ name: "catalog.json", mimeType: "application/json", buffer: catalog });
  const check = page.getByRole("button", { name: "Проверить", exact: true });
  await check.waitFor();
  assert.equal(await check.isDisabled(), true);
  const historyUpload = await page.evaluate(() => globalThis.window.historyUpload);
  const historyInput = page.locator('input[type="file"][accept*=".jsonl"]');
  await historyInput.setInputFiles({
    name: "truncated.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(historyUpload.split("\n")[0] + "\n"),
  });
  await page
    .getByText("Файл истории не принят. Выберите целую выгрузку истории без изменений.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await check.isDisabled(), true);
  await historyInput.setInputFiles({
    name: "history.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(historyUpload),
  });
  await page.getByText(/История проверена целиком:/).waitFor();
  await check.click();
  await page
    .getByText("Проверка пройдена: перенос запишет то, что ниже.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Заменить данные", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const submit = dialog.getByRole("button", { name: "Заменить данные", exact: true });
  assert.equal(await submit.isDisabled(), true);
  await page.screenshot({ path: resolve(out, "replacement-01-confirmation.png"), fullPage: true });
  await dialog
    .getByRole("checkbox", {
      name: "Работа остановлена на всех станциях; подтверждаю удаление местных данных и очередей",
      exact: true,
    })
    .check();
  await page.clock.runFor(500);
  await submit.click();
  const backupFile = "backups/pre-import/controlled-replacement.db";
  await page.getByText(backupFile, { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "Каталог заменён; история ожидает переноса", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByText("История перенесена. Работа разрешена после завершения импорта.", { exact: true })
      .count(),
    0,
  );
  const beforeRestart = await page.evaluate(() => globalThis.window.historyAcceptance);
  assert.deepEqual(
    beforeRestart.replacements.map((row) => row.dryRun),
    [true, false],
  );
  assert.equal(beforeRestart.replacements[1].expectedRevision, 42);
  assert.equal(
    beforeRestart.routes.filter((route) => route === "POST /v1/office/import/history").length,
    0,
  );
  await page.screenshot({ path: resolve(out, "replacement-02-pending.png"), fullPage: true });
  await page.evaluate(() => globalThis.window.historyRestart());
  await page.getByRole("heading", { name: "История облачных смен", exact: true }).waitFor();
  await page.getByText(backupFile, { exact: true }).waitFor();
  await page.getByText(/После перезапуска снова выберите тот же файл истории/).waitFor();
  await page.screenshot({ path: resolve(out, "replacement-03-resume.png"), fullPage: true });
  await page.locator('input[type="file"][accept*=".jsonl"]').setInputFiles({
    name: "history.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(historyUpload),
  });
  await page.getByRole("button", { name: "Проверить историю", exact: true }).click();
  await page.getByText("Все части проверены. Можно перенести историю.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Продолжить импорт", exact: true }).click();
  await page
    .getByText("История перенесена. Работа разрешена после завершения импорта.", { exact: true })
    .waitFor();
  await page.screenshot({ path: resolve(out, "replacement-04-complete.png"), fullPage: true });
  const metrics = await page.evaluate(() => globalThis.window.historyAcceptance);
  assert.equal(metrics.replacements.length, 2);
  assert.equal(
    metrics.routes.filter((route) => route === "POST /v1/office/import/history/complete").length,
    1,
  );
  assert.deepEqual(errors, []);
  const result = {
    mode: "replacement",
    url,
    evidence: out,
    checks: [
      "missing-files-blocked",
      "truncated-history-blocked",
      "catalog-and-history-check",
      "explicit-destructive-confirmation",
      "checked-revision-submitted",
      "backup-and-pending-without-upload",
      "restart-resume-backup",
      "history-completion-ready",
    ],
    replacements: metrics.replacements,
    pageErrors: errors.length,
  };
  await writeFile(resolve(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
try {
  if (process.env.HISTORY_REPLACEMENT_BROWSER === "1") {
    await measureReplacement();
  } else {
    await page.goto(url);
    await page.getByRole("heading", { name: "История облачных смен", exact: true }).waitFor();
    const upload = await page.evaluate(() => globalThis.window.historyUpload);
    const refusal =
      "Исходный часовой пояс не поддерживается в этой среде. Исторические даты и отчёты недоступны.";
    const lines = upload
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const unsupported = {
      ...lines[0],
      organization: { ...lines[0].organization, timeZone: "Mars/Base" },
    };
    unsupported.checksum = fileChecksum(unsupported);
    await page.locator('input[type="file"][accept*=".jsonl"]').setInputFiles({
      name: "unsupported-history.jsonl",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(
        [unsupported, ...lines.slice(1)].map((line) => JSON.stringify(line)).join("\n") + "\n",
      ),
    });
    await page.getByText(refusal, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Проверить историю", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.window.historyAcceptance.routes.filter(
            (route) => route === "POST /v1/office/import/history",
          ).length,
      ),
      0,
    );
    for (const [kind, id] of [
      ["shifts", shift.id],
      ["boxes", box.id],
      ["pallets", pallet.pallet.id],
    ]) {
      await page.goto(
        `${url}?unsupported-zone=1&start=${encodeURIComponent(`/cloud-${kind}/${id}`)}`,
      );
      await page.getByText(refusal, { exact: true }).waitFor();
      assert.equal(
        await page.getByText("Unexpected Application Error!", { exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole("button", { name: "Выгрузка", exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => globalThis.window.historyAcceptance.saved), 0);
    }
    await page.screenshot({ path: resolve(out, "00-unsupported-source.png"), fullPage: true });
    await page.goto(url);
    await page.getByRole("heading", { name: "История облачных смен", exact: true }).waitFor();
    await page.locator('input[type="file"][accept*=".jsonl"]').setInputFiles({
      name: "history.jsonl",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(upload),
    });
    await page.getByRole("button", { name: "Проверить историю", exact: true }).click();
    await page
      .getByText("Все части проверены. Можно перенести историю.", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Импортировать историю", exact: true }).click();
    await page
      .getByText("История перенесена. Работа разрешена после завершения импорта.", { exact: true })
      .waitFor();
    await page.screenshot({ path: resolve(out, "01-import-complete.png"), fullPage: true });
    await page
      .getByRole("navigation", { name: "Разделы офиса" })
      .getByRole("link", { name: "Смены", exact: true })
      .click();
    await page.getByRole("link", { name: "Облачная история", exact: true }).click();
    await page.getByRole("link", { name: shift.number, exact: true }).click();
    await page
      .getByRole("heading", { name: `Облачная смена ${shift.number}`, exact: true })
      .waitFor();
    await page.screenshot({ path: resolve(out, "02-cloud-shift.png"), fullPage: true });
    for (const format of SHIFT_EXPORT_FORMATS) {
      await page.getByRole("button", { name: "Выгрузка", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: format.label, exact: true }).waitFor();
      await dialog.getByRole("radio", { name: format.label, exact: true }).click();
      const before = await page.evaluate(() => globalThis.window.historyAcceptance.formats.length);
      await dialog.getByRole("button", { name: "Сформировать и сохранить", exact: true }).click();
      await page.waitForFunction(
        (count) => globalThis.window.historyAcceptance.formats.length > count,
        before,
      );
      await dialog.getByText(/Сохранено файлов:/).waitFor();
      await dialog.getByRole("button", { name: "Закрыть", exact: true }).last().click();
    }
    await page.getByRole("heading", { name: "Сохранённые файлы", exact: true }).waitFor();
    await page
      .getByRole("combobox", { name: "Строк на странице: Сохранённые файлы", exact: true })
      .click();
    await page.getByRole("option", { name: "50", exact: true }).click();
    const downloads = page.getByRole("button", { name: /^Скачать / });
    // Every row's standard StoredFiles reader validates downloaded exact bytes against SHA-256.
    const downloadCount = await downloads.count();
    assert.ok(downloadCount >= 11);
    for (let n = 0; n < downloadCount; n++) {
      const before = await page.evaluate(() => globalThis.window.historyAcceptance.downloads);
      await downloads.nth(n).click();
      await page.waitForFunction(
        (count) => globalThis.window.historyAcceptance.downloads > count,
        before,
      );
    }
    async function printForm(button, paper) {
      await page.getByRole("button", { name: button, exact: true }).click();
      const dialog = page.getByRole("dialog");
      if (paper) await dialog.getByRole("radio", { name: paper, exact: true }).click();
      const before = await page.evaluate(() => globalThis.window.historyAcceptance.forms.length);
      await dialog.getByRole("button", { name: "Печать", exact: true }).click();
      await page.waitForFunction(
        (count) => globalThis.window.historyAcceptance.forms.length > count,
        before,
      );
      await dialog.getByRole("button", { name: "Закрыть", exact: true }).last().click();
    }
    await printForm("Ярлыки паллет смены", "A4");
    await printForm("Ярлыки паллет смены", "A5");
    await page.locator(`a[href="/cloud-boxes/${box.id}"]`).click();
    await printForm("Состав короба");
    await page.locator(`a[href="/cloud-pallets/${pallet.pallet.id}"]`).click();
    await printForm("Состав паллеты");
    await printForm("Ярлык паллеты", "A4");
    await printForm("Ярлык паллеты", "A5");
    await page.getByRole("button", { name: "XML паллеты", exact: true }).click();
    await page.getByText("XML сформирован и сохранён.", { exact: true }).waitFor();
    {
      const download = page.getByRole("button", { name: /^Скачать .*\.xml$/ });
      await download.waitFor();
      const savedBefore = await page.evaluate(() => globalThis.window.historyAcceptance.saved);
      await download.click();
      await page.waitForFunction(
        (count) => globalThis.window.historyAcceptance.saved > count,
        savedBefore,
      );
    }
    await page.screenshot({
      path: resolve(out, "03-cloud-pallet-saved-files.png"),
      fullPage: true,
    });
    // Warehouse pallet is reached from the original shift's box, preserving its multi-shift composition.
    const warehouse = fixture.palletSources.find((row) => row.pallet.kind === "warehouse");
    const warehouseBox = warehouse.boxes.find((row) => row.pack.shiftId === shift.id);
    await page.locator(`a[href="/cloud-boxes/${box.id}"]`).first().click();
    await page.locator(`a[href="/cloud-shifts/${shift.id}"]`).click();
    await page.locator(`a[href="/cloud-boxes/${warehouseBox.pack.id}"]`).click();
    await page.locator(`a[href="/cloud-pallets/${warehouse.pallet.id}"]`).click();
    await printForm("Состав паллеты");
    await printForm("Ярлык паллеты", "A4");
    await page.getByRole("button", { name: "XML паллеты", exact: true }).click();
    await page.getByText("XML сформирован и сохранён.", { exact: true }).waitFor();
    {
      const download = page.getByRole("button", { name: /^Скачать .*\.xml$/ });
      await download.waitFor();
      const savedBefore = await page.evaluate(() => globalThis.window.historyAcceptance.saved);
      await download.click();
      await page.waitForFunction(
        (count) => globalThis.window.historyAcceptance.saved > count,
        savedBefore,
      );
    }
    await page.screenshot({
      path: resolve(out, "04-warehouse-multiple-shifts.png"),
      fullPage: true,
    });
    const metrics = await page.evaluate(() => globalThis.window.historyAcceptance);
    assert.deepEqual(
      [...new Set(metrics.formats.filter((id) => id.startsWith("shift_")))].sort(),
      SHIFT_EXPORT_FORMATS.map((row) => row.id).sort(),
    );
    assert.ok(metrics.formats.filter((id) => id === "pallet_xml_gismt_aggregation").length >= 2);
    assert.deepEqual(
      [...new Set(metrics.forms)].sort(),
      ["form_box", "form_pallet", "form_placard", "form_placards"].sort(),
    );
    assert.equal(
      metrics.routes.filter((route) =>
        /\/office\/shifts\/[^/]+\/(?:scans|exceptions|rejections|export-source)/.test(route),
      ).length,
      0,
    );
    assert.deepEqual(errors, []);
    const result = {
      url,
      evidence: out,
      formats: metrics.formats,
      forms: metrics.forms,
      downloads: metrics.downloads,
      saved: metrics.saved,
      printed: metrics.printed,
      pageErrors: errors.length,
      unsupportedRefusals: ["preview", "shift", "box", "pallet"],
    };
    await writeFile(resolve(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  }
} catch (error) {
  await page.screenshot({ path: resolve(out, "failure.png"), fullPage: true });
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
