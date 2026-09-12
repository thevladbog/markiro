import { readFile } from "node:fs/promises";

const CHANGELOG = "apps/handheld/CHANGELOG.md";

/**
 * The notes an operator reads in Settings, taken from the file rather than from
 * a dispatch box.
 *
 * Typed notes are written once, in a hurry, by whoever is publishing. The file
 * is reviewed with the change it describes, and requiring an entry is what stops
 * a version shipping with nothing to say about it.
 */
export function notesForVersion(markdown, versionName) {
  const lines = markdown.split("\n");
  const heading = `## ${versionName}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`${CHANGELOG} has no entry for ${versionName}`);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith("## "));
  const body = (next === -1 ? rest : rest.slice(0, next)).join("\n").trim();
  if (body.length === 0) throw new Error(`the ${versionName} entry in ${CHANGELOG} is empty`);
  return body;
}

export async function readNotes(versionName, path = CHANGELOG) {
  return notesForVersion(await readFile(path, "utf8"), versionName);
}
