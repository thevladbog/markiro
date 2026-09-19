import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { classify, extractQuotes, flattenDictionaryValues, lint } from "./lens.mjs";

const LENS_PATH = fileURLToPath(new URL("./lens.mjs", import.meta.url));

// --- Regression tests: both historical defects silently voided a document's
// verdict (green `missing=0` that proved nothing). These exercise the real
// `classify` function - a hand-rolled regex in this test file would keep
// passing even if the tool's matcher regressed.

test("defect 1: a bare-placeholder dictionary value does not match an arbitrary quote", () => {
  // Before the fix, "{{name}}" compiled to `^.+$` and matched anything.
  const values = flattenDictionaryValues({ greeting: "{{name}}" });
  assert.equal(classify("Совершенно случайная фраза, которой нет в словаре", values), "MISSING");
  // A trivial one-character quote must not slip through either.
  assert.equal(classify("x", values), "MISSING");
});

test("defect 2: a short-literal template does not swallow an unrelated quote with the same tail", () => {
  // Before the fix, "{{count}} смены" compiled to `^.+ смены$` and matched
  // any string ending in " смены" - including this real shift-export label.
  const values = flattenDictionaryValues({ shiftsCompleted: "{{count}} смены" });
  assert.equal(classify("[TXT][Паллеты] Отчет смены", values), "MISSING");
});

test("defect 1, isolated from defect 2's guard: a near-bare literal does not match a short quote with the same tail", () => {
  // classify() has two independent guards: an absolute minimum-literal-
  // length check (>=3 chars) and a proportional check (literal must cover
  // at least half the quote). For a *fully* empty literal (the brief's
  // canonical "{{name}}") the proportional guard alone always rejects,
  // since 0 is never >= half of a non-empty quote - so that example cannot
  // prove the minimum-length guard is still wired in. This case uses a
  // short-but-nonzero literal ("шт", 2 characters) matched against an
  // equally short quote, which the proportional guard alone would accept:
  // only the minimum-length guard rejects it. If that guard is dropped,
  // this line alone flips to "template" while every other test still
  // passes.
  const values = flattenDictionaryValues({ qty: "{{count}} шт" });
  assert.equal(classify("5 шт", values), "MISSING");
});

// --- Positive cases: a future "fix" must not pass by rejecting everything.

test("an exact dictionary value matches as exact", () => {
  const values = flattenDictionaryValues({ regulatory: { states: { ready: "Готово" } } });
  assert.equal(classify("Готово", values), "exact");
});

test("a quote that leads a longer dictionary value matches as prefix", () => {
  const values = flattenDictionaryValues({ status: "Готово к печати" });
  assert.equal(classify("Готово", values), "prefix");
});

test("a genuine placeholder template matches its filled-in quote", () => {
  // The brief's own example: a template with real literal text on both
  // sides of the placeholder must still match a plausible rendered value.
  const values = flattenDictionaryValues({ selection: "Выбрано: {{count}} из 100" });
  assert.equal(classify("Выбрано: 0 из 100", values), "template");
});

test("a mid-string excerpt of a longer dictionary value matches as a fragment", () => {
  const values = flattenDictionaryValues({
    hint: "Нажмите кнопку сохранения характеристик, чтобы продолжить",
  });
  // The excerpt is drawn from the middle - it neither starts nor ends the
  // dictionary string - and is at least 8 characters long.
  assert.equal(classify("сохранения характеристик", values), "fragment");
});

test("a quote absent from the dictionary is MISSING", () => {
  const values = flattenDictionaryValues({ hello: "Привет" });
  assert.equal(classify("Совсем другая строка длиннее восьми символов", values), "MISSING");
});

// --- Supporting-function tests: the extractor and the flattener feed
// `classify`, so their shape matters as much as the matcher itself.

test("flattenDictionaryValues collects every string leaf of a nested tree", () => {
  const values = flattenDictionaryValues({
    common: { appName: "Markiro", nested: { deep: "Значение" } },
    top: "Верхний уровень",
  });
  assert.deepEqual(values.sort(), ["Markiro", "Верхний уровень", "Значение"].sort());
});

test("extractQuotes walks summary, headings, blocks and frames guillemets to steps with images", () => {
  const content = {
    summary: "Обзор «Раздела».",
    sections: [
      {
        id: "s1",
        heading: "Заголовок «А»",
        blocks: [
          { kind: "paragraph", text: "Текст «Б»." },
          {
            kind: "step",
            title: "Шаг «В»",
            text: "Описание «Г»",
            image: { id: "frame-1", caption: "Подпись «Д»" },
          },
          { kind: "step", title: "Шаг без образа «Е»", text: "нет картинки" },
          { kind: "unordered-list", items: ["Пункт «Ж»"] },
        ],
      },
    ],
  };
  const rows = extractQuotes(content, "ru");
  const byQuote = Object.fromEntries(rows.map((r) => [r.quote, r.frame]));
  assert.equal(byQuote["Раздела"], "—");
  assert.equal(byQuote["А"], "—");
  assert.equal(byQuote["Б"], "§s1");
  assert.equal(byQuote["В"], "frame-1");
  assert.equal(byQuote["Г"], "frame-1");
  assert.equal(byQuote["Д"], "frame-1");
  assert.equal(byQuote["Е"], "§s1");
  assert.equal(byQuote["Ж"], "§s1");
});

