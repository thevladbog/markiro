import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "../../tools/production-browser/node_modules/@playwright/test/index.mjs";
import { format } from "../../node_modules/prettier/index.mjs";

const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const bwipjs = require("bwip-js");
const samples = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const origin = process.env.LABEL_SAMPLES_ORIGIN ?? "http://127.0.0.1:61604";
const browser = await chromium.launch();
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** Keyed by the manifest's purpose so a new one fails loudly instead of reading as a duplicate. */
const PURPOSE_CAPTION = {
  product_duplicate: "Дубликат товара · Data Matrix",
  box: "Коробка · SSCC",
  pallet: "Паллета · SSCC, короба и единицы",
};
const cards = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1250, height: 1450 },
    deviceScaleFactor: 1,
  });
  await page.goto(`${origin}/apps/admin/test/browser/label-samples.html`);
  await page.waitForFunction(() => typeof window.renderLabelSample === "function");
  for (const [index, sample] of samples.entries()) {
    const code = await readFile(new URL(sample.source, import.meta.url), "utf8");
    // Every SSCC-bearing purpose, not just boxes: a pallet label carries the
    // same GS1-128, and leaving it null here would ship the editor's schematic
    // bar pattern into a published preview.
    const ssccSvg =
      sample.purpose !== "product_duplicate"
        ? bwipjs.toSVG({
            bcid: "gs1-128",
            text: `(00)${sample.sampleData.sscc}`,
            scale: 2,
            height: 10,
            includetext: false,
          })
        : null;
    const result = await page.evaluate(
      ({ index, code, ssccSvg }) => window.renderLabelSample(index, code, ssccSvg),
      { index, code, ssccSvg },
    );
    await page
      .locator("canvas")
      .screenshot({ path: fileURLToPath(new URL(sample.preview, import.meta.url)) });
    console.log(`Rendered and generated ZPL/TSPL at 203/300 dpi: ${result.id}`);
    cards.push(
      `<article id="${sample.id}"><h2>${escape(sample.category)} · ${sample.widthMm} × ${sample.heightMm} мм</h2><p>${PURPOSE_CAPTION[sample.purpose]} · группа ${sample.group}</p><div class="preview"><img src="${sample.preview}" alt="Образец ${escape(sample.category)} ${sample.widthMm} на ${sample.heightMm} мм" /></div><p><a class="download-code" href="${sample.source}" download>Скачать код</a> · <a href="${sample.preview}">Открыть PNG</a></p><details><summary>Код импорта</summary><button type="button">Копировать код</button><textarea readonly aria-label="Код ${escape(sample.id)}" spellcheck="false">${escape(code)}</textarea><span role="status"></span></details></article>`,
    );
  }
} finally {
  await browser.close();
}
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Markiro — образцы этикеток</title><style>
*{box-sizing:border-box}body{margin:0;padding:32px;font:16px/1.5 system-ui,sans-serif;background:#f2f1ed;color:#202322}main,header{max-width:1440px;margin:auto}header{margin-bottom:32px}h1{font-size:32px;margin:0 0 12px}h2{font-size:19px;margin:0}header p{max-width:900px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:20px}article{background:white;border:1px solid #d5d6d0;padding:22px}article p{font-size:14px;color:#535953}a{color:#155b42}.preview{height:340px;display:flex;align-items:center;justify-content:center;background:#f6f6f3;border:1px solid #deded8;padding:16px}.preview img{max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;box-shadow:0 1px 8px #0002}textarea{display:block;width:100%;height:220px;margin-top:12px;font:12px/1.5 monospace}button,summary{cursor:pointer}button{margin-top:12px;padding:8px 14px}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible{outline:3px solid #137252;outline-offset:3px}[role=status]{font-size:13px}.name-choice{border:0;padding:0;margin:24px 0 0}.name-choice legend{font-weight:600;margin-bottom:8px}.name-options{display:flex;flex-wrap:wrap;gap:8px}.name-options label{display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid #b8bdb5;background:white;cursor:pointer}.name-options label:has(input:checked){border-color:#155b42;background:#e5eee7;color:#155b42}.name-options input{accent-color:#155b42}.name-hint{font-size:14px;color:#535953}footer{max-width:1440px;margin:24px auto;font-size:14px}@media(max-width:500px){body{padding:16px}main{grid-template-columns:1fr}}
</style></head><body><header><h1>Образцы этикеток Markiro</h1><p>Соки, растительные масла и косметика. ${samples.length} макетов с кодом для создания шаблона у конкретного тенанта: дубликат товара, короб и паллета.</p><p>Создайте этикетку с нужным назначением, выберите «Импорт кода», язык ZPL и <strong>203 DPI</strong>, вставьте код. <a href="README.md">Подробная инструкция</a>.</p><p>Данные в превью демонстрационные. Это файлы импорта Markiro: напрямую принтеру их не отправлять. Превью показаны в разном масштабе; размеры указаны в заголовках.</p><fieldset class="name-choice" aria-describedby="name-hint"><legend>Наименование товара</legend><div class="name-options"><label><input type="radio" name="name-field" value="product.name">Полное наименование</label><label><input type="radio" name="name-field" value="product.printName" checked>Наименование для печати</label></div></fieldset><p id="name-hint" class="name-hint">Выбор меняет код всех макетов с наименованием. В этикетках 30×20 мм наименования нет.</p></header><main>${cards.join("\n")}</main><footer>Макеты для рабочих наклеек. Состав, INCI и другая полная потребительская информация в них не предусмотрены. Перед использованием — пробная печать и проверка сканером.</footer><script>
const nameCards = Array.from(document.querySelectorAll("article"), (article) => ({
 input: article.querySelector("textarea"),
 source: article.querySelector("textarea").value,
 link: article.querySelector(".download-code"),
 filename: article.querySelector(".download-code").getAttribute("href").split("/").pop(),
 status: article.querySelector("[role=status]"),
 downloadUrl: null,
}));
function updateNameField() {
 const field = document.querySelector('input[name="name-field"]:checked').value;
 for (const card of nameCards) {
  const code = card.source.replaceAll("{{product.printName}}", "{{" + field + "}}");
  card.input.value = code;
  card.status.textContent = "";
  if (card.downloadUrl) URL.revokeObjectURL(card.downloadUrl);
  card.downloadUrl = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
  card.link.href = card.downloadUrl;
  const suffix = field === "product.name" ? "full-name" : "print-name";
  card.link.download = card.source.includes("{{product.printName}}") ? card.filename.replace(".zpl", "-" + suffix + ".zpl") : card.filename;
 }
}
document.querySelectorAll('input[name="name-field"]').forEach((input) => input.addEventListener("change", updateNameField));
updateNameField();
document.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => {
 const container = button.closest("details"); const input = container.querySelector("textarea"); const status = container.querySelector("[role=status]");
 try { await navigator.clipboard.writeText(input.value); status.textContent = "Код скопирован"; }
 catch { input.focus(); input.select(); status.textContent = "Код выделен — нажмите Ctrl+C или Cmd+C"; }
}));
</script></body></html>`;
await writeFile(
  new URL("./index.html", import.meta.url),
  await format(html, { parser: "html", printWidth: 100 }),
);
