import { childEnvironment, runCommand } from "./admission-process.mjs";

/** Docker CLI v29.6.1 ImageManifest: Ref, Descriptor, and one typed manifest.
 * Source: docker/cli cli/manifest/types/types.go and cli/command/manifest/inspect.go.
 * Verbose indexes (including local manifest lists) are arrays and cannot pass.
 */
export function validateRegistryManifest(text, reference, imageId) {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Array.isArray(value) ||
      value.Ref !== reference ||
      value.Descriptor?.digest !== reference.split("@")[1] ||
      value.Descriptor.platform?.os !== "linux" ||
      value.Descriptor.platform?.architecture !== "amd64" ||
      (value.Descriptor.platform.variant && value.Descriptor.platform.variant !== "v1")
    )
      throw new Error();
    const schema = Object.hasOwn(value, "SchemaV2Manifest");
    const oci = Object.hasOwn(value, "OCIManifest");
    if (
      schema === oci ||
      Object.keys(value).some(
        (key) => !["Ref", "Descriptor", "Raw", "SchemaV2Manifest", "OCIManifest"].includes(key),
      ) ||
      (Object.hasOwn(value, "Raw") && typeof value.Raw !== "string")
    )
      throw new Error();
    const manifest = schema ? value.SchemaV2Manifest : value.OCIManifest;
    const mediaType = schema
      ? "application/vnd.docker.distribution.manifest.v2+json"
      : "application/vnd.oci.image.manifest.v1+json";
    if (
      value.Descriptor.mediaType !== mediaType ||
      manifest?.schemaVersion !== 2 ||
      manifest.mediaType !== mediaType ||
      manifest.config?.digest !== imageId ||
      !Array.isArray(manifest.layers) ||
      Object.hasOwn(manifest, "manifests")
    )
      throw new Error();
    return { reference, imageId, platform: "linux/amd64" };
  } catch {
    throw new Error("platform admission failed: registry");
  }
}
export async function inspectRegistryImage(reference, imageId, run = runCommand) {
  const text = await run("docker", ["manifest", "inspect", "--verbose", reference], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: childEnvironment(),
  });
  return validateRegistryManifest(text, reference, imageId);
}
