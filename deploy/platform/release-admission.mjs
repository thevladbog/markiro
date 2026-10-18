import { parseVerifiedImagesEvidence } from "./release-evidence.mjs";
import { parsePlatformManifest } from "./release-manifest.mjs";

export function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function canonicalId(value) {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]*$/.exec(value)?.[0] === value &&
    Number.isSafeInteger(Number(value))
  );
}
export function validSelection(expected) {
  return (
    exactKeys(expected, ["sourceSha", "workflowRunId", "workflowRunAttempt"]) &&
    typeof expected.sourceSha === "string" &&
    /^[a-f0-9]{40}$/.exec(expected.sourceSha)?.[0] === expected.sourceSha &&
    canonicalId(expected.workflowRunId) &&
    canonicalId(expected.workflowRunAttempt)
  );
}
export function validatePublishedPlatformRelease({ manifestText, evidenceText, expected }) {
  try {
    if (
      !validSelection(expected) ||
      typeof manifestText !== "string" ||
      typeof evidenceText !== "string"
    )
      throw new Error();
    const evidence = JSON.parse(evidenceText);
    if (
      !exactKeys(evidence, ["status", "verified", "published", "createdAt"]) ||
      evidence.status !== "complete" ||
      !exactKeys(evidence.published, ["api", "edge"]) ||
      !canonicalId(evidence.verified?.ciRunId) ||
      !canonicalId(evidence.verified?.ciRunAttempt)
    )
      throw new Error();
    const verified = parseVerifiedImagesEvidence(JSON.stringify(evidence.verified), {
      ...expected,
      toolingSha: expected.sourceSha,
      ciRunId: evidence.verified.ciRunId,
      ciRunAttempt: evidence.verified.ciRunAttempt,
    });
    const manifest = parsePlatformManifest(manifestText, expected.workflowRunId);
    if (
      manifest.sourceSha !== expected.sourceSha ||
      manifest.toolingSha !== expected.sourceSha ||
      manifest.createdAt !== evidence.createdAt
    )
      throw new Error();
    for (const name of ["api", "edge"]) {
      const published = evidence.published[name];
      if (
        !exactKeys(published, ["tag", "id", "pushCompleted", "digest"]) ||
        published.tag !== verified.images[name].tag ||
        published.id !== verified.images[name].id ||
        published.pushCompleted !== true ||
        typeof published.digest !== "string" ||
        /^sha256:[a-f0-9]{64}$/.exec(published.digest)?.[0] !== published.digest ||
        manifest[name] !== `${verified.images[name].tag.split(":platform-")[0]}@${published.digest}`
      )
        throw new Error();
    }
    return { manifest, verified };
  } catch {
    throw new Error("platform admission failed: evidence");
  }
}
