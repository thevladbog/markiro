import { canonical, ensure, keys, plain } from "../backup/schemas.mjs";
import { validateCatalogConfig } from "../catalog-config.mjs";
import { parsePlatformManifest } from "../release-manifest.mjs";

const publisherKey = "RELEASE_CATALOG_PUBLISHERS_JSON";
const products = ["handheld", "standalone"];
const pinFields = [
  "mode",
  "product",
  "environment",
  "subject",
  "workflowRef",
  "workflowSha",
  "jobWorkflowRef",
  "jobWorkflowSha",
];
const repositoryFields = ["repository", "repositoryId", "ownerId"];

function readEnvironment(input) {
  const value = plain(input);
  ensure(value && typeof value === "object" && !Array.isArray(value));
  for (const [name, entry] of Object.entries(value)) {
    ensure(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
    ensure(typeof entry === "string" && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(entry));
  }
  ensure(validateCatalogConfig(value));
  return value;
}

/** Bind a prepared runtime to the released images and the two reviewed catalog pins. */
export function validateHealthyForwardPublisherDelta(
  before,
  after,
  manifest,
  pinnedPublisherConfig,
) {
  try {
    const current = readEnvironment(before);
    const candidate = readEnvironment(after);
    const approved = plain(pinnedPublisherConfig);
    keys(approved, [...repositoryFields, "workflows"]);
    ensure(approved.repository === "thevladbog/markiro");
    ensure(Array.isArray(approved.workflows) && approved.workflows.length === products.length);
    for (const product of products) {
      const matches = approved.workflows.filter((record) => record?.product === product);
      ensure(matches.length === 1);
      keys(matches[0], pinFields);
      ensure(matches[0].mode === "pinned-tag");
    }

    const previousPolicy = JSON.parse(current[publisherKey]);
    keys(previousPolicy, [...repositoryFields, "workflows"]);
    for (const name of repositoryFields) ensure(previousPolicy[name] === approved[name]);
    const nextPolicy = {
      ...previousPolicy,
      workflows: [...previousPolicy.workflows, ...approved.workflows],
    };
    ensure(canonical(JSON.parse(candidate[publisherKey])) === canonical(nextPolicy));

    const admittedManifest = plain(manifest);
    const release = parsePlatformManifest(
      JSON.stringify(admittedManifest),
      admittedManifest.workflowRunId,
    );
    const expected = {
      ...current,
      MARKIRO_SOURCE_SHA: release.sourceSha,
      MARKIRO_TOOLING_SHA: release.toolingSha,
      MARKIRO_API_IMAGE_DIGEST: release.api.split("@")[1],
      MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: release.edge.split("@")[1],
      [publisherKey]: candidate[publisherKey],
    };
    ensure(canonical(candidate) === canonical(expected));
  } catch {
    const error = new Error("Protected application rollout rejected the publisher configuration.");
    error.code = "ERR_HEALTHY_FORWARD_PUBLISHER_DELTA";
    throw error;
  }
}
