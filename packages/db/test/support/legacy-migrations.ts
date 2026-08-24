import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type MigrationJournalEntry = Record<string, unknown> & { idx: number; tag: string };
type MigrationJournal = Record<string, unknown> & { entries: MigrationJournalEntry[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMigrationJournal(value: unknown): MigrationJournal {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Invalid migration journal: entries must be an array");
  }

  return {
    ...value,
    entries: value.entries.map((entry: unknown, index) => {
      if (!isRecord(entry)) {
        throw new Error(
          `Invalid migration journal: entry ${index} must have a non-negative integer idx`,
        );
      }
      const { idx, tag } = entry;
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
        throw new Error(
          `Invalid migration journal: entry ${index} must have a non-negative integer idx`,
        );
      }
      if (typeof tag !== "string" || tag.trim().length === 0) {
        throw new Error(`Invalid migration journal: entry ${index} must have a non-empty tag`);
      }
      return { ...entry, idx, tag };
    }),
  };
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
  const parsed: unknown = JSON.parse(await readFile(journalPath, "utf8"));
  const journal = parseMigrationJournal(parsed);
  journal.entries = journal.entries.filter((entry) => entry.idx <= input.lastIncludedIndex);
  await writeFile(journalPath, JSON.stringify(journal));
}
