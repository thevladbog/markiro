import { z } from "zod";
import {
  DomainError,
  MAX_PRODUCT_LABEL_EVENTS,
  MAX_SYNC_BATCH_ID_CHARS,
  productLabelEventSchema,
  productLabelValueDigest,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";

export const PRODUCT_LABEL_BATCH_KEY = "sync_pending_product_label_batch";
export const PRODUCT_LABEL_CEILING_KEY = "sync_pending_product_label_ceiling";
const ceilingSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const pinSchema = z.strictObject({
  credentialOwnership: z.string().min(1),
  request: z.strictObject({
    batchId: z.string().min(1).max(MAX_SYNC_BATCH_ID_CHARS),
    // Existing channels retain their existing wire validation. The saved envelope is digest-bound.
    items: z.array(z.unknown()).max(100),
    boxes: z.array(z.unknown()).max(50),
    exceptions: z.array(z.unknown()).max(100),
    productLabelEvents: z.array(productLabelEventSchema).min(1).max(MAX_PRODUCT_LABEL_EVENTS),
    serialsLeft: z.number().nonnegative(),
  }),
  scanCeiling: ceilingSchema,
  boxCeiling: ceilingSchema,
  exceptionCeiling: ceilingSchema,
  labelCeiling: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  boxes: z
    .array(
      z.strictObject({
        boxId: z.string(),
        printVerifiedAt: z.string().nullable(),
        printSkippedAt: z.string().nullable(),
      }),
    )
    .max(50),
});
export type ProductLabelBatchPin = z.infer<typeof pinSchema>;
function invalidPin(): never {
  throw new DomainError(
    "PRODUCT_LABEL_BATCH_INVALID",
    "Saved product label delivery is inconsistent",
  );
}

export async function readProductLabelBatchPin(
  exec: SqlExecutor,
  owner: string | null,
): Promise<ProductLabelBatchPin | null> {
  const [row] = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key=?", [
    PRODUCT_LABEL_BATCH_KEY,
  ]);
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    invalidPin();
  }
  const parsed = z.strictObject({ pin: pinSchema, digest: z.string() }).safeParse(value);
  if (!parsed.success || productLabelValueDigest(parsed.data.pin) !== parsed.data.digest)
    invalidPin();
  if (parsed.data.pin.credentialOwnership !== owner)
    throw new DomainError(
      "PRODUCT_LABEL_BATCH_OWNER_MISMATCH",
      "Pending delivery belongs to another station credential",
    );
  return parsed.data.pin;
}

export async function saveProductLabelBatchPin(
  exec: SqlExecutor,
  input: ProductLabelBatchPin,
): Promise<ProductLabelBatchPin> {
  const pin = pinSchema.parse(input);
  await exec.run("INSERT INTO station_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", [
    PRODUCT_LABEL_BATCH_KEY,
    JSON.stringify({ pin, digest: productLabelValueDigest(pin) }),
  ]);
  const saved = await readProductLabelBatchPin(exec, pin.credentialOwnership);
  if (!saved) invalidPin();
  return saved;
}

/** One statement retires the envelope and its legacy/new identities after every channel ACK succeeds. */
export async function clearProductLabelBatchPin(exec: SqlExecutor): Promise<void> {
  await exec.run("DELETE FROM station_meta WHERE key IN (?,?,?,?,?,?,?,?)", [
    PRODUCT_LABEL_BATCH_KEY,
    PRODUCT_LABEL_CEILING_KEY,
    "sync_pending_batch_id",
    "sync_pending_ceiling",
    "sync_pending_box_ceiling",
    "sync_pending_exception_ceiling",
    // A label batch never carries pallet facts (see the drain's own comment),
    // but it still pins both channels explicitly empty, so both identities
    // have to retire with the envelope or the next batch inherits a ceiling
    // that can only ever exclude rows.
    "sync_pending_pallet_ceiling",
    "sync_pending_pallet_exception_ceiling",
  ]);
}
