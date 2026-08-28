import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const temporaryRoots: string[] = [];

async function copyMalformedJournal(journal: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "markiro-legacy-migrations-test-"));
  temporaryRoots.push(root);
  const sourceFolder = join(root, "source");
  await mkdir(join(sourceFolder, "meta"), { recursive: true });
  await writeFile(join(sourceFolder, "meta", "_journal.json"), JSON.stringify(journal));

  return copyMigrationsThroughIndex({
    sourceFolder,
    targetFolder: join(root, "target"),
    lastIncludedIndex: 1,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("legacy migration fixture helper", () => {
  it("rejects a journal whose entries value is not an array", async () => {
    await expect(copyMalformedJournal({ entries: {} })).rejects.toThrow(
      "Invalid migration journal: entries must be an array",
    );
  });

  it.each([
    [
      "non-numeric idx",
      { idx: "1", tag: "0001_test" },
      "entry 0 must have a non-negative integer idx",
    ],
    ["negative idx", { idx: -1, tag: "0001_test" }, "entry 0 must have a non-negative integer idx"],
    ["empty tag", { idx: 1, tag: "" }, "entry 0 must have a non-empty tag"],
    ["blank tag", { idx: 1, tag: "   " }, "entry 0 must have a non-empty tag"],
  ])("rejects an entry with %s", async (_case, entry, message) => {
    await expect(copyMalformedJournal({ entries: [entry] })).rejects.toThrow(
      `Invalid migration journal: ${message}`,
    );
  });
});
