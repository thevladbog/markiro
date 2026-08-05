const BASE_COMPOSE_FILE = "compose.production.yml";
const YANDEX_COMPOSE_FILE = "deploy/production/compose.yandex.yml";

/**
 * Return the exact Compose model selected for this deployment environment.
 * Every validation and lifecycle command must consume this list unchanged.
 */
export function productionComposeFiles(environment) {
  return environment.MARKIRO_EDGE_MODE === "behind-alb"
    ? [BASE_COMPOSE_FILE, YANDEX_COMPOSE_FILE]
    : [BASE_COMPOSE_FILE];
}

export function productionComposeArgs(environment, { includeCiOverlay = false } = {}) {
  const args = ["compose", "--env-file", environment.MARKIRO_ENV_FILE || ".env.production"];
  for (const file of productionComposeFiles(environment)) args.push("-f", file);
  if (includeCiOverlay && environment.MARKIRO_SMOKE_CI_OVERLAY === "1")
    args.push("-f", "deploy/production/compose.ci.yml");
  return args;
}
