import { readFile } from "node:fs/promises";

const CHANGELOG = "apps/handheld/CHANGELOG.md";

// Keep curated historical notes when available; a new release never needs a
// separate changelog commit, just like the signer release process.
export function notesForVersion(markdown, versionName) {
  const automatic = `Markiro ТСД ${versionName}. Обновление приложения для терминалов сбора данных.`;
  const lines = markdown.split("\n");
  const heading = `## ${versionName}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return automatic;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith("## "));
  const body = (next === -1 ? rest : rest.slice(0, next)).join("\n").trim();
  return body || automatic;
}

export async function readNotes(versionName, path = CHANGELOG) {
  let markdown;
  try {
    markdown = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    markdown = "";
  }
  return notesForVersion(markdown, versionName);
}
