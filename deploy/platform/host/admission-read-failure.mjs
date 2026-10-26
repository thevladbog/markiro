import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";

const context = new AsyncLocalStorage();
const failures = new WeakMap();
const stages = new Set([
  "publisher",
  "artifact-metadata",
  "artifact-download",
  "artifact-archive",
  "product-ci",
  "executor-ci",
  "publisher-recheck",
]);
const reasons = new Set(["validation", "http", "body-limit", "redirect", "timeout", "transport"]);
const object = (value) =>
  value !== null && (typeof value === "object" || typeof value === "function");
const own = (value, key) => {
  try {
    const descriptor = object(value) && Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
const bounded = (value, low, high) =>
  Number.isSafeInteger(value) && value >= low && value <= high ? value : null;
const nativeTimeoutCode = Object.getOwnPropertyDescriptor(DOMException.prototype, "code").get;
function reasonFor(error) {
  try {
    if ([20, 23].includes(Reflect.apply(nativeTimeoutCode, error, []))) return "timeout";
  } catch {
    // Non-native objects and forged error properties do not supply diagnostics.
  }
  try {
    if (types.isNativeError(error) && Object.getPrototypeOf(error) === TypeError.prototype)
      return "transport";
  } catch {
    // Never evaluate caller-owned diagnostic accessors.
  }
  return "validation";
}
function metadata(stage, reason, details) {
  return Object.freeze({
    stage,
    reason: reasons.has(reason) ? reason : "validation",
    status: bounded(own(details, "status"), 100, 599),
    bytesSeen: bounded(own(details, "bytesSeen"), 0, 2097153),
    limitBytes: [1048576, 2097152].includes(own(details, "limitBytes"))
      ? own(details, "limitBytes")
      : null,
    redirectCount: bounded(own(details, "redirectCount"), 0, 4),
  });
}
export const admissionReadFailure = (error) => (object(error) ? failures.get(error) : undefined);
export function carryAdmissionReadFailure(source, target) {
  const record = admissionReadFailure(source);
  if (record && object(target) && !failures.has(target)) failures.set(target, record);
}
/** Compiled call sites provide stages; raw error properties never provide them. */
export async function withAdmissionReadStage(stage, action) {
  if (!stages.has(stage) || typeof action !== "function")
    throw new Error("Invalid admission read stage.");
  const current = context.getStore()?.stage ?? stage;
  return context.run({ stage: current }, async () => {
    const reject = (reason, details = {}) => {
      const error = new Error("GitHub admission read rejected.");
      failures.set(error, metadata(current, reason, details));
      throw error;
    };
    try {
      return await action(reject);
    } catch (source) {
      const error = object(source) ? source : new Error("Admission read failed.");
      if (!failures.has(error)) failures.set(error, metadata(current, reasonFor(source), {}));
      throw error;
    }
  });
}
