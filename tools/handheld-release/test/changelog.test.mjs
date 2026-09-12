import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { notesForVersion, readNotes } from "../changelog.mjs";

const sample = `# Изменения ТСД

Новое сверху.

## 0.2.0

- Лента показывает серийник
- План смены предлагает закрытие

## 0.1.0

- Первая сборка
`;

test("the entry for a version is read whole and without its neighbours", () => {
  assert.equal(
    notesForVersion(sample, "0.2.0"),
    "- Лента показывает серийник\n- План смены предлагает закрытие",
  );
  assert.equal(notesForVersion(sample, "0.1.0"), "- Первая сборка");
});

test("a version with no entry gets automatic release notes without older changes", () => {
  assert.equal(
    notesForVersion(sample, "0.3.0"),
    "Markiro ТСД 0.3.0. Обновление приложения для терминалов сбора данных.",
  );
});

test("an empty entry gets automatic release notes", () => {
  assert.equal(
    notesForVersion("# x\n\n## 0.2.0\n\n## 0.1.0\n- a\n", "0.2.0"),
    "Markiro ТСД 0.2.0. Обновление приложения для терминалов сбора данных.",
  );
});

test("a missing changelog file does not block publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handheld-notes-"));
  assert.equal(await readNotes("0.3.0", join(dir, "missing.md")), notesForVersion("", "0.3.0"));
});

test("changelog read errors other than a missing file remain visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handheld-notes-"));
  await assert.rejects(() => readNotes("0.3.0", dir), { code: "EISDIR" });
});

test("curated notes for the first published release remain unchanged", async () => {
  const markdown = await readFile("apps/handheld/CHANGELOG.md", "utf8");
  assert.equal(
    notesForVersion(markdown, "0.1.0"),
    "- Первая сборка для реального терминала: привязка, смена, агрегация коробов,\n  инвентаризация, печать этикеток и дубликатов, исключения.",
  );
});
