import { z } from "zod";
import { types } from "node:util";
import { usTraceRequestCreateBodySchema } from "@markiro/platform-contracts";
import type { UsPlanArtifactStore } from "../plans/us-plan-artifacts.js";
import type { UsRequestPackageArtifactStore } from "../requests/us-request-package-artifacts.js";
import type { UsRequestWorkerExecutionIdentity } from "../requests/us-request-worker-execution.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { canonicalExportEqual } from "./us-demo-canonical.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export const requestUnitSchema = z.enum([
  "request_scenario_a",
  "request_april",
  "request_september",
]);
export type UsDatasetRequestUnitKey = z.infer<typeof requestUnitSchema>;
export type UsDatasetRequestServices = Readonly<{
  planArtifacts: UsPlanArtifactStore;
  packageArtifacts: UsRequestPackageArtifactStore;
  execution: UsRequestWorkerExecutionIdentity;
}>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const positive = z.number().int().positive();
const identity = {
  datasetId: uuid,
  version: z.literal(usSixMonthDefinition.version),
  definitionDigest: z.literal(usSixMonthDefinition.digest),
  unitKey: requestUnitSchema,
};
const request = z
  .object({
    id: uuid,
    revision: positive,
    receivedAt: z.iso.datetime(),
    dueAt: z.iso.datetime(),
  })
  .strict();
export const requestInputSchema = z
  .object({
    ...identity,
    command: usTraceRequestCreateBodySchema,
    request,
    sourceDigest: digest,
    projectionDigest: digest,
    planDigest: digest,
  })
  .strict();
export const packageInputSchema = z
  .object({
    ...identity,
    requestDigest: digest,
    run: z
      .object({
        id: uuid,
        revision: positive,
        inputDigest: digest,
        scopedContentDigest: digest,
        frozenDigest: digest,
        startedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();
const artifact = z
  .object({
    id: uuid,
    attemptId: uuid,
    name: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    mediaType: z.string().min(1).max(100),
    byteSize: positive,
    sha256: digest,
  })
  .strict();
const resultSchema = z
  .object({
    ...identity,
    state: z.literal("request_package_verified"),
    datasetComplete: z.literal(false),
    request,
    run: packageInputSchema.shape.run,
    plan: z.object({ id: uuid, sha256: digest }).strict(),
    artifacts: z.array(artifact).min(1).max(6),
    artifactsDigest: digest,
    publicationDigest: digest,
  })
  .strict();
export type UsDatasetRequestResult = Readonly<z.infer<typeof resultSchema>>;
export function requestError(code: "conflict" | "incomplete" | "unit_invalid") {
  return new Error(`us_dataset_request_${code}`);
}
export function annotateUsDatasetRequestFailure(
  error: unknown,
  location:
    Readonly<{ unitKey: UsDatasetRequestUnitKey; stage: "request" | "package" }> | undefined,
): unknown {
  try {
    if (
      !error ||
      typeof error !== "object" ||
      types.isProxy(error) ||
      !types.isNativeError(error) ||
      !Object.isExtensible(error) ||
      !location ||
      types.isProxy(location) ||
      Object.getPrototypeOf(location) !== Object.prototype ||
      Reflect.ownKeys(location).length !== 2
    )
      return error;
    const unit = Object.getOwnPropertyDescriptor(location, "unitKey");
    const stage = Object.getOwnPropertyDescriptor(location, "stage");
    const unitValue: unknown = unit && "value" in unit ? unit.value : undefined;
    const stageValue: unknown = stage && "value" in stage ? stage.value : undefined;
    if (
      !requestUnitSchema.options.some((key) => key === unitValue) ||
      (stageValue !== "request" && stageValue !== "package")
    )
      return error;
    // Never replace lower-level location, even when its metadata is opaque/unsafe.
    // Inspect only own data causes, with the same finite horizon as command projection.
    const seen = new Set<object>();
    for (let current: unknown = error, depth = 0; current && typeof current === "object"; depth++) {
      if (depth >= 32 || seen.has(current) || types.isProxy(current)) return error;
      seen.add(current);
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      const prototypes = new Set<object>();
      for (
        let prototype: object | null = current, prototypeDepth = 0;
        prototype;
        prototypeDepth++
      ) {
        if (prototypeDepth >= 32 || prototypes.has(prototype) || types.isProxy(prototype))
          return error;
        prototypes.add(prototype);
        for (const key of ["unitKey", "stage"]) {
          if (Object.getOwnPropertyDescriptor(prototype, key)) return error;
        }
        if (!cause && Object.getOwnPropertyDescriptor(prototype, "cause")) return error;
        // An ordinary object's prototype can itself be opaque; reject it next
        // iteration before any descriptor or prototype operation on that object.
        prototype = Reflect.getPrototypeOf(prototype);
      }
      if (!cause) break;
      if (!("value" in cause)) return error;
      current = cause.value;
    }
    Object.defineProperties(error, {
      unitKey: { value: unitValue, enumerable: true, configurable: true, writable: true },
      stage: { value: stageValue, enumerable: true, configurable: true, writable: true },
    });
  } catch {
    // Diagnostics are best effort and cannot replace the original failure.
  }
  return error;
}
export function equalRequest(a: unknown, b: unknown): void {
  if (!canonicalExportEqual(a, b)) throw requestError("conflict");
}
export function parseRequestValue<T>(schema: z.ZodType<T>, raw: unknown): T {
  assertBoundedSyntheticJson({ value: raw });
  const value = schema.safeParse(raw);
  if (!value.success) throw requestError("conflict");
  equalRequest(value.data, raw);
  return value.data;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseUsDatasetRequestResult(raw: unknown): UsDatasetRequestResult {
  return freeze(parseRequestValue(resultSchema, raw));
}
