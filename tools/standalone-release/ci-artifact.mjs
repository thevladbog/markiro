import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyPreparedStandaloneRelease } from "./prepare.mjs";

const exec = promisify(execFile);
const decimal = /^[1-9][0-9]{0,19}$/u;
const gitSha = /^[a-f0-9]{40}$/u;
const requiredJobs = [
  "ci-required",
  "standalone-rust",
  "standalone-windows-build",
  "standalone-windows-tests",
];
export const MAX_INSTALLER_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_INSTALLER_BYTES + 2 * 1024 * 1024;

function validateRun({ repository, repositoryId, runId, run }) {
  if (
    !decimal.test(runId) ||
    String(run?.id) !== runId ||
    ![".github/workflows/ci.yml", ".github/workflows/ci.yml@refs/heads/main"].includes(run.path) ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.head_branch !== "main" ||
    !gitSha.test(run.head_sha ?? "") ||
    !decimal.test(String(run.repository?.id)) ||
    (repositoryId !== undefined && String(run.repository.id) !== repositoryId) ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_repository?.id !== run.repository.id ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("standalone requires a successful CI run on this repository's main branch");
  }
  return run.head_sha;
}

/** GitHub's run, jobs and artifact metadata must all refer to the same build. */
export function validateStandaloneCiArtifact({
  repository,
  repositoryId,
  runId,
  artifactId,
  run,
  jobs,
  artifact,
}) {
  const sourceSha = validateRun({ repository, repositoryId, runId, run });
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      job.run_id !== run.id ||
      !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1 ||
      job.run_attempt > run.run_attempt ||
      (name === "ci-required" && job.run_attempt !== run.run_attempt) ||
      job.head_sha !== sourceSha ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    ) {
      throw new Error(`standalone source CI job ${name} must have succeeded`);
    }
  }
  const association = artifact?.workflow_run;
  const built = jobs.find((job) => job.name === "standalone-windows-build");
  const createdAt = Date.parse(artifact?.created_at);
  if (
    !decimal.test(artifactId) ||
    String(artifact?.id) !== artifactId ||
    artifact.name !== `standalone-installer-${sourceSha}` ||
    artifact.expired !== false ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "") ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_ARCHIVE_BYTES ||
    association?.id !== run.id ||
    association.repository_id !== run.repository.id ||
    association.head_repository_id !== run.repository.id ||
    association.head_branch !== "main" ||
    association.head_sha !== sourceSha ||
    !(createdAt >= Date.parse(built.started_at) && createdAt <= Date.parse(built.completed_at))
  ) {
    throw new Error("standalone installer artifact does not match the successful Windows build");
  }
  return sourceSha;
}

// Keep download/extraction subprocesses separate from catalog credentials.
function commandEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("RELEASES_S3_") || name.startsWith("ACTIONS_ID_TOKEN_")) delete env[name];
  }
  return env;
}

async function request(path, maxBuffer) {
  try {
    const { stdout } = await exec("gh", ["api", "--hostname", "github.com", path], {
      encoding: "buffer",
      maxBuffer,
      timeout: 180_000,
      env: commandEnvironment(),
    });
    return stdout;
  } catch {
    throw new Error("GitHub Actions source evidence is unavailable through gh api");
  }
}

const gh = {
  async json(path) {
    return JSON.parse(await request(path, 8 * 1024 * 1024));
  },
  archive(path) {
    return request(path, MAX_ARCHIVE_BYTES);
  },
};

// zipfile verifies CRC and local/central names. No archive-supplied path is used before
// matching the entire flat Windows CI asset set and checking every entry's type and size.
const extract = String.raw`
import pathlib, re, shutil, stat, sys, zipfile

archive, directory, max_installer = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    names = [entry.filename for entry in entries]
    installer_pattern = r"markiro-standalone-((?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2})-windows-x86_64-setup\.exe"
    installers = [match for name in names if (match := re.fullmatch(installer_pattern, name))]
    if len(installers) != 1:
        raise ValueError("expected exactly one installer")
    installer = installers[0].group(0)
    version = installers[0].group(1)
    expected = {installer, "SHA256SUMS", "release-evidence.json", f"markiro-standalone-{version}.update-draft.json", "notes.draft.txt"}
    if len(names) != len(expected) or set(names) != expected:
        raise ValueError("unexpected Windows CI archive contents")
    for entry in entries:
        maximum = max_installer if entry.filename == installer else 65536
        minimum = 0 if entry.filename == "notes.draft.txt" else 1
        if (entry.orig_filename != entry.filename or entry.is_dir() or
                stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG) or
                entry.flag_bits & 1 or not minimum <= entry.file_size <= maximum):
            raise ValueError("unexpected Windows CI archive entry")
        with source.open(entry) as file, (directory / entry.filename).open("xb") as output:
            shutil.copyfileobj(file, output, length=1024 * 1024)
        if (directory / entry.filename).stat().st_size != entry.file_size:
            raise ValueError("Windows CI archive entry size changed during extraction")
    print(version)
`;

