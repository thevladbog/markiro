// A DRAFT of the release notes for the owner to review (the file
// `notes.draft.txt` beside the installer in the CI artifact), built from the
// Git history so nobody writes the notes of `sign-update.mjs --notes` from
// scratch:
//
//   node tools/standalone-release/draft-notes.mjs --output-dir <prepared dir>
//
// Which commits: those touching the standalone product (`apps/standalone`,
// `packages/domain/fixtures`, `tools/standalone-release`) since the previous
// release. The previous release is, in this order: the newest tag
// `standalone-v*` (none exists today); else the newest commit that recorded a
// release in `releases.json` (the owner adds a release's line in the commit
// that releases it, so that is a real marker; when the version being built is
// already recorded, the recording before it); else no marker and the last
// `FALLBACK_COMMITS` commits. Only `feat`, `fix` and `perf` subjects count:
// they are the changes a customer can notice. Needs the full history (the CI
// checkout uses `fetch-depth: 0`).
//
// The draft is not a release asset: it is not in SHA256SUMS and not in the
// evidence, because the owner edits it (a hash would turn that into a
// mismatch); `verifyPreparedStandaloneRelease` tolerates the file and
// ignores its content. Whatever the owner signs, `sign-update.mjs` checks it
// again with `parseNotes` and asks for a confirmation on the terminal.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NOTES_DRAFT_FILE, readStandaloneVersion } from "./prepare.mjs";
import {
  MAX_NOTE_CHARS,
  MAX_NOTES,
  compareVersions,
  hasControl,
  parseNotes,
} from "./sign-update.mjs";

export { NOTES_DRAFT_FILE };
/** The one line of a draft that found nothing to say. */
export const FALLBACK_NOTE = "Исправления и улучшения";
export const FALLBACK_COMMITS = 50;
/** What a standalone release is made of. */
export const PRODUCT_PATHS = Object.freeze([
  "apps/standalone",
  "packages/domain/fixtures",
  "tools/standalone-release",
]);
const TAG_PATTERN = "standalone-v*";
const RELEASES_FILE = "tools/standalone-release/releases.json";
const CONVENTIONAL = /^(?:feat|fix|perf)(?:\([^)]*\))?!?:\s*(.+)$/iu;

/** `text` cut to at most `limit` UTF-16 units on a code point boundary, ending in an ellipsis when cut. */
function truncate(text, limit) {
  if (text.length <= limit) return text;
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > limit - 1) break;
    kept += char;
  }
  return `${kept.trimEnd()}…`;
}

/** The note a commit subject makes, or `null` when it is not a feat, fix or perf. */
export function subjectToNote(subject) {
  const match = CONVENTIONAL.exec(String(subject).trim());
  if (match === null) return null;
  const text = [...match[1]]
    .map((char) => (hasControl(char) ? " " : char))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return null;
  const [first] = text;
  return truncate(`${first.toUpperCase()}${text.slice(first.length)}`, MAX_NOTE_CHARS);
}

function more(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? "изменение"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "изменения"
        : "изменений";
  return `И ещё ${count} ${noun}`;
}

/**
 * The notes file text of `subjects` (newest first): one line each, deduplicated,
 * at most thirty lines, at least one. Always accepted by `parseNotes`.
 */
export function buildDraftNotes(subjects) {
  const seen = new Set();
  let notes = [];
  for (const subject of subjects) {
    const note = subjectToNote(subject);
    if (note === null || seen.has(note.toLowerCase())) continue;
    seen.add(note.toLowerCase());
    notes.push(note);
  }
  if (notes.length === 0) notes = [FALLBACK_NOTE];
  if (notes.length > MAX_NOTES) {
    const extra = notes.length - (MAX_NOTES - 1);
    notes = [...notes.slice(0, MAX_NOTES - 1), more(extra)];
  }
  const text = `${notes.join("\n")}\n`;
  parseNotes(text);
  return text;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Where the previous release ended: `{ kind: "tag" | "releases" | "none", ref }`. */
export function findReleaseMarker({ cwd = process.cwd(), version }) {
  const tags = git(cwd, [
    "tag",
    "--list",
    TAG_PATTERN,
    "--merged",
    "HEAD",
    "--sort=-version:refname",
  ])
    .split("\n")
    .filter((tag) => tag !== "");
  if (tags.length > 0) return { kind: "tag", ref: tags[0] };
  const recorders = git(cwd, ["log", "--format=%H", "--", RELEASES_FILE])
    .split("\n")
    .filter((sha) => sha !== "");
  for (const sha of recorders) {
    let recorded;
    try {
      recorded = JSON.parse(git(cwd, ["show", `${sha}:${RELEASES_FILE}`])).releases;
    } catch {
      continue;
    }
    // The commit that records this very version is the release being built, not the one before it.
    if (recorded.some((release) => compareVersions(release.version, version) === 0)) continue;
    return { kind: "releases", ref: sha };
  }
  return { kind: "none", ref: null };
}

/** The commit subjects of the product since the marker, newest first. */
export function collectSubjects({ cwd = process.cwd(), marker }) {
  const range = marker.ref === null ? ["-n", String(FALLBACK_COMMITS)] : [`${marker.ref}..HEAD`];
  return git(cwd, ["log", "--no-merges", "--format=%s", ...range, "--", ...PRODUCT_PATHS])
    .split("\n")
    .filter((line) => line !== "");
}

async function main() {
  const { values } = parseArgs({ options: { "output-dir": { type: "string" } }, strict: true });
  if (values["output-dir"] === undefined) throw new Error("--output-dir is required");
  const version = await readStandaloneVersion();
  const marker = findReleaseMarker({ version });
  const text = buildDraftNotes(collectSubjects({ marker }));
  await mkdir(values["output-dir"], { recursive: true });
  const path = join(values["output-dir"], NOTES_DRAFT_FILE);
  await writeFile(path, text, "utf8");
  parseNotes(await readFile(path, "utf8"));
  const count = text.trimEnd().split("\n").length;
  process.stdout.write(
    `${NOTES_DRAFT_FILE}: ${count} lines since ${marker.kind} ${marker.ref ?? "-"}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
