import { join } from "node:path";
import { createVerifiedImagesEvidence, parseVerifiedImagesEvidence } from "./release-evidence.mjs";
import { releaseIo } from "./release-io.mjs";

const repositories = {
  api: "ghcr.io/thevladbog/markiro-api",
  edge: "ghcr.io/thevladbog/markiro-platform-edge",
};
function record(expected, images, archiveSha256 = "0".repeat(64)) {
  return createVerifiedImagesEvidence({
    version: 1,
    serverProfile: "platform-only",
    uiProfile: "platform-only",
    ...expected,
    archiveSha256,
    images,
  });
}
function imageTags(expected) {
  return Object.fromEntries(
    Object.entries(repositories).map(([name, repository]) => [
      name,
      `${repository}:platform-${expected.sourceSha}-${expected.workflowRunId}-${expected.workflowRunAttempt}`,
    ]),
  );
}
export async function checkImageIds(evidence, io = releaseIo) {
  for (const image of Object.values(evidence.images)) {
    if ((await io.run(["image", "inspect", "--format", "{{.Id}}", image.tag])) !== image.id)
      throw new Error("platform image identity mismatch");
  }
}

/** Capture before the harness; export must still see both of these exact IDs. */
export async function captureImages(expected, io = releaseIo) {
  const tags = imageTags(expected);
  // Validate the input identities before using them in Docker arguments.
  record(
    expected,
    Object.fromEntries(
      Object.entries(tags).map(([name, tag]) => [name, { tag, id: `sha256:${"0".repeat(64)}` }]),
    ),
  );
  const images = {};
  for (const [name, repository] of Object.entries(repositories)) {
    images[name] = {
      tag: tags[name],
      id: await io.run([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        `${repository}:${expected.sourceSha}`,
      ]),
    };
  }
  return record(expected, images);
}

export async function exportImages({ directory, expected, captured }, io = releaseIo) {
  parseVerifiedImagesEvidence(JSON.stringify(captured), expected);
  const current = await captureImages(expected, io);
  for (const name of Object.keys(repositories))
    if (current.images[name].id !== captured.images[name].id)
      throw new Error("platform image identity mismatch");
  await io.createDirectory(directory);
  // Tag by ID, not by the mutable build tag, only after the harness succeeds.
  for (const image of Object.values(captured.images)) await io.run(["tag", image.id, image.tag]);
  await checkImageIds(captured, io);
  const archive = join(directory, "images.tar");
  await io.run([
    "save",
    "--output",
    archive,
    ...Object.values(captured.images).map((image) => image.tag),
  ]);
  await checkImageIds(captured, io);
  const evidence = record(expected, captured.images, await io.hash(archive));
  await io.writeJson(join(directory, "verified-images.json"), evidence);
  return evidence;
}

export async function verifyArtifact({ directory, expected }, io = releaseIo) {
  const evidence = parseVerifiedImagesEvidence(
    await io.readText(join(directory, "verified-images.json")),
    expected,
  );
  if ((await io.hash(join(directory, "images.tar"))) !== evidence.archiveSha256)
    throw new Error("platform archive hash mismatch");
  return evidence;
}

export async function loadImages(options, io = releaseIo) {
  const evidence = await verifyArtifact(options, io);
  await io.run(["load", "--input", join(options.directory, "images.tar")]);
  await checkImageIds(evidence, io);
  return evidence;
}
