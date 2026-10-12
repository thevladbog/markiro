import { canonicalExportDigest } from "./us-demo-canonical.js";
import { z } from "zod";
import type { US_DEMO_VERSION } from "./us-demo-definition.js";

const stages = [
  "references",
  "receiving",
  "transformation",
  "cases",
  "shipping",
  "trace_readiness",
  "plan",
  "request",
  "package",
] as const;
export type UsDemoStage = (typeof stages)[number];
export type UsDemoJournalContext = Readonly<{
  tenantId: string;
  actorUserId: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: "markiro_us";
}>;
export type UsDemoIntent = Readonly<{
  stage: UsDemoStage;
  operationKey: string;
  inputDigest: string;
  input: Readonly<Record<string, unknown>>;
}>;
export type UsDemoReceipt = Readonly<{
  recordIds: readonly string[];
  resultDigest: string;
  result: Readonly<Record<string, unknown>>;
}>;
export type UsDemoJournal = Readonly<{
  id: string;
  tenantId: string;
  scenarioVersion: typeof US_DEMO_VERSION;
  definitionDigest: string;
  revision: number;
  stages: readonly Readonly<{
    stage: UsDemoStage;
    revision: number;
    intent: UsDemoIntent;
    receipt: UsDemoReceipt | null;
  }>[];
}>;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
// The walker owns evidence validation; Zod must not evaluate nested accessors first.
const evidence = z.custom<Record<string, unknown>>();
const usDemoIntentSchema = z
  .object({ stage: z.enum(stages), operationKey: uuid, inputDigest: digest, input: evidence })
  .strict();
const usDemoReceiptSchema = z
  .object({ recordIds: z.array(uuid), resultDigest: digest, result: evidence })
  .strict();
const MAX_JSON_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataObject(
  value: unknown,
  errorCode: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(errorCode);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== Object.keys(value).length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new Error(errorCode);
}

export function assertBoundedSyntheticJson(value: unknown): void {
  if (!isPlainObject(value)) throw new Error("us_demo_json_invalid");
  let bytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > MAX_JSON_BYTES) throw new Error("us_demo_json_too_large");
  };
  const stringBytes = (text: string): void => {
    // eslint-disable-next-line no-control-regex -- JSON control characters require validation and escaping.
    if (!/["\\\x00-\x1f\x7f-\uffff]/.test(text)) {
      addBytes(text.length + 2);
      return;
    }
    if (text.includes("\u0000") || /[\ud800-\udfff]/.test(text)) {
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 0) throw new Error("us_demo_json_invalid");
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = text.charCodeAt(++index);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("us_demo_json_invalid");
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("us_demo_json_invalid");
      }
    }
    addBytes(Buffer.byteLength(JSON.stringify(text), "utf8"));
  };
  const walk = (item: unknown, depth: number): void => {
    if (item === null || typeof item === "boolean") {
      addBytes(item === null ? 4 : item ? 4 : 5);
      return;
    }
    if (typeof item === "string") {
      stringBytes(item);
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      addBytes(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== "object" || item === null || ancestors.has(item))
      throw new Error("us_demo_json_invalid");
    if (depth > MAX_JSON_DEPTH) throw new Error("us_demo_json_too_deep");
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(item);
      const array = Array.isArray(item);
      if (array) {
        if (
          keys.length !== item.length ||
          Reflect.ownKeys(item).length !== item.length + 1 ||
          keys.some((key, index) => key !== String(index))
        )
          throw new Error("us_demo_json_invalid");
      } else if (
        !isPlainObject(item) ||
        Reflect.ownKeys(item).length !== keys.length ||
        Object.values(descriptors).some((descriptor) => !("value" in descriptor))
      )
        throw new Error("us_demo_json_invalid");
      addBytes(2);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key === undefined) throw new Error("us_demo_json_invalid");
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) throw new Error("us_demo_json_invalid");
        if (index > 0) addBytes(1);
        if (!array) {
          stringBytes(key);
          const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (
            /password|passwd|token|cookie|mfa|twofactor|totp|backupcode|credential|secret|authorization|privatekey|accesskey|apikey|storagekey|objectkey|signedurl/.test(
              normalized,
            )
          )
            throw new Error("us_demo_json_secret_key");
          addBytes(1);
        }
        walk(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(item);
    }
  };
  walk(value, 1);
}

export function parseUsDemoIntent(raw: unknown): UsDemoIntent {
  assertDataObject(raw, "us_demo_intent_invalid");
  const result = usDemoIntentSchema.safeParse(raw);
  if (!result.success) throw new Error("us_demo_intent_invalid");
  const parsed = result.data;
  assertBoundedSyntheticJson(parsed.input);
  if (canonicalExportDigest(parsed.input) !== parsed.inputDigest)
    throw new Error("us_demo_intent_digest_mismatch");
  return { ...parsed, input: structuredClone(parsed.input) };
}

export function parseUsDemoReceipt(raw: unknown): UsDemoReceipt {
  assertDataObject(raw, "us_demo_receipt_invalid");
  const result = usDemoReceiptSchema.safeParse(raw);
  if (!result.success) throw new Error("us_demo_receipt_invalid");
  const parsed = result.data;
  assertBoundedSyntheticJson(parsed.result);
  if (canonicalExportDigest(parsed.result) !== parsed.resultDigest)
    throw new Error("us_demo_receipt_digest_mismatch");
  return { ...parsed, result: structuredClone(parsed.result) };
}
