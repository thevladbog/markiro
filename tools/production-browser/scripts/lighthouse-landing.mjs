import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
export const LIGHTHOUSE_THRESHOLDS = Object.freeze({
  seo: 1,
  accessibility: 1,
  "best-practices": 0.95,
  performance: 0.9,
});

export function assertLighthouseReport(report, profile) {
  if (report === null || typeof report !== "object" || Array.isArray(report))
    throw new Error(`${profile}: Lighthouse report is invalid`);
  for (const [category, threshold] of Object.entries(LIGHTHOUSE_THRESHOLDS)) {
    const score = report.categories?.[category]?.score;
    if (typeof score !== "number" || !Number.isFinite(score))
      throw new Error(`${profile}: Lighthouse ${category} score is missing`);
    if (score < threshold) {
      const categoryAudits = new Set(
        (report.categories?.[category]?.auditRefs ?? []).map(({ id }) => id),
      );
      const failedEntries = Object.entries(report.audits ?? {}).filter(
        ([id, audit]) => categoryAudits.has(id) && audit?.score !== null && audit?.score < 1,
      );
      const failures = failedEntries
        .map(([id]) => id)
        .sort()
        .slice(0, 12)
        .join(", ");
      const selectors = failedEntries
        .flatMap(([, audit]) => audit?.details?.items ?? [])
        .map((item) => item?.node?.selector)
        .filter((selector) => typeof selector === "string")
        .slice(0, 5)
        .join(", ");
      throw new Error(
        `${profile}: Lighthouse ${category} score ${score.toFixed(2)} is below ${threshold.toFixed(2)}${failures ? `; failing audits: ${failures}` : ""}${selectors ? `; selectors: ${selectors}` : ""}`,
      );
    }
  }
}

export function lighthouseScoreSummary(report, profile) {
  return `${profile}: ${Object.keys(LIGHTHOUSE_THRESHOLDS)
    .map((category) => `${category}=${report.categories[category].score.toFixed(2)}`)
    .join(" ")}`;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("landing preview exited before Lighthouse");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("landing preview did not become ready");
}

export async function runLandingLighthouse() {
  const toolRoot = path.resolve(import.meta.dirname, "..");
  const appRoot = path.resolve(toolRoot, "../../apps/landing");
  const astro = path.join(appRoot, "node_modules/.bin/astro");
  await execFileAsync(astro, ["build"], {
    cwd: appRoot,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
  const preview = spawn(astro, ["preview", "--host", "127.0.0.1", "--port", "5473"], {
    cwd: appRoot,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  const outputRoot = await mkdtemp(path.join(tmpdir(), "markiro-lighthouse-"));
  try {
    await waitForServer("http://127.0.0.1:5473/", preview);
    for (const profile of ["mobile", "desktop"]) {
      const output = path.join(outputRoot, `${profile}.json`);
      const arguments_ = [
        "http://127.0.0.1:5473/",
        "--quiet",
        "--output=json",
        `--output-path=${output}`,
        `--chrome-path=${chromium.executablePath()}`,
        "--only-categories=performance,accessibility,best-practices,seo",
      ];
      if (profile === "desktop") arguments_.push("--preset=desktop");
      await execFileAsync(path.join(toolRoot, "node_modules/.bin/lighthouse"), arguments_, {
        cwd: toolRoot,
      });
      const report = JSON.parse(await readFile(output, "utf8"));
      assertLighthouseReport(report, profile);
      console.log(lighthouseScoreSummary(report, profile));
    }
  } finally {
    preview.kill("SIGTERM");
    await rm(outputRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await runLandingLighthouse();
  console.log("landing Lighthouse gates passed");
}
