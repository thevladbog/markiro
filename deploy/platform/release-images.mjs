/** CLI operations use explicit paths and masked environment identity; no shell Docker commands. */
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureImages, exportImages, loadImages, verifyArtifact } from "./release-artifact.mjs";
import { publishImages } from "./release-publish.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";
import { validatePlatformCiEvidence } from "./release-evidence.mjs";
import { releaseIo } from "./release-io.mjs";

export async function main(args, env = process.env, io = releaseIo) {
  const [verb, directory, extra] = args;
  if (!directory || args.length > 3) throw new Error("invalid platform release command");
  const ciExpected = {
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.RELEASE_SHA,
    runId: env.CI_RUN_ID,
  };
  if (verb === "fetch-ci" || verb === "validate-ci") {
    if (extra) throw new Error("invalid platform release command");
    if (verb === "fetch-ci") {
      const value = await fetchPlatformCi(ciExpected, env.GH_TOKEN);
      await io.createDirectory(directory);
      await io.writeJson(join(directory, "run.json"), value.run);
      await io.writeJson(join(directory, "jobs.json"), value.jobs);
    }
    const identity = validatePlatformCiEvidence(
      JSON.parse(await io.readText(join(directory, "run.json"))),
      JSON.parse(await io.readText(join(directory, "jobs.json"))),
      ciExpected,
    );
    if (env.GITHUB_OUTPUT)
      await fs.appendFile(
        env.GITHUB_OUTPUT,
        `ci-run-id=${identity.ciRunId}\nci-run-attempt=${identity.ciRunAttempt}\n`,
      );
    return identity;
  }
  const expected = {
    sourceSha: env.RELEASE_SHA,
    toolingSha: env.RELEASE_SHA,
    workflowRunId: env.GITHUB_RUN_ID,
    workflowRunAttempt: env.GITHUB_RUN_ATTEMPT,
    ciRunId: env.CI_RUN_ID,
    ciRunAttempt: env.CI_RUN_ATTEMPT,
  };
  if (verb === "capture" && !extra)
    return io.writeJson(directory, await captureImages(expected, io));
  if (verb === "export" && extra)
    return exportImages(
      { directory, expected, captured: JSON.parse(await io.readText(extra)) },
      io,
    );
  if (verb === "verify" && !extra) return verifyArtifact({ directory, expected }, io);
  if (verb === "load" && !extra) return loadImages({ directory, expected }, io);
  if (verb === "publish" && extra)
    return publishImages({ directory, expected, outputDirectory: extra }, io);
  throw new Error("invalid platform release command");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Platform release operation failed; raw output withheld.\n");
    process.exitCode = 1;
  });
}
