import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NOTES_DRAFT_FILE } from "./prepare.mjs";
import { assertOutsideRepository, manifestFileName, updateFolderName } from "./sign-update.mjs";

const repository = "thevladbog/markiro";
const publisherTag = "standalone-publisher-v1";
const positiveId = /^[1-9][0-9]{0,19}$/u;

function runProcess(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

export async function releaseStandaloneLocally(
  { runId, artifactId, key, kid, minUpgradeFrom, notesPath, outputDir },
  {
    loadArtifact = async (input) =>
      (await import("./ci-artifact.mjs")).loadStandaloneCiArtifact(input),
    verifySigned = async (prepared, compact) =>
      (await import("./publish-catalog.mjs")).verifySignedStandaloneRelease(prepared, compact),
    run = runProcess,
    report = console.log,
  } = {},
) {
  if (!positiveId.test(runId ?? "") || (artifactId !== undefined && !positiveId.test(artifactId))) {
    throw new Error("CI run and artifact identifiers must be positive integers");
  }
  if (!key || !kid || !minUpgradeFrom) {
    throw new Error("--key, --kid and --min-upgrade-from are required");
  }
  const keyPath = await assertOutsideRepository(resolve(key), "the release key");
  const work = await mkdtemp(join(tmpdir(), "markiro-standalone-release-"));
  const signedDirectory = await assertOutsideRepository(
    outputDir === undefined ? join(work, "signed") : resolve(outputDir),
    "the signed update",
  );
  const prepared = await loadArtifact({
    repository,
    runId,
    artifactId,
    directory: join(work, "ci"),
  });
  report(`Автоном ${prepared.version} · CI ${prepared.runId} · ${prepared.sourceSha}`);

  // Reuse the existing signer with a real TTY. It keeps the key and passphrase local.
  await run(
    process.execPath,
    [
      join(import.meta.dirname, "sign-update.mjs"),
      "--release-dir",
      prepared.directory,
      "--notes",
      notesPath === undefined ? join(prepared.directory, NOTES_DRAFT_FILE) : resolve(notesPath),
      "--min-upgrade-from",
      minUpgradeFrom,
      "--channel",
      "stable",
      "--key",
      keyPath,
      "--kid",
      kid,
      "--output-dir",
      signedDirectory,
    ],
    { stdio: "inherit" },
  );
  const folder = join(signedDirectory, updateFolderName(prepared.version));
  const compact = (await readFile(join(folder, manifestFileName(prepared.version)), "utf8")).trim();
  await verifySigned(prepared, compact);

  // The workflow retrieves the original installer itself. Only the signed public manifest
  // and its artifact identifiers cross stdin. A lost dispatch response needs reconciliation.
  report(`Подписанный пакет сохранён в ${folder}`);
  await run(
    "gh",
    [
      "workflow",
      "run",
      "standalone-stable-release.yml",
      "--repo",
      repository,
      "--ref",
      publisherTag,
      "--json",
    ],
    {
      input: JSON.stringify({
        ci_run_id: prepared.runId,
        artifact_id: prepared.artifactId,
        update_jws: compact,
      }),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  return { folder };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: {
      "ci-run-id": { type: "string" },
      "artifact-id": { type: "string" },
      notes: { type: "string" },
      "min-upgrade-from": { type: "string" },
      key: { type: "string" },
      kid: { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  await releaseStandaloneLocally({
    runId: values["ci-run-id"],
    artifactId: values["artifact-id"],
    notesPath: values.notes,
    minUpgradeFrom: values["min-upgrade-from"],
    key: values.key,
    kid: values.kid,
    outputDir: values["output-dir"],
  });
}
