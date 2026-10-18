import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const out = process.env.OFFICE_BROWSER_EVIDENCE ?? "/private/tmp/markiro-office-layout-first";
await mkdir(out, { recursive: true });
const server = await createServer({
  root: process.cwd(),
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/test/harness/cloud-history/index.html`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
const catalog = await readFile(
  new URL("../../../proto/fixtures/cloud-export-file.json", import.meta.url),
);
const registry = JSON.parse(
  await readFile(
    new URL("../../../proto/fixtures/code-registry-card.json", import.meta.url),
    "utf8",
  ),
);
const history = JSON.parse(
  await readFile(
    new URL("../../../proto/fixtures/cloud-history-read.json", import.meta.url),
    "utf8",
  ),
);
const cloudBoxId = history.request.part.payload.boxes[0].id;
const errors = [];
const captures = [];
const domOnly = process.env.OFFICE_BROWSER_DOM_ONLY === "1";
const sizes = [
  { name: "desktop-dark", width: 1280, height: 720, theme: "dark" },
  { name: "reduced-dark", width: 820, height: 614, theme: "dark" },
  { name: "wide-light", width: 1920, height: 1080, theme: "light" },
];

async function capture(page, size, state, target) {
  await page.evaluate(() => new Promise((done) => globalThis.requestAnimationFrame(done)));
  if (!domOnly) await page.screenshot({ path: resolve(out, `${size.name}-${state}.png`) });
  const metrics = await page.evaluate(() => {
    const content = globalThis.document.querySelector(".office-shell__content");
    const rect = content.getBoundingClientRect();
    return {
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      documentWidth: globalThis.document.documentElement.scrollWidth,
      contentWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      contentScrollLeft: content.scrollLeft,
      bodyOverflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth + 1,
      contentOverflow: content.scrollWidth > content.clientWidth + 1,
      overflowChildren: [...content.querySelectorAll("*")]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            (bounds.right > rect.right + 1 || bounds.left < rect.left - 1) &&
            !element.closest(".mk-table__scroll") &&
            bounds.width > 0
          );
        })
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName,
          class: element.className,
          width: element.getBoundingClientRect().width,
          text: element.textContent.slice(0, 80),
        })),
      header: (() => {
        const header = globalThis.document.querySelector(".office-header");
        const bounds = header.getBoundingClientRect();
        const children = [...header.querySelectorAll("button,a")].map((element) =>
          element.getBoundingClientRect(),
        );
        return {
          height: bounds.height,
          bottom: bounds.bottom,
          controlsOutside: children.some((child) => child.bottom > bounds.bottom + 1),
        };
      })(),
      tableRows: [...content.querySelectorAll(".mk-table__row")].slice(0, 4).map((element) => ({
        height: element.getBoundingClientRect().height,
        visibleHeight: Math.max(
          0,
          Math.min(element.getBoundingClientRect().bottom, rect.bottom) -
            Math.max(element.getBoundingClientRect().top, rect.top),
        ),
      })),
      tableScrolls: [...content.querySelectorAll(".mk-table__scroll")].map((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        ancestors: [element, element.parentElement, element.parentElement.parentElement].map(
          (node) => ({
            class: node.className,
            width: node.getBoundingClientRect().width,
            scrollWidth: node.scrollWidth,
            overflow: globalThis.getComputedStyle(node).overflow,
            minWidth: globalThis.getComputedStyle(node).minWidth,
          }),
        ),
      })),
      cards: [...content.querySelectorAll(".office-list-card")].map((element) => ({
        height: element.getBoundingClientRect().height,
      })),
      actions: [
        ...globalThis.document.querySelectorAll(
          ".office-actions > .mk-btn, .update-stage > .mk-btn",
        ),
      ].map((element) => ({
        text: element.textContent,
        width: element.getBoundingClientRect().width,
      })),
      source: [...globalThis.document.querySelectorAll(".office-source-nav a")].map((element) => ({
        text: element.textContent,
        current: element.getAttribute("aria-current"),
        height: element.getBoundingClientRect().height,
      })),
      heading: [...globalThis.document.querySelectorAll("h1,h2,h3")].map(
        (element) => element.textContent,
      ),
      contentLeft: rect.left,
    };
  });
  captures.push({ size: size.name, state, target, ...metrics });
}

async function open(context, size, target, extra = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push({ state: target, message: error.message }));
  const query = new URLSearchParams({
    layout: "office",
    theme: size.theme,
    start: target,
    ...extra,
  });
  await page.goto(`${url}?${query}`);
  await page.locator(".office-shell__content").waitFor();
  await page.evaluate(() => globalThis.document.fonts.ready);
  return page;
}

async function replacement(context, size) {
  const page = await open(context, size, "/import", { layout: "import" });
  await page.getByRole("checkbox", { name: "Заменить существующие данные", exact: true }).check();
  await page
    .locator('input[type="file"][accept*=".json,"]')
    .setInputFiles({ name: "catalog.json", mimeType: "application/json", buffer: catalog });
  const upload = await page.evaluate(() => globalThis.window.historyUpload);
  await page.locator('input[type="file"][accept*=".jsonl"]').setInputFiles({
    name: "history.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(upload),
  });
  await page.getByRole("button", { name: "Проверить", exact: true }).click();
  await page
    .getByText("Проверка пройдена: перенос запишет то, что ниже.", { exact: true })
    .waitFor();
  await capture(page, size, "replacement-preview", "/import");
  await page.getByRole("button", { name: "Заменить данные", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Заменить данные", exact: true })
      .isDisabled(),
    true,
  );
  await capture(page, size, "replacement-dialog", "/import");
  await page.close();
}

try {
  for (const size of domOnly ? sizes.filter((size) => size.name === "reduced-dark") : sizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    if (domOnly) {
      await replacement(context, size);
      await context.close();
      continue;
    }
    let page = await open(context, size, "/about#update");
    await page.getByRole("button", { name: /^Проверить: markiro/ }).click();
    await page.getByText("Подпись проверена: выпуск Маркиро.", { exact: true }).waitFor();
    await page.locator("#update").scrollIntoViewIfNeeded();
    await capture(page, size, "update-verified", "/about#update");
    await page.getByText("Установить вручную", { exact: true }).click();
    await page.locator(".office-disclosure").scrollIntoViewIfNeeded();
    await capture(page, size, "update-manual-long-path", "/about#update");
    assert.equal(await page.locator(".update-release-notes li").count(), 30);
    assert.equal(await page.getByText("Бета-версия", { exact: true }).count(), 0);
    await page.close();

    for (const state of ["cloud-populated", "codes-mixed", "code-card"]) {
      const target =
        state === "cloud-populated"
          ? "/cloud-shifts"
          : state === "codes-mixed"
            ? "/codes?gtin=04600682000013"
            : `/codes?codeHash=${registry.codeHash}`;
      page = await open(context, size, target);
      if (state === "cloud-populated") {
        await page.locator(".mk-table__row").first().waitFor();
        await capture(page, size, "cloud-filters", target);
        await page.locator(".mk-table__row").first().scrollIntoViewIfNeeded();
      } else if (state === "codes-mixed") {
        await page.getByText("Найдено: 2", { exact: true }).waitFor();
        await capture(page, size, "codes-filters", target);
        await page.locator(".mk-table__row").first().scrollIntoViewIfNeeded();
      } else {
        const heading = page.getByRole("heading", { name: "Снимок из облака", exact: true });
        await heading.waitFor();
        await page.locator(".office-list-body").scrollIntoViewIfNeeded();
        await capture(page, size, "code-card-summary", target);
        await heading.scrollIntoViewIfNeeded();
      }
      await capture(page, size, state, target);
      await page.close();
    }
    for (const kind of ["short-list", "long-list"]) {
      page = await open(context, size, "/cloud-shifts", { [kind]: "1" });
      await page.locator(".mk-table__row").first().waitFor();
      await page.locator(".mk-table__row").first().scrollIntoViewIfNeeded();
      await capture(page, size, kind, "/cloud-shifts");
      const geometry = await page.locator(".mk-table__scroll").evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      if (kind === "short-list")
        assert.ok(
          geometry.height <= 102,
          "short list keeps one row without artificial blank space",
        );
      else
        assert.ok(
          geometry.scrollHeight > geometry.height && geometry.height >= 267,
          "long list keeps its bounded inner scroll",
        );
      await page.close();
    }
    await replacement(context, size);

    page = await open(context, size, `/cloud-boxes/${cloudBoxId}`);
    await page.getByRole("heading", { name: /^Облачный короб/ }).waitFor();
    assert.equal(await page.locator('.office-menu__link--active[href="/shifts"]').count(), 1);
    assert.ok((await page.locator(".office-crumbs a").count()) >= 2);
    await capture(page, size, "cloud-box-breadcrumbs", `/cloud-boxes/${cloudBoxId}`);
    await page.close();

    if (size.name === "desktop-dark") {
      for (const [state, target, extra] of [
        ["cloud-empty", "/cloud-shifts", { empty: "1" }],
        ["native-shifts", "/shifts", {}],
        ["codes-empty", "/codes?gtin=04600682000013", { empty: "1" }],
        ["codes-error", "/codes?gtin=04600682000013", { "registry-error": "1" }],
        ["update-error", "/about#update", { "update-error": "1" }],
      ]) {
        page = await open(context, size, target, extra);
        if (state === "cloud-empty")
          await page.getByText("Облачных смен нет", { exact: true }).waitFor();
        else if (state === "native-shifts")
          await page.getByText("OCT26-004", { exact: true }).waitFor();
        else if (state === "update-error")
          await page.locator("#update [role=alert]").last().waitFor();
        else await page.locator(".office-list-body").waitFor();
        if (state === "update-error") await page.locator("#update").scrollIntoViewIfNeeded();
        await capture(page, size, state, target);
        await page.close();
      }
    }
    await context.close();
  }
} finally {
  await writeFile(
    resolve(out, "result.json"),
    `${JSON.stringify({ captures, errors }, null, 2)}\n`,
  );
  await browser.close();
  await server.close();
}
assert.deepEqual(errors, []);
assert.ok(
  captures.every((row) => !row.bodyOverflow),
  "no viewport overflow",
);
assert.ok(
  captures.every((row) => !row.contentOverflow),
  "no horizontal office content overflow",
);
assert.ok(
  captures.every((row) => !row.header.controlsOutside),
  "wrapped header actions remain inside header",
);
console.log(
  JSON.stringify({
    captures: captures.length,
    errors: errors.length,
    overflows: captures
      .filter((row) => row.bodyOverflow || row.contentOverflow)
      .map((row) => ({ size: row.size, state: row.state })),
    evidence: out,
  }),
);
