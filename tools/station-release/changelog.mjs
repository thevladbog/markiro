import { execFile as execFileCallback } from "node:child_process";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_GIT_BYTES = 1024 * 1024;
const MAX_HIGHLIGHTS_BYTES = 8 * 1024;
const MAX_ENTRIES = 10_000;
const SHA = /^[0-9a-f]{40}$/;
const SECRET_TEXT = /ghp_|github_pat_|TAURI_SIGNING_PRIVATE_KEY|api[_ -]?key|pairing_code/i;
const UNSAFE_CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DIRECT_STATION_PATHS = [
  "apps/station/",
  "tools/station-release/",
  ".github/workflows/station-",
  "docs/runbooks/station-",
  "docs/acceptance/station-",
  "packages/db/src/sqlite/",
];

function invalid() {
  throw new Error("invalid station stable changelog");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function ensureText(value, { allowEmpty = false, maxBytes = MAX_INPUT_BYTES } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value) > maxBytes ||
    SECRET_TEXT.test(value) ||
    UNSAFE_CONTROL_TEXT.test(value)
  ) {
    invalid();
  }
  return value;
}

function isSafeRepositoryPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path) > 2048 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    UNSAFE_CONTROL_TEXT.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function stationChangeTouchesScope(files) {
  return (
    Array.isArray(files) &&
    files.every(isSafeRepositoryPath) &&
    files.some((path) => DIRECT_STATION_PATHS.some((prefix) => path.startsWith(prefix)))
  );
}

function compareStableVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  return 0;
}

function validateMetadata(input) {
  if (
    !hasExactKeys(input, [
      "version",
      "sourceBetaTag",
      "previousStableTag",
      "fromSha",
      "toSha",
      "compareUrl",
      "highlights",
      "entries",
    ])
  ) {
    invalid();
  }
  const stable = parseStationStableTag(`station-v${input.version}`);
  const beta = parseStationBetaTag(input.sourceBetaTag);
  const previous =
    input.previousStableTag === null ? null : parseStationStableTag(input.previousStableTag);
  if (
    !stable ||
    !beta ||
    beta.major !== stable.major ||
    beta.minor !== stable.minor ||
    beta.patch !== stable.patch ||
    (input.previousStableTag !== null &&
      (!previous || compareStableVersions(previous, stable) >= 0)) ||
    !SHA.test(input.fromSha) ||
    !SHA.test(input.toSha) ||
    input.compareUrl !==
      `https://github.com/thevladbog/markiro/compare/${input.fromSha}...${input.toSha}` ||
    !Array.isArray(input.entries) ||
    input.entries.length > MAX_ENTRIES
  ) {
    invalid();
  }
  ensureText(input.highlights, { allowEmpty: true, maxBytes: MAX_HIGHLIGHTS_BYTES });
}

function normalizedEntry(entry) {
  if (!hasExactKeys(entry, ["sha", "subject", "body", "files"]) || !SHA.test(entry.sha)) {
    invalid();
  }
  ensureText(entry.subject, { maxBytes: 16 * 1024 });
  ensureText(entry.body, { allowEmpty: true, maxBytes: 64 * 1024 });
  if (
    !Array.isArray(entry.files) ||
    entry.files.length > 10_000 ||
    entry.files.some((path) => !isSafeRepositoryPath(path))
  ) {
    invalid();
  }
  const isMerge = /^Merge pull request #\d+\b/.test(entry.subject);
  const mergeTitle = entry.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const display = (isMerge ? mergeTitle : entry.subject)?.trim();
  if (!display) invalid();
  return { ...entry, display };
}

function renderGroup(title, entries) {
  const lines = [`## ${title}`, ""];
  if (entries.length === 0) lines.push("- Нет изменений.");
  else lines.push(...entries.map((entry) => `- ${entry.display}`));
  return lines.join("\n");
}

