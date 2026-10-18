import { join } from "node:path";
import { checkImageIds, verifyArtifact } from "./release-artifact.mjs";
import { resolvePublishedDigest } from "./release-evidence.mjs";
import { createPlatformManifest } from "./release-manifest.mjs";
import { releaseIo } from "./release-io.mjs";

/** Fresh output directory prevents stale complete manifests from surviving a failed retry. */
export async function publishImages(
  { directory, expected, outputDirectory, createdAt = new Date().toISOString() },
  io = releaseIo,
) {
  const verified = await verifyArtifact({ directory, expected }, io);
  await io.createDirectory(outputDirectory);
  const evidence = { status: "incomplete", verified, published: {}, createdAt };
  const evidencePath = join(outputDirectory, "release-evidence.json");
  await io.writeJson(evidencePath, evidence);
  try {
    // Validate the date before the first irreversible operation, too.
    createPlatformManifest({
      sourceSha: verified.sourceSha,
      toolingSha: verified.toolingSha,
      workflowRunId: verified.workflowRunId,
      createdAt,
      apiDigest: verified.images.api.id,
      edgeDigest: verified.images.edge.id,
    });
    await checkImageIds(verified, io);
    for (const [name, image] of Object.entries(verified.images)) {
      // Recheck both immediately before each push, including after the first push.
      await checkImageIds(verified, io);
      await io.run(["push", image.tag]);
      evidence.published[name] = { tag: image.tag, id: image.id, pushCompleted: true };
      await io.writeJson(evidencePath, evidence);
      const repository = image.tag.split(":platform-")[0];
      const digest = resolvePublishedDigest(
        JSON.parse(
          await io.run(["image", "inspect", "--format", "{{json .RepoDigests}}", image.tag]),
        ),
        repository,
      );
      evidence.published[name].digest = digest;
      await io.writeJson(evidencePath, evidence);
    }
    await checkImageIds(verified, io);
    const manifest = createPlatformManifest({
      sourceSha: verified.sourceSha,
      toolingSha: verified.toolingSha,
      workflowRunId: verified.workflowRunId,
      createdAt,
      apiDigest: evidence.published.api.digest,
      edgeDigest: evidence.published.edge.digest,
    });
    await io.writeJson(join(outputDirectory, "platform-manifest.json"), manifest);
    evidence.status = "complete";
    await io.writeJson(evidencePath, evidence);
    return manifest;
  } catch {
    throw new Error("platform publication failed; inspect incomplete publication evidence");
  }
}
