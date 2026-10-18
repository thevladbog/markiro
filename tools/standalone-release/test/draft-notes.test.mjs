import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FALLBACK_NOTE,
  NOTES_DRAFT_FILE,
  buildDraftNotes,
  findReleaseMarker,
  subjectToNote,
} from "../draft-notes.mjs";
import { MAX_NOTE_CHARS, MAX_NOTES, parseNotes } from "../sign-update.mjs";

test("only feat, fix and perf subjects become notes, with the prefix stripped and a capital", () => {
  assert.equal(subjectToNote("feat(standalone): вход оператора офлайн"), "Вход оператора офлайн");
  assert.equal(subjectToNote("fix: the label reprint"), "The label reprint");
  assert.equal(subjectToNote("perf(host)!: faster sync"), "Faster sync");
  assert.equal(subjectToNote("FIX(x):  spaced   out "), "Spaced out");
  for (const skipped of [
    "docs(standalone): plan",
    "test: x",
    "style: x",
    "chore: x",
    "ci: x",
    "refactor: x",
    "Merge branch 'a' into b",
    "Merge pull request #1 from x/y",
    "feat: ",
    "fixed something",
    "feature: x",
  ]) {
    assert.equal(subjectToNote(skipped), null, skipped);
  }
});

test("control characters never survive, and the result is plain text", () => {
  const note = subjectToNote("fix: a\u0000b‮c\u0085d\te");
  assert.equal(note, "A b c d e");
});

test("the draft is deduplicated, newest first, and always passes parseNotes", () => {
  const text = buildDraftNotes([
    "feat: Same thing",
    "chore: noise",
    "fix: same thing",
    "perf: Other",
    "Merge branch x",
  ]);
  assert.deepEqual(parseNotes(text), ["Same thing", "Other"]);
});

test("an empty or all-noise history gives the fallback line", () => {
  assert.deepEqual(parseNotes(buildDraftNotes([])), [FALLBACK_NOTE]);
  assert.deepEqual(parseNotes(buildDraftNotes(["docs: a", "chore: b"])), [FALLBACK_NOTE]);
  assert.equal(FALLBACK_NOTE, "Исправления и улучшения");
});

test("a long line is cut on a character boundary, never inside a surrogate pair", () => {
  const long = `fix: ${"😀".repeat(150)}`;
  const note = subjectToNote(long);
  assert.ok(note.length <= MAX_NOTE_CHARS);
  assert.ok(note.endsWith("…"));
  assert.doesNotMatch(
    note,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
  // Odd split: 199 BMP units then a pair at the border.
  const edge = subjectToNote(`fix: ${"а".repeat(198)}😀😀`);
  assert.ok(edge.length <= MAX_NOTE_CHARS);
  assert.deepEqual(parseNotes(edge), [edge]);
  // A line that fits is untouched.
  assert.equal(subjectToNote(`fix: ${"б".repeat(200)}`).length, 200);
  assert.ok(!subjectToNote(`fix: ${"б".repeat(200)}`).endsWith("…"));
});

test("more than thirty notes are capped with a counting last line", () => {
  const subjects = Array.from({ length: 45 }, (_, index) => `feat: change ${index}`);
  const lines = parseNotes(buildDraftNotes(subjects));
  assert.equal(lines.length, MAX_NOTES);
  assert.equal(lines[0], "Change 0");
  assert.equal(lines[28], "Change 28");
  assert.equal(lines[29], "И ещё 16 изменений");
  const forms = (count) => {
    const subs = Array.from({ length: 29 + count }, (_, index) => `feat: c ${index}`);
    return parseNotes(buildDraftNotes(subs)).at(-1);
  };
  assert.equal(forms(2), "И ещё 2 изменения");
  assert.equal(forms(21), "И ещё 21 изменение");
  assert.equal(forms(12), "И ещё 12 изменений");
  // Exactly thirty fit without a counting line.
  const exact = parseNotes(
    buildDraftNotes(Array.from({ length: 30 }, (_, index) => `feat: c ${index}`)),
  );
  assert.equal(exact.length, 30);
  assert.equal(exact[29], "C 29");
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "draft-notes-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  await mkdir(join(dir, "tools/standalone-release"), { recursive: true });
  await mkdir(join(dir, "apps/standalone"), { recursive: true });
  return dir;
}

async function commit(dir, file, content, message) {
  await writeFile(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

const releases = (...versions) =>
  JSON.stringify({
    schemaVersion: 1,
    releases: versions.map((version) => ({ version, protocol: 6, minProtocol: 1 })),
  });

test("the marker is the newest standalone tag when there is one", async () => {
  const dir = await repo();
  const first = await commit(dir, "apps/standalone/a.txt", "1", "feat: one");
  git(dir, "tag", "standalone-v0.1.0");
  await commit(dir, "apps/standalone/a.txt", "2", "feat: two");
  git(dir, "tag", "standalone-v0.2.0");
  await commit(dir, "apps/standalone/a.txt", "3", "feat: three");
  const marker = findReleaseMarker({ cwd: dir, version: "0.3.0" });
  assert.equal(marker.kind, "tag");
  assert.equal(marker.ref, "standalone-v0.2.0");
  assert.notEqual(marker.ref, first);
});

test("without tags the marker is the commit that recorded the previous release", async () => {
  const dir = await repo();
  const file = "tools/standalone-release/releases.json";
  await commit(dir, file, releases("0.1.0"), "chore: release 0.1.0");
  const recorded = git(dir, "rev-parse", "HEAD");
  await commit(dir, "apps/standalone/a.txt", "1", "feat: after");
  // The version being built is not recorded yet: the newest recording is the marker.
  assert.deepEqual(findReleaseMarker({ cwd: dir, version: "0.2.0" }), {
    kind: "releases",
    ref: recorded,
  });
  // Already recorded (the release commit itself): the one before it is.
  await commit(dir, file, releases("0.1.0", "0.2.0"), "chore: release 0.2.0");
  assert.deepEqual(findReleaseMarker({ cwd: dir, version: "0.2.0" }), {
    kind: "releases",
    ref: recorded,
  });
});

test("with neither tags nor a recorded release there is no marker", async () => {
  const dir = await repo();
  await commit(dir, "apps/standalone/a.txt", "1", "feat: one");
  assert.deepEqual(findReleaseMarker({ cwd: dir, version: "0.1.0" }), {
    kind: "none",
    ref: null,
  });
});

test("the command writes a draft that parseNotes accepts, from this repository's history", async () => {
  const out = await mkdtemp(join(tmpdir(), "notes-draft-out-"));
  execFileSync(
    process.execPath,
    [join(import.meta.dirname, "..", "draft-notes.mjs"), "--output-dir", out],
    {
      cwd: join(import.meta.dirname, "..", "..", ".."),
    },
  );
  const lines = parseNotes(await readFile(join(out, NOTES_DRAFT_FILE), "utf8"));
  assert.ok(lines.length >= 1 && lines.length <= MAX_NOTES);
  assert.equal(NOTES_DRAFT_FILE, "notes.draft.txt");
});
