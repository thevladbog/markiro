import { canonicalExportDigest } from "./us-demo-canonical.js";
import { z } from "zod";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import type { UsDemoJournalContext, UsDemoReceipt } from "./us-demo-journal-contract.js";

const stages = [
  "references",
  "receiving",
  "amend_receiving",
  "void_receiving",
  "transformation",
  "cases",
  "shipping",
  "trace_readiness",
  "plan",
  "request",
  "package",
] as const;
export type UsDatasetContext = UsDemoJournalContext;
export type JsonObject = Readonly<Record<string, unknown>>;
export type UsDatasetStage = (typeof stages)[number];
export type UsDatasetUnit = Readonly<{
  key: string;
  kind: "references" | "chain" | "correction" | "orphan" | "plan" | "request";
  stages: readonly UsDatasetStage[];
}>;
export type UsDatasetDefinition = Readonly<{
  version: "us-processor-six-month-v1";
  digest: string;
  manifest: JsonObject;
  units: readonly UsDatasetUnit[];
}>;
export type UsDatasetIntent = Readonly<{
  unitKey: string;
  stage: UsDatasetStage;
  operationKey: string;
  inputDigest: string;
  input: JsonObject;
}>;
export type UsDatasetReceipt = UsDemoReceipt;
export type UsDatasetHeader = Readonly<{
  id: string;
  tenantId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  manifest: JsonObject;
  createdBy: string;
}>;
export type UsDatasetStageRow = Readonly<{
  unitKey: string;
  stage: UsDatasetStage;
  revision: number;
  intent: UsDatasetIntent;
  receipt: UsDatasetReceipt | null;
}>;
export type UsDatasetPage = Readonly<{
  rows: readonly UsDatasetStageRow[];
  next: Readonly<{ unitKey: string; stage: UsDatasetStage }> | null;
}>;

const sequences: Record<UsDatasetUnit["kind"], readonly UsDatasetStage[]> = {
  references: ["references"],
  chain: ["receiving", "transformation", "cases", "shipping", "trace_readiness"],
  correction: [
    "receiving",
    "amend_receiving",
    "transformation",
    "cases",
    "shipping",
    "trace_readiness",
  ],
  orphan: ["receiving", "void_receiving", "trace_readiness"],
  plan: ["plan"],
  request: ["request", "package"],
};
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .uuid();
const evidence = z.custom<Record<string, unknown>>();
const definitionSchema = z
  .object({
    version: z.literal("us-processor-six-month-v1"),
    digest,
    manifest: evidence,
    units: z.array(
      z
        .object({
          key,
          kind: z.enum(["references", "chain", "correction", "orphan", "plan", "request"]),
          stages: z.array(z.enum(stages)),
        })
        .strict(),
    ),
  })
  .strict();
const intentSchema = z
  .object({
    unitKey: key,
    stage: z.enum(stages),
    operationKey: uuid,
    inputDigest: digest,
    input: evidence,
  })
  .strict();

function assertRoot(raw: unknown, error: string): asserts raw is Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(error);
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(error);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(raw).length !== Object.keys(raw).length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new Error(error);
}

/** Only traverses copies of already validated JSON, never caller objects. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

export function parseUsDatasetDefinition(raw: unknown): UsDatasetDefinition {
  assertRoot(raw, "us_dataset_definition_invalid");
  assertBoundedSyntheticJson(raw["manifest"]);
  // Validate nested descriptors before Zod reads units; bound the combined identity body.
  assertBoundedSyntheticJson({
    version: raw["version"],
    manifest: raw["manifest"],
    units: raw["units"],
  });
  const result = definitionSchema.safeParse(raw);
  if (!result.success) throw new Error("us_dataset_definition_invalid");
  const parsed = result.data;
  const keys = new Set<string>();
  for (const unit of parsed.units) {
    const expected = sequences[unit.kind];
    if (
      keys.has(unit.key) ||
      unit.stages.length !== expected.length ||
      unit.stages.some((stage, index) => stage !== expected[index])
    )
      throw new Error("us_dataset_definition_invalid");
    keys.add(unit.key);
  }
  const expected = canonicalExportDigest({
    version: parsed.version,
    manifest: parsed.manifest,
    units: parsed.units,
  });
  if (expected !== parsed.digest) throw new Error("us_dataset_definition_digest_mismatch");
  return freezeOwned(structuredClone(parsed));
}

export function parseUsDatasetIntent(raw: unknown): UsDatasetIntent {
  assertRoot(raw, "us_dataset_intent_invalid");
  const result = intentSchema.safeParse(raw);
  if (!result.success) throw new Error("us_dataset_intent_invalid");
  const parsed = result.data;
  assertBoundedSyntheticJson(parsed.input);
  if (canonicalExportDigest(parsed.input) !== parsed.inputDigest)
    throw new Error("us_dataset_intent_digest_mismatch");
  return freezeOwned(structuredClone(parsed));
}
