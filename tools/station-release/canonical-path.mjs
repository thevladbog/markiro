import * as nativePath from "node:path";

export function isCanonicalAbsolutePath(value, pathApi = nativePath) {
  if (typeof value !== "string" || !pathApi.isAbsolute(value)) return false;
  const separatorNormalized = pathApi.sep === "\\" ? value.replaceAll("/", "\\") : value;
  return pathApi.resolve(value) === separatorNormalized;
}
