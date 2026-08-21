const BASE_COMPOSE_FILE = "compose.production.yml";
const VBTECH_COMPOSE_FILE = "deploy/production/compose.vbtech.yml";
export const PRODUCTION_COMPOSE_PROJECT = "markiro-production";

/**
 * Return the exact Compose model selected for this deployment environment.
 * Every validation and lifecycle command must consume this list unchanged.
 */
export function productionComposeFiles(environment) {
  return environment.VBTECH_IMAGE_REF
    ? [BASE_COMPOSE_FILE, VBTECH_COMPOSE_FILE]
    : [BASE_COMPOSE_FILE];
}

export function productionComposeArgs(environment, { includeCiOverlay = false } = {}) {
  // Releases are intentionally unpacked into immutable SHA directories. Do not let
  // Compose derive its project from that directory: every lifecycle command must
  // operate on the one production service set instead.
  const args = [
    "compose",
    "--project-name",
    environment.MARKIRO_COMPOSE_PROJECT || PRODUCTION_COMPOSE_PROJECT,
    "--env-file",
    environment.MARKIRO_ENV_FILE || ".env.production",
  ];
  for (const file of productionComposeFiles(environment)) args.push("-f", file);
  if (includeCiOverlay && environment.MARKIRO_SMOKE_CI_OVERLAY === "1")
    args.push("-f", "deploy/production/compose.ci.yml");
  return args;
}
