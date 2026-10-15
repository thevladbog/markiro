import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import {
  withoutCanonicalTestsOwner,
  withoutCanonicalTestsOwnerBytes,
} from "./canonical-tests-owner.mjs";
import {
  withoutPreparedServicesOwner,
  withoutPreparedServicesOwnerBytes,
} from "./prepared-services-owner.mjs";
import {
  withoutTraceReadinessOwner,
  withoutTraceReadinessOwnerBytes,
} from "./trace-readiness-owner.mjs";

export const segmentStrategy = {
  "fail-fast": false,
  "max-parallel": 3,
  matrix: { segment: ["foundation", "dataset", "office", "requests", "browser", "persistence"] },
};
const anchors = new Map([
  [12, "Verify corrected dataset Cases on disposable databases"],
  [18, "Check US Transformation native transaction foundation"],
  [19, "Verify regular US dataset Transformation on disposable databases"],
  [21, "Verify regular dataset Shipping on disposable databases"],
  [22, "Verify pure six-month recipe and compiled timezone identity"],
  [40, "Verify US pinned export source reader on disposable databases"],
  [41, "Build durable request worker shared dependencies"],
  [46, "Build isolated request worker entry and checked descriptor"],
  [50, "Verify US Requests HTTP reads, commands, resources and downloads on disposable databases"],
  [51, "Verify US worker build, loop, runtime and real process recovery"],
  [81, "Verify US profile, session and master-data persistence on disposable databases"],
]);
export function segmentForStep(index) {
  if (index === 81) return "persistence";
  return index < 12
    ? undefined
    : index < 19
      ? "foundation"
      : index < 22
        ? "dataset"
        : index < 41
          ? "office"
          : index < 51
            ? "requests"
            : "browser";
}
export const segmentGuard = (segment) => `matrix.segment == '${segment}'`;
export function guardForStep(index) {
  if (index === 46) return "matrix.segment == 'requests' || matrix.segment == 'browser'";
  const segment = segmentForStep(index);
  return segment ? segmentGuard(segment) : undefined;
}

export function hasExactParallelSegments(workflow) {
  const job = workflow.jobs?.isolation;
  if (!isDeepStrictEqual(job?.strategy, segmentStrategy) || job.steps?.length !== 82) return false;
  for (const [index, name] of anchors) if (job.steps[index].name !== name) return false;
  return job.steps.every((step, index) => {
    return step.if === guardForStep(index);
  });
}

// Historical command/byte pins remain authoritative. Remove only the exact
// complete partition; missing segments, misplaced guards or extra steps stay visible.
export function withoutParallelSegments(workflow) {
  if (!hasExactParallelSegments(workflow)) return structuredClone(workflow);
  const result = withoutTraceReadinessOwner(
    withoutPreparedServicesOwner(withoutCanonicalTestsOwner(workflow)),
  );
  delete result.jobs.isolation.strategy;
  for (const step of result.jobs.isolation.steps) delete step.if;
  return result;
}

export function withoutParallelSegmentsBytes(source) {
  if (!hasExactParallelSegments(load(source))) return source;
  source = withoutTraceReadinessOwnerBytes(
    withoutPreparedServicesOwnerBytes(withoutCanonicalTestsOwnerBytes(source)),
  );
  const block =
    "    strategy:\n      fail-fast: false\n      max-parallel: 3\n      matrix:\n        segment: [foundation, dataset, office, requests, browser, persistence]\n";
  if (source.split(block).length !== 2) return source;
  return source
    .replace(block, "")
    .replace(
      /^ {8}if: matrix\.segment == '(foundation|dataset|office|requests|browser|persistence)'(?: \|\| matrix\.segment == 'browser')?\n/gm,
      "",
    );
}
