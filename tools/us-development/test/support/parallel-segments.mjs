import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";

export const segmentStrategy = {
  "fail-fast": false,
  "max-parallel": 3,
  matrix: { segment: ["foundation", "dataset", "cabinet"] },
};
const anchors = new Map([
  [12, "Verify corrected dataset Cases on disposable databases"],
  [18, "Check US Transformation native transaction foundation"],
  [19, "Verify regular US dataset Transformation on disposable databases"],
  [28, "Verify guarded US demo journal and trusted owner boundaries"],
  [29, "Verify API entry boundaries"],
  [81, "Verify US profile, session and master-data persistence on disposable databases"],
]);
export function segmentForStep(index) {
  return index < 12 ? undefined : index < 19 ? "foundation" : index < 29 ? "dataset" : "cabinet";
}
export const segmentGuard = (segment) => `matrix.segment == '${segment}'`;

export function hasExactParallelSegments(workflow) {
  const job = workflow.jobs?.isolation;
  if (!isDeepStrictEqual(job?.strategy, segmentStrategy) || job.steps?.length !== 82) return false;
  for (const [index, name] of anchors) if (job.steps[index].name !== name) return false;
  return job.steps.every((step, index) => {
    const segment = segmentForStep(index);
    return step.if === (segment ? segmentGuard(segment) : undefined);
  });
}

// Historical command/byte pins remain authoritative. Remove only the exact
// complete partition; missing segments, misplaced guards or extra steps stay visible.
export function withoutParallelSegments(workflow) {
  const result = structuredClone(workflow);
  if (!hasExactParallelSegments(result)) return result;
  delete result.jobs.isolation.strategy;
  for (const step of result.jobs.isolation.steps) delete step.if;
  return result;
}

export function withoutParallelSegmentsBytes(source) {
  if (!hasExactParallelSegments(load(source))) return source;
  const block =
    "    strategy:\n      fail-fast: false\n      max-parallel: 3\n      matrix:\n        segment: [foundation, dataset, cabinet]\n";
  if (source.split(block).length !== 2) return source;
  return source
    .replace(block, "")
    .replace(/^ {8}if: matrix\.segment == '(foundation|dataset|cabinet)'\n/gm, "");
}
