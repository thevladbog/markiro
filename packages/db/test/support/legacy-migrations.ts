import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface MigrationJournal {
  entries: Array<{ idx: number; tag: string }>;
}

function migrationFileIndex(fileName: string): number | null {
  const match = /^(\d{4})_/.exec(fileName);
  return match ? Number(match[1]) : null;
}

async function removeFilesAfter(folder: string, lastIncludedIndex: number): Promise<void> {
  const files = await readdir(folder);
  await Promise.all(
    files.map(async (fileName) => {
      const index = migrationFileIndex(fileName);
      if (index !== null && index > lastIncludedIndex) {
        await rm(join(folder, fileName), { force: true });
      }
    }),
  );
}

export async function copyMigrationsThroughIndex(input: {
  sourceFolder: string;
  targetFolder: string;
  lastIncludedIndex: number;
}): Promise<void> {
  await cp(input.sourceFolder, input.targetFolder, { recursive: true });
  await removeFilesAfter(input.targetFolder, input.lastIncludedIndex);
  await removeFilesAfter(join(input.targetFolder, "meta"), input.lastIncludedIndex);

  const journalPath = join(input.targetFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= input.lastIncludedIndex);
  await writeFile(journalPath, JSON.stringify(journal));
}