/** Read and verify the same immutable Windows CI artifact on the Mac and on GitHub. */
export async function loadStandaloneCiArtifact({
  repository,
  repositoryId,
  runId,
  artifactId,
  directory,
  github = gh,
}) {
  if (
    repository !== "thevladbog/markiro" ||
    !decimal.test(runId ?? "") ||
    (artifactId !== undefined && !decimal.test(artifactId))
  ) {
    throw new Error("invalid standalone CI run or artifact ID");
  }
  const repo = `repos/${repository}`;
  const runPath = `${repo}/actions/runs/${runId}`;
  const run = await github.json(runPath);
  const sourceSha = validateRun({ repository, repositoryId, runId, run });
  const [comparison, jobListing, artifactListing] = await Promise.all([
    github.json(`${repo}/compare/${sourceSha}...main?per_page=1`),
    github.json(`${runPath}/jobs?filter=latest&per_page=100`),
    github.json(`${runPath}/artifacts?per_page=100`),
  ]);
  if (
    !["identical", "ahead"].includes(comparison.status) ||
    comparison.merge_base_commit?.sha !== sourceSha
  ) {
    throw new Error("standalone source CI commit is no longer on main");
  }
  if (
    !Array.isArray(jobListing.jobs) ||
    jobListing.total_count !== jobListing.jobs.length ||
    !Array.isArray(artifactListing.artifacts) ||
    artifactListing.total_count !== artifactListing.artifacts.length
  ) {
    throw new Error("incomplete standalone CI jobs or artifacts list");
  }
  const matches = artifactListing.artifacts.filter(
    (artifact) => artifact.name === `standalone-installer-${sourceSha}`,
  );
  if (matches.length !== 1 || (artifactId !== undefined && String(matches[0].id) !== artifactId)) {
    throw new Error("standalone CI run must have exactly one matching installer artifact");
  }
  artifactId = String(matches[0].id);
  const artifactPath = `${repo}/actions/artifacts/${artifactId}`;
  const artifact = await github.json(artifactPath);
  validateStandaloneCiArtifact({
    repository,
    repositoryId,
    runId,
    artifactId,
    run,
    jobs: jobListing.jobs,
    artifact,
  });
  const archive = await github.archive(`${artifactPath}/zip`);
  const archiveSha = createHash("sha256").update(archive).digest("hex");
  if (archive.length !== artifact.size_in_bytes || `sha256:${archiveSha}` !== artifact.digest) {
    throw new Error("standalone CI artifact archive does not match GitHub's SHA-256 and size");
  }

  const target = resolve(directory);
  const scratch = await mkdtemp(join(tmpdir(), "markiro-standalone-ci-"));
  try {
    const zip = join(scratch, "installer.zip");
    await writeFile(zip, archive, { mode: 0o600, flag: "wx" });
    await mkdir(target, { mode: 0o700 });
    try {
      const { stdout } = await exec(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-c", extract, zip, target, String(MAX_INSTALLER_BYTES)],
        { encoding: "utf8", maxBuffer: 8192, timeout: 120_000, env: commandEnvironment() },
      ).catch((error) => {
        if (error.code === "ENOENT")
          throw new Error("Python 3 is required to extract the standalone CI archive");
        throw new Error(
          "standalone CI archive does not contain the expected regular release files",
        );
      });
      const version = stdout.trim();
      const prepared = await verifyPreparedStandaloneRelease({ directory: target, version });
      if (
        prepared.evidence.source.repository !== repository ||
        prepared.evidence.source.sha !== sourceSha
      ) {
        throw new Error("standalone installer evidence does not name the CI source on main");
      }
      return {
        ...prepared,
        repository,
        runId,
        runAttempt: run.run_attempt,
        artifactId,
        archiveSha,
        sourceSha,
        version,
      };
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
