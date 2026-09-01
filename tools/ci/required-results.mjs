import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { HEAVY_JOBS } from "./affected.mjs";

function readBooleanOutput(outputs, name) {
  const value = outputs?.[name];
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`classifier output ${name} must be true or false, got ${value ?? "missing"}`);
}

export function assertRequiredResults(needs) {
  if (!needs || typeof needs !== "object") {
    throw new Error("CI needs payload must be an object");
  }

  const classifier = needs["classify-changes"];
  if (!classifier || typeof classifier !== "object") {
    throw new Error("classify-changes result is missing");
  }
  if (classifier.result !== "success") {
    throw new Error(`classify-changes must succeed, got ${classifier.result ?? "missing"}`);
  }

  const full = readBooleanOutput(classifier.outputs, "full");
  for (const outputName of HEAVY_JOBS) {
    const selected = readBooleanOutput(classifier.outputs, outputName);
    const jobId = outputName.replaceAll("_", "-");
    const job = needs[jobId];
    if (!job || typeof job !== "object" || typeof job.result !== "string") {
      throw new Error(`missing result for ${jobId}`);
    }

    if (full) {
      if (job.result !== "success") {
        throw new Error(`full run requires ${jobId} to succeed, got ${job.result}`);
      }
    } else if (selected) {
      if (job.result !== "success") {
        throw new Error(`selected job ${jobId} finished with ${job.result}; expected success`);
      }
    } else if (job.result !== "success" && job.result !== "skipped") {
      throw new Error(
        `unselected job ${jobId} finished with ${job.result}; expected success or skipped`,
      );
    }
  }
}

function publishResult(passed, error) {
  const result = String(passed);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\n`, "utf8");
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const detail = passed
      ? "Every selected job succeeded; unselected jobs were skipped or succeeded."
      : `Required CI failed: ${error instanceof Error ? error.message : String(error)}`;
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [`## Required CI result: \`${result}\``, "", detail, ""].join("\n"),
      "utf8",
    );
  }
}

function runCli() {
  try {
    const [option, environmentName, ...extra] = process.argv.slice(2);
    if (option !== "--needs-env" || !environmentName || extra.length > 0) {
      throw new Error("usage: required-results.mjs --needs-env <name>");
    }
    const serialized = process.env[environmentName];
    if (serialized === undefined) {
      throw new Error(`environment variable ${environmentName} is missing`);
    }
    assertRequiredResults(JSON.parse(serialized));
    publishResult(true);
  } catch (error) {
    publishResult(false, error);
    throw error;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) runCli();