test("extractQuotes uses curly “…” quotes for en, not straight quotes", () => {
  // Regression: a refactor once swapped this pattern for straight `"..."`
  // quotes, which never match the curly quotes real document content uses -
  // the lens silently found zero quotes and reported a meaningless
  // `missing=0` for every English document.
  const content = {
    summary: "Overview of “Section”.",
    sections: [],
  };
  const rows = extractQuotes(content, "en");
  assert.deepEqual(
    rows.map((r) => r.quote),
    ["Section"],
  );
  // A straight-quoted string must NOT be picked up for en.
  const straightOnly = extractQuotes({ summary: 'Overview of "Section".', sections: [] }, "en");
  assert.deepEqual(straightOnly, []);
});

test("lint dedupes by quote+frame and counts only MISSING verdicts", () => {
  const rows = [
    { quote: "Готово", frame: "§1" },
    { quote: "Готово", frame: "§1" }, // duplicate, must not be double-counted
    { quote: "Пропавшая фраза длиннее восьми", frame: "§1" },
  ];
  const values = flattenDictionaryValues({ ready: "Готово" });
  const lines = [];
  const missing = lint(rows, values, { code: "TEST", locale: "ru", log: (l) => lines.push(l) });
  assert.equal(missing, 1);
  assert.equal(lines.at(-1), "TEST ru: quotes=2 missing=1");
  assert.ok(lines.some((l) => l.includes("MISSING") && l.includes("Пропавшая фраза")));
});

// --- CLI smoke test: proves the moved tool still resolves the registry and
// dictionary paths relative to a `root` argument, exactly like the original
// `/tmp` script did.

function withTempRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), "instruction-lens-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("CLI: reports missing=0 for a document whose quotes are all in the dictionary", () => {
  withTempRepo((root) => {
    mkdirSync(join(root, "packages/legal-documents/dist"), { recursive: true });
    mkdirSync(join(root, "apps/admin/src/i18n"), { recursive: true });
    writeFileSync(
      join(root, "packages/legal-documents/dist/registry.js"),
      `export const LEGAL_DOCUMENTS = [{
        releaseKey: "MKR-TEST/2026.01/01",
        content: { ru: { summary: "Обзор «Пример».", sections: [] } },
      }];\n`,
    );
    writeFileSync(join(root, "apps/admin/src/i18n/ru.json"), JSON.stringify({ label: "Пример" }));
    const out = execFileSync("node", [LENS_PATH, root, "MKR-TEST", "ru"], { encoding: "utf8" });
    assert.match(out, /MKR-TEST ru: quotes=1 missing=0/);
    assert.doesNotMatch(out, /MISSING/);
  });
});

test("CLI: reports a MISSING line for a quote absent from the dictionary", () => {
  withTempRepo((root) => {
    mkdirSync(join(root, "packages/legal-documents/dist"), { recursive: true });
    mkdirSync(join(root, "apps/admin/src/i18n"), { recursive: true });
    writeFileSync(
      join(root, "packages/legal-documents/dist/registry.js"),
      `export const LEGAL_DOCUMENTS = [{
        releaseKey: "MKR-TEST/2026.01/01",
        content: { ru: { summary: "Обзор «Пропавшая длинная фраза».", sections: [] } },
      }];\n`,
    );
    writeFileSync(join(root, "apps/admin/src/i18n/ru.json"), JSON.stringify({ label: "Другое" }));
    const out = execFileSync("node", [LENS_PATH, root, "MKR-TEST", "ru"], { encoding: "utf8" });
    assert.match(out, /MISSING\s+—\s+«Пропавшая длинная фраза»/);
    assert.match(out, /MKR-TEST ru: quotes=1 missing=1/);
  });
});

test("CLI: an accepted dictDir override is honored", () => {
  withTempRepo((root) => {
    mkdirSync(join(root, "packages/legal-documents/dist"), { recursive: true });
    mkdirSync(join(root, "custom/i18n"), { recursive: true });
    writeFileSync(
      join(root, "packages/legal-documents/dist/registry.js"),
      `export const LEGAL_DOCUMENTS = [{
        releaseKey: "MKR-TEST/2026.01/01",
        content: { ru: { summary: "«Метка»", sections: [] } },
      }];\n`,
    );
    writeFileSync(join(root, "custom/i18n/ru.json"), JSON.stringify({ label: "Метка" }));
    const out = execFileSync("node", [LENS_PATH, root, "MKR-TEST", "ru", "custom/i18n"], {
      encoding: "utf8",
    });
    assert.match(out, /MKR-TEST ru: quotes=1 missing=0/);
  });
});

test("CLI: locale absent from a document's content exits cleanly without crashing", () => {
  withTempRepo((root) => {
    mkdirSync(join(root, "packages/legal-documents/dist"), { recursive: true });
    mkdirSync(join(root, "apps/admin/src/i18n"), { recursive: true });
    writeFileSync(
      join(root, "packages/legal-documents/dist/registry.js"),
      `export const LEGAL_DOCUMENTS = [{
        releaseKey: "MKR-TEST/2026.01/01",
        content: { ru: { summary: "«Метка»", sections: [] } },
      }];\n`,
    );
    writeFileSync(join(root, "apps/admin/src/i18n/en.json"), JSON.stringify({ label: "Label" }));
    const out = execFileSync("node", [LENS_PATH, root, "MKR-TEST", "en"], { encoding: "utf8" });
    assert.match(out, /no content for MKR-TEST en/);
  });
});
