import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { notesForVersion } from "../changelog.mjs";

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

test("a version with no entry cannot be published", () => {
  // The whole point: a build published with nothing to say about it is how a
  // line ends up asking the office what changed.
  assert.throws(() => notesForVersion(sample, "0.3.0"), /no entry for 0\.3\.0/);
});

test("an empty entry is refused as firmly as a missing one", () => {
  assert.throws(() => notesForVersion("# x\n\n## 0.2.0\n\n## 0.1.0\n- a\n", "0.2.0"), /is empty/);
});

test("the committed changelog has an entry for the version the build declares", async () => {
  // Keeps the file honest against `versionName` in the Gradle build, so the
  // first real publication does not discover the gap.
  const gradle = await readFile("apps/handheld/app/build.gradle.kts", "utf8");
  const declared =
    /versionName = \(findProperty\("markiro\.versionName"\) as String\?\) \?: "([^"]+)"/.exec(
      gradle,
    );
  assert.ok(declared, "the build must declare a default versionName");
  const markdown = await readFile("apps/handheld/CHANGELOG.md", "utf8");
  assert.ok(notesForVersion(markdown, declared[1]).length > 0);
});
