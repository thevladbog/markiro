import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";

const checksOnly = new Set(["ci.yml", "dependency-review.yml", "us-development.yml"]);

export function checkWorkflows(workflows, baseRef = "") {
  const errors = [];
  if (baseRef === "main") errors.push("US development must not merge into main");
  if (!workflows["us-development.yml"]) errors.push("US isolation workflow is missing");
  const isolation = workflows["us-development.yml"]?.jobs?.isolation;
  const checker = isolation?.steps?.find(
    (step) => step.run === "node tools/us-development/check-isolation.mjs",
  );
  if (
    !checker ||
    checker.if !== undefined ||
    checker["continue-on-error"] ||
    isolation.if !== undefined ||
    isolation["continue-on-error"]
  ) {
    errors.push("US isolation checker must run unconditionally and propagate failures");
  }
  for (const [name, workflow] of Object.entries(workflows)) {
    if (!workflow?.jobs || Object.keys(workflow.jobs).length === 0) {
      errors.push(`${name}: missing jobs`);
      continue;
    }
    if (checksOnly.has(name)) {
      for (const permission of [
        workflow.permissions,
        ...Object.values(workflow.jobs).map((job) => job.permissions),
      ]) {
        if (
          permission !== undefined &&
          (typeof permission !== "object" ||
            permission === null ||
            Object.values(permission).some((value) => value !== "read" && value !== "none"))
        ) {
          errors.push(`${name}: checks must have read-only permissions`);
        }
      }
      if (!workflow.permissions) errors.push(`${name}: explicit read-only permissions required`);
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (job.environment || job.secrets || job.uses)
          errors.push(`${name}/${jobId}: privileged or delegated job is not allowed`);
      }
      if (/secrets\s*(?:\.|\[)/.test(JSON.stringify(workflow)))
        errors.push(`${name}: secrets are not allowed`);
    } else {
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (job.if !== "${{ false }}")
          errors.push(`${name}/${jobId}: operational job is not locked`);
      }
      if (
        workflow.concurrency &&
        !workflow.concurrency.group?.startsWith("us-development-locked-")
      ) {
        errors.push(`${name}: concurrency can interfere with production`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(".github/workflows");
  const workflows = Object.fromEntries(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, load(readFileSync(resolve(directory, name), "utf8"))]),
  );
  const errors = checkWorkflows(workflows, process.env.GITHUB_BASE_REF);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "US release isolation: pass (local workflow contracts; no remote settings verified)",
    );
}
