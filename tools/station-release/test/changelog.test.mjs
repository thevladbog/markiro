import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildStableChangelog, stationChangeTouchesScope } from "../changelog.mjs";

const execFile = promisify(execFileCallback);
const changelogCli = fileURLToPath(new URL("../changelog.mjs", import.meta.url));
const fromSha = "a".repeat(40);
const toSha = "b".repeat(40);
const compareUrl = `https://github.com/thevladbog/markiro/compare/${fromSha}...${toSha}`;

function validInput(overrides = {}) {
  return {
    version: "0.1.1",
    sourceBetaTag: "station-v0.1.1-beta.4",
    previousStableTag: "station-v0.1.0",
    fromSha,
    toSha,
    compareUrl,
    highlights: "Ускорена работа со сканером.",
    entries: [
      {
        sha: "c".repeat(40),
        subject: "feat(station): add scan queue",
        body: "",
        files: ["apps/station/src/App.tsx"],
      },
      {
        sha: "d".repeat(40),
        subject: "fix(station): recover printing",
        body: "",
        files: ["apps/station/src/pages/WorkScreen.tsx"],
      },
      {
        sha: "e".repeat(40),
        subject: "chore(station): prepare 0.1.1-beta.4",
        body: "",
        files: ["apps/station/src-tauri/Cargo.toml"],
      },
    ],
    ...overrides,
  };
}

