import { canonical, digest, ensure } from "../backup/schemas.mjs";

function sortedMounts(mounts, field) {
  ensure(Array.isArray(mounts));
  const names = mounts.map((m) => m[field]);
  ensure(
    names.every((name) => typeof name === "string" && name.startsWith("/")) &&
      new Set(names).size === names.length,
  );
  return [...mounts].sort((a, b) => a[field].localeCompare(b[field]));
}
export function containerRecipe(container) {
  const host = { ...container.HostConfig };
  if (host.Mounts) host.Mounts = sortedMounts(host.Mounts, "Target");
  return digest(
    canonical({
      Image: container.Image,
      Config: container.Config,
      HostConfig: host,
      Mounts: sortedMounts(container.Mounts, "Destination"),
    }),
  );
}
