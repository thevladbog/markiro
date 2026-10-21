import { types } from "node:util";

const scalarOperations = [
  "package_stage",
  "validate_request",
  "prepare_package",
  "probe_before_worker",
  "run_worker",
  "probe_after_worker",
  "render_payloads",
  "read_plan",
  "bind_inputs",
  "check_checkpoint",
  "assemble_package",
  "compare_manifest",
  "compare_entries",
  "compare_archive",
  "final_publication_probe",
  "commit_package_receipt",
] as const;
const artifacts = [
  "manifest.json",
  "package.zip",
  "plan.pdf",
  "records.xlsx",
  "request-report.pdf",
  "validation.json",
] as const;
type ScalarOperation = (typeof scalarOperations)[number];
type RequestUnit = "request_scenario_a" | "request_april" | "request_september";
export type UsRequestVerificationOperation =
  ScalarOperation | "read_private_object" | "compare_private_object" | "verify_private_archive";
export type UsRequestVerificationArtifact = (typeof artifacts)[number];
export type UsRequestVerificationFailure =
  | Readonly<{ operation: ScalarOperation }>
  | Readonly<{
      operation: "read_private_object" | "compare_private_object";
      artifact: UsRequestVerificationArtifact;
    }>
  | Readonly<{ operation: "verify_private_archive"; artifact: "package.zip" }>;
declare const frameBrand: unique symbol;
export interface UsRequestVerificationFrame {
  readonly [frameBrand]: never;
}

type State = {
  unitKey: RequestUnit;
  active: boolean;
  failure: UsRequestVerificationFailure | undefined;
};
type Pending = {
  frame: UsRequestVerificationFrame;
  unitKey: RequestUnit;
  failure: UsRequestVerificationFailure | undefined;
};
const frames = new WeakMap<object, State>();
const ambiguous = Symbol("ambiguous verification provenance");
const pending = new WeakMap<object, Pending | typeof ambiguous>();
function key(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
function state(frame: unknown): State | undefined {
  // Identity lookup precedes any inspection of an alleged handle, including proxies.
  return key(frame) ? frames.get(frame) : undefined;
}
function ownStrings(
  value: unknown,
  allowed: readonly string[],
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, string> = {};
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== "string" || !allowed.includes(name)) return undefined;
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string")
      return undefined;
    result[name] = descriptor.value;
  }
  return result;
}

/** Closed scalar projection only: no error, body, object key or successful authority. */
export function projectUsRequestVerificationFailure(
  value: unknown,
): UsRequestVerificationFailure | undefined {
  try {
    const own = ownStrings(value, ["operation", "artifact"]);
    if (!own) return undefined;
    const { operation, artifact } = own;
    const scalar = scalarOperations.find((candidate) => candidate === operation);
    if (scalar && !Object.hasOwn(own, "artifact")) return { operation: scalar };
    if (operation === "verify_private_archive" && artifact === "package.zip")
      return { operation, artifact };
    const published = artifacts.find((candidate) => candidate === artifact);
    if (
      (operation === "read_private_object" || operation === "compare_private_object") &&
      published
    )
      return { operation, artifact: published };
    return undefined;
  } catch {
    return undefined;
  }
}

export function createUsRequestVerificationFrame(
  unitKey: unknown,
): UsRequestVerificationFrame | undefined {
  if (
    unitKey !== "request_scenario_a" &&
    unitKey !== "request_april" &&
    unitKey !== "request_september"
  )
    return undefined;
  const frame = Object.freeze({}) as UsRequestVerificationFrame;
  frames.set(frame, { unitKey, active: false, failure: undefined });
  return frame;
}
export function activateUsRequestVerificationFrame(frame: unknown): void {
  const live = state(frame);
  if (live) live.active = true;
}
export function enterUsRequestVerificationOperation(
  frame: unknown,
  operation: unknown,
  artifact?: unknown,
): void {
  const live = state(frame);
  if (!live || !live.active) return;
  live.failure = undefined;
  live.failure = projectUsRequestVerificationFailure({
    operation,
    ...(artifact === undefined ? {} : { artifact }),
  });
}
export function closeUsRequestVerificationFrame(frame: unknown): void {
  const live = state(frame);
  if (!live || !key(frame)) return;
  live.failure = undefined;
  frames.delete(frame);
}
export function finalizeUsRequestVerificationFailure(frame: unknown, error: unknown): void {
  const live = state(frame);
  if (!live || !key(frame)) return;
  const failure = live.active && live.failure ? Object.freeze({ ...live.failure }) : undefined;
  closeUsRequestVerificationFrame(frame);
  if (!key(error)) return;
  // Even an ineligible invocation keeps provenance until take, preventing stale attribution.
  const previous = pending.get(error);
  if (previous) {
    pending.set(error, ambiguous);
    return;
  }
  pending.set(error, {
    frame: frame as UsRequestVerificationFrame,
    unitKey: live.unitKey,
    failure,
  });
}
export function takeUsRequestVerificationFailure(
  error: unknown,
  diagnostic: unknown,
): UsRequestVerificationFailure | undefined {
  if (!key(error)) return undefined;
  const record = pending.get(error);
  pending.delete(error);
  try {
    if (!record || record === ambiguous || !record.failure) return undefined;
    const own = ownStrings(diagnostic, ["code", "unitKey", "stage"]);
    if (
      !own ||
      own.code !== "us_dataset_command_failed" ||
      own.unitKey !== record.unitKey ||
      own.stage !== "package"
    )
      return undefined;
    return projectUsRequestVerificationFailure(record.failure);
  } catch {
    return undefined;
  }
}