export function buildStableChangelog(input) {
  validateMetadata(input);
  const seenShas = new Set();
  const seenSubjects = new Set();
  const groups = { features: [], fixes: [], other: [] };

  for (const rawEntry of input.entries) {
    const entry = normalizedEntry(rawEntry);
    if (seenShas.has(entry.sha)) invalid();
    seenShas.add(entry.sha);
    if (!stationChangeTouchesScope(entry.files)) continue;
    if (
      /^chore\(station\):\s*prepare\b/i.test(entry.display) ||
      /station release candidate/i.test(entry.display) ||
      /^chore\(station\):\s*release\b/i.test(entry.display)
    ) {
      continue;
    }
    const subjectKey = entry.display
      .replace(/\s+\(#\d+\)$/, "")
      .trim()
      .toLowerCase();
    if (seenSubjects.has(subjectKey)) continue;
    seenSubjects.add(subjectKey);
    if (/^feat(?:\([^)]*\))?:/i.test(entry.display)) groups.features.push(entry);
    else if (/^fix(?:\([^)]*\))?:/i.test(entry.display)) groups.fixes.push(entry);
    else groups.other.push(entry);
  }

  const sections = [`# Markiro Station ${input.version}`];
  if (input.previousStableTag === null) {
    sections.push(
      `Первый стабильный релиз, подготовленный из принятой beta ${input.sourceBetaTag}.`,
    );
  } else {
    sections.push(
      `Стабильное обновление после ${input.previousStableTag}, подготовленное из принятой beta ${input.sourceBetaTag}.`,
    );
  }
  if (input.highlights.length > 0) {
    sections.push(`## Главное в релизе\n\n${input.highlights}`);
  }
  sections.push(renderGroup("Что нового", groups.features));
  sections.push(renderGroup("Исправления", groups.fixes));
  sections.push(renderGroup("Прочие изменения", groups.other));
  sections.push(
    [
      "## Сведения о выпуске",
      "",
      `- Stable: \`station-v${input.version}\``,
      `- Принятая beta: \`${input.sourceBetaTag}\``,
      `- Предыдущая stable: ${input.previousStableTag ? `\`${input.previousStableTag}\`` : "отсутствует"}`,
      `- Диапазон исходников: \`${input.fromSha}\` … \`${input.toSha}\``,
      "- Authenticode: отсутствует; Windows может показать SmartScreen или неизвестного издателя.",
      "- Установка, обновление и откат выполняются вручную вне активной смены.",
      "",
      `[Полное сравнение изменений](${input.compareUrl})`,
    ].join("\n"),
  );
  const output = `${sections.join("\n\n")}\n`;
  ensureText(output);
  return output;
}

async function readBoundedText(path, { allowEmpty = false } = {}) {
  const info = await lstat(path);
  if (!info.isFile() || (!allowEmpty && info.size <= 0) || info.size > MAX_INPUT_BYTES) invalid();
  return readFile(path, "utf8");
}

async function collectEntries(fromSha, toSha) {
  const { stdout } = await execFile(
    "git",
    ["log", "--first-parent", "--format=%H%x00%s%x00%b%x00%x1e", `${fromSha}..${toSha}`],
    { encoding: "utf8", maxBuffer: MAX_GIT_BYTES },
  );
  const entries = [];
  for (const rawRecord of stdout.split("\x1e")) {
    const record = rawRecord.replace(/^\n+|\n+$/g, "");
    if (!record) continue;
    const [sha, subject, ...bodyParts] = record.split("\0");
    if (!sha || subject === undefined || bodyParts.length === 0) invalid();
    const body = bodyParts.join("\0").replace(/\0$/, "");
    const { stdout: filesText } = await execFile(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
      { encoding: "utf8", maxBuffer: MAX_GIT_BYTES },
    );
    entries.push({
      sha,
      subject,
      body,
      files: filesText.split(/\r?\n/).filter(Boolean),
    });
  }
  return entries;
}

async function writeExclusive(path, content) {
  let handle;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) await rm(path, { force: true });
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function main() {
  const [, , command, metadataPath, highlightsPath, outputPath, ...extra] = process.argv;
  if (
    command !== "generate" ||
    !metadataPath ||
    !highlightsPath ||
    !outputPath ||
    extra.length > 0
  ) {
    invalid();
  }
  let metadata;
  try {
    metadata = JSON.parse(await readBoundedText(metadataPath));
  } catch (error) {
    if (error?.message === "invalid station stable changelog") throw error;
    invalid();
  }
  if (
    !hasExactKeys(metadata, [
      "version",
      "sourceBetaTag",
      "previousStableTag",
      "fromSha",
      "toSha",
      "compareUrl",
    ])
  ) {
    invalid();
  }
  const highlights = await readBoundedText(highlightsPath, { allowEmpty: true });
  validateMetadata({ ...metadata, highlights, entries: [] });
  const entries = await collectEntries(metadata.fromSha, metadata.toSha);
  await writeExclusive(outputPath, buildStableChangelog({ ...metadata, highlights, entries }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
