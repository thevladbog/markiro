import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalId,
  validSelection,
  validatePublishedPlatformRelease,
} from "./release-admission.mjs";
import {
  REPOSITORY,
  fetchPublisher,
  githubTransport,
  validateArtifact,
} from "./admission-github.mjs";
import { extractReleaseZip } from "./admission-archive.mjs";
import { inspectRegistryImage } from "./admission-registry.mjs";
import { sha256RegularFile } from "./release-evidence.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";

async function absent(path) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output exists");
}
async function writeExclusive(path, record) {
  let file;
  let created = false;
  try {
    file = await fs.open(path, "wx", 0o600);
    created = true;
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(record, null, 2) + "\n");
    await file.sync();
    await file.close();
    file = undefined;
  } catch {
    await file?.close().catch(() => undefined);
    if (created) await fs.unlink(path).catch(() => undefined);
    throw new Error("output failed");
  }
}
/** Injectable request/run boundaries are read-only; default ZIP and filesystem remain real.
 * tempRoot is for private test isolation. token is environment-only at the CLI boundary.
 */
export async function admitPlatformRelease(
  { sourceSha, workflowRunId, workflowRunAttempt, artifactId, outputFile },
  adapters = {},
) {
  let phase = "input";
  let directory;
  try {
    const expected = { sourceSha, workflowRunId, workflowRunAttempt };
    const token = adapters.token ?? process.env.GH_TOKEN;
    if (
      !validSelection(expected) ||
      !canonicalId(artifactId) ||
      typeof outputFile !== "string" ||
      !outputFile ||
      typeof token !== "string" ||
      !token
    )
      throw new Error();
    phase = "output";
    await absent(outputFile);
    const transport = githubTransport(token, adapters.request);
    phase = "publisher";
    const publisher = await fetchPublisher(expected, transport);
    phase = "artifact";
    const artifact = validateArtifact(
      await transport.json(`/artifacts/${artifactId}`),
      publisher,
      artifactId,
    );
    phase = "archive";
    const bytes = await transport.download(artifactId);
    if (bytes.length !== artifact.size) throw new Error();
    directory = await fs.mkdtemp(join(adapters.tempRoot ?? tmpdir(), "platform-admission-"));
    await fs.chmod(directory, 0o700);
    const archive = join(directory, "release.zip");
    await fs.writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    if ((await sha256RegularFile(archive)) !== artifact.sha256) throw new Error();
    const texts = await extractReleaseZip(archive);
    if ((await sha256RegularFile(archive)) !== artifact.sha256) throw new Error();
    phase = "evidence";
    const { manifest, verified } = validatePublishedPlatformRelease({ ...texts, expected });
    phase = "ci";
    const ci = await fetchPlatformCi(
      { repository: REPOSITORY, sourceSha, runId: verified.ciRunId },
      token,
      transport.ciRequest,
    );
    if (
      ci.identity.ciRunId !== verified.ciRunId ||
      ci.identity.ciRunAttempt !== verified.ciRunAttempt
    )
      throw new Error();
    phase = "registry";
    const registry = {};
    for (const name of ["api", "edge"])
      registry[name] = await inspectRegistryImage(
        manifest[name],
        verified.images[name].id,
        adapters.run,
      );
    const record = {
      version: 1,
      kind: "platform-release-admission",
      repository: REPOSITORY,
      manifest,
      verified,
      artifact: { id: artifact.id, sha256: artifact.sha256 },
      publisher: { runId: workflowRunId, runAttempt: workflowRunAttempt },
      ci: { runId: ci.identity.ciRunId, runAttempt: ci.identity.ciRunAttempt },
      registry,
    };
    // Cleanup precedes publication: a cleanup failure cannot leave a success record.
    phase = "cleanup";
    await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
    phase = "output";
    await writeExclusive(outputFile, record);
    return record;
  } catch {
    throw new Error(`platform admission failed: ${phase}`);
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
export async function main(args) {
  if (args.length !== 5) throw new Error("platform admission failed: input");
  const [sourceSha, workflowRunId, workflowRunAttempt, artifactId, outputFile] = args;
  return admitPlatformRelease({
    sourceSha,
    workflowRunId,
    workflowRunAttempt,
    artifactId,
    outputFile,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then(() => process.stdout.write("platform release admission recorded\n"))
    .catch((error) => {
      const message =
        /^platform admission failed: (input|output|publisher|artifact|archive|evidence|ci|registry|cleanup)$/.test(
          error.message,
        )
          ? error.message
          : "platform admission failed: input";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