test("renders optional highlights and deterministic Russian sections", () => {
  const notes = buildStableChangelog(validInput());
  assert.match(notes, /## Главное в релизе/);
  assert.match(notes, /## Что нового/);
  assert.match(notes, /feat\(station\): add scan queue/);
  assert.match(notes, /## Исправления/);
  assert.match(notes, /fix\(station\): recover printing/);
  assert.match(notes, /## Прочие изменения/);
  assert.doesNotMatch(notes, /prepare 0\.1\.1-beta/);
  assert.match(notes, new RegExp(compareUrl.replaceAll(".", "\\.")));
});

test("omits highlights heading when input is empty and identifies the first stable", () => {
  const notes = buildStableChangelog(
    validInput({ previousStableTag: null, highlights: "", entries: [] }),
  );
  assert.doesNotMatch(notes, /Главное в релизе/);
  assert.match(notes, /Первый стабильный релиз/);
  assert.match(notes, /station-v0\.1\.1-beta\.4/);
});

test("normalizes merge titles, de-duplicates subjects and excludes unrelated changes", () => {
  const notes = buildStableChangelog(
    validInput({
      highlights: "",
      entries: [
        {
          sha: "1".repeat(40),
          subject: "Merge pull request #42 from example/scan",
          body: "\nfeat(station): add scanner recovery (#42)\n\nDetails",
          files: ["apps/station/src/scanner.ts"],
        },
        {
          sha: "2".repeat(40),
          subject: "feat(station): add scanner recovery",
          body: "",
          files: ["apps/station/src/scanner.ts"],
        },
        {
          sha: "3".repeat(40),
          subject: "feat(domain): unrelated parser",
          body: "",
          files: ["packages/domain/src/parser.ts"],
        },
      ],
    }),
  );
  assert.equal(notes.match(/add scanner recovery/g)?.length, 1);
  assert.doesNotMatch(notes, /unrelated parser/);
});

test("recognizes only the reviewed Station release scope", () => {
  for (const path of [
    "apps/station/src/App.tsx",
    "tools/station-release/version.mjs",
    ".github/workflows/station-beta-release.yml",
    "docs/runbooks/station-stable-release.md",
    "docs/acceptance/station-stable-release.md",
    "packages/db/src/sqlite/migrations.ts",
  ]) {
    assert.equal(stationChangeTouchesScope([path]), true, path);
  }
  assert.equal(stationChangeTouchesScope(["apps/api/src/main.ts"]), false);
  assert.equal(stationChangeTouchesScope(["../apps/station/src/App.tsx"]), false);
});

test("rejects unsafe metadata, highlights, duplicate commits and malformed files", () => {
  const invalidInputs = [
    validInput({ fromSha: "A".repeat(40) }),
    validInput({ compareUrl: "https://evil.example/compare/a...b" }),
    validInput({ highlights: "github_pat_secret" }),
    validInput({ highlights: `bad\u0000text` }),
    validInput({ highlights: "я".repeat(4097) }),
    validInput({ entries: [validInput().entries[0], validInput().entries[0]] }),
    validInput({
      entries: [
        {
          ...validInput().entries[0],
          files: ["../apps/station/src/App.tsx"],
        },
      ],
    }),
  ];
  for (const input of invalidInputs) {
    assert.throws(() => buildStableChangelog(input), /invalid station stable changelog/);
  }
});

test("CLI collects bounded git history and creates output exclusively", async () => {
  const repository = await mkdtemp(join(tmpdir(), "markiro-changelog-git-"));
  await execFile("git", ["init"], { cwd: repository });
  await execFile("git", ["config", "user.name", "Markiro Test"], { cwd: repository });
  await execFile("git", ["config", "user.email", "test@markiro.local"], { cwd: repository });
  await mkdir(join(repository, "apps/station/src"), { recursive: true });
  await writeFile(join(repository, "apps/station/src/base.ts"), "export const base = true;\n");
  await execFile("git", ["add", "apps/station/src/base.ts"], { cwd: repository });
  await execFile("git", ["commit", "-m", "chore(station): baseline"], { cwd: repository });
  const { stdout: from } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repository });
  await writeFile(join(repository, "apps/station/src/base.ts"), "export const base = false;\n");
  await execFile("git", ["add", "apps/station/src/base.ts"], { cwd: repository });
  await execFile("git", ["commit", "-m", "fix(station): recover scanner"], {
    cwd: repository,
  });
  const { stdout: to } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repository });
  const metadataPath = join(repository, "metadata.json");
  const highlightsPath = join(repository, "highlights.txt");
  const outputPath = join(repository, "release-notes.md");
  const cleanFrom = from.trim();
  const cleanTo = to.trim();
  await writeFile(
    metadataPath,
    JSON.stringify({
      version: "0.1.1",
      sourceBetaTag: "station-v0.1.1-beta.4",
      previousStableTag: "station-v0.1.0",
      fromSha: cleanFrom,
      toSha: cleanTo,
      compareUrl: `https://github.com/thevladbog/markiro/compare/${cleanFrom}...${cleanTo}`,
    }),
  );
  await writeFile(highlightsPath, "");

  const invalidMetadataPath = join(repository, "invalid-metadata.json");
  await writeFile(
    invalidMetadataPath,
    JSON.stringify({
      version: "0.1.1",
      sourceBetaTag: "station-v0.1.1-beta.4",
      previousStableTag: "station-v0.1.0",
      fromSha: "--help",
      toSha: cleanTo,
      compareUrl: `https://github.com/thevladbog/markiro/compare/--help...${cleanTo}`,
    }),
  );
  await assert.rejects(
    execFile(
      process.execPath,
      [
        changelogCli,
        "generate",
        invalidMetadataPath,
        highlightsPath,
        join(repository, "invalid-notes.md"),
      ],
      { cwd: repository, maxBuffer: 1024 * 1024 },
    ),
    (error) => {
      assert.match(error.stderr, /invalid station stable changelog/);
      assert.doesNotMatch(error.stderr, /ambiguous argument|unknown option/i);
      return true;
    },
  );

  const args = [changelogCli, "generate", metadataPath, highlightsPath, outputPath];
  await execFile(process.execPath, args, { cwd: repository, maxBuffer: 1024 * 1024 });
  assert.match(await readFile(outputPath, "utf8"), /fix\(station\): recover scanner/);
  await assert.rejects(
    execFile(process.execPath, args, { cwd: repository, maxBuffer: 1024 * 1024 }),
  );
});
