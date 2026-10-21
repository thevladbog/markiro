import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const landingRoot = path.resolve(import.meta.dirname, "../../../apps/landing");
export const landingDist = path.join(landingRoot, "dist");

/**
 * One build serves both the Playwright suite and the Lighthouse gate, and it is
 * what production serves: the enabled demo form with its captcha container. Any
 * PUBLIC_* value already in the environment wins, so a caller can still build the
 * disabled variant on purpose.
 */
export function landingBuildEnvironment(environment) {
  return {
    PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
    PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_landing-gate-key",
    PUBLIC_PHONE: "+7 960 495-46-10",
    ...environment,
    ASTRO_TELEMETRY_DISABLED: "1",
  };
}

/**
 * Builds apps/landing/dist, unless MARKIRO_LANDING_PREBUILT=1 says it is already
 * there: CI builds it once in the landing-build job and hands the same files to
 * the browser and Lighthouse jobs, so both gates judge identical bytes.
 */
export function prepareLandingDist(environment = process.env, { dist = landingDist } = {}) {
  if (environment.MARKIRO_LANDING_PREBUILT === "1") {
    for (const file of ["index.html", "404.html"]) {
      if (!existsSync(path.join(dist, file)))
        throw new Error(`MARKIRO_LANDING_PREBUILT=1 but apps/landing/dist/${file} is missing`);
    }
    return;
  }
  execFileSync(path.join(landingRoot, "node_modules/.bin/astro"), ["build"], {
    cwd: landingRoot,
    env: landingBuildEnvironment(environment),
    stdio: "inherit",
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  prepareLandingDist({ ...process.env, MARKIRO_LANDING_PREBUILT: "" });
}
