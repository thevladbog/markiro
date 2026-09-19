/**
 * Client-side contract for the Chestny ZNAK marking-code orders API, mirroring
 * `apps/api/src/modules/chz-km-orders/dto.ts` field for field. The schemas are
 * strict on purpose: an order row the cabinet does not fully understand is a
 * contract drift we want to see as a loud parse failure, not as a silently
 * blank cell in a table an operator uses to decide how many codes to hand to a
 * production line.
 *
 * No schema here ever carries a marking code: the list and card endpoints
 * return counts and ranges only. `kmIssueCodesSchema` is the single exception
 * and exists solely for the print page, which renders the codes it receives
 * and never persists them.
 */
import { z } from "zod";

/** `packages/db/src/schema/chz.ts`'s `CHZ_KM_ORDER_STATES`, in the same order. */
export const KM_ORDER_STATES = [
  "created",
  "signing",
  "submitted",
  "buffer_pending",
  "buffer_active",
  "fetching",
  "completed",
  "rejected",
  "failed",
] as const;
export const kmOrderStateSchema = z.enum(KM_ORDER_STATES);
export type KmOrderState = z.infer<typeof kmOrderStateSchema>;

/**
 * The three states the runner never leaves. Everything else is in flight, so
 * the card polls and the list counts it as an active order.
 */
export const KM_ORDER_TERMINAL_STATES = ["completed", "rejected", "failed"] as const;

export function isTerminalKmOrderState(state: KmOrderState): boolean {
  return (KM_ORDER_TERMINAL_STATES as readonly KmOrderState[]).includes(state);
}

/** `CHZ_KM_ORDER_PREFLIGHT_CODES` -- every way `POST /chz-km-orders` refuses. */
export const KM_ORDER_PREFLIGHT_CODES = [
  "OMS_SETTINGS_MISSING",
  "AGENT_NOT_PAIRED",
  "OMS_TOKEN_UNAVAILABLE",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_ARCHIVED",
  "PRODUCT_GTIN_MISSING",
  "PRODUCT_GROUP_MISSING",
  "PRODUCT_GROUP_UNSUPPORTED",
] as const;
export const kmOrderPreflightCodeSchema = z.enum(KM_ORDER_PREFLIGHT_CODES);
export type KmOrderPreflightCode = z.infer<typeof kmOrderPreflightCodeSchema>;

/**
 * `CHZ_KM_ORDER_SAFE_ERROR_CODES` from
 * `apps/api/src/modules/chz-km-orders/chz-km-order-runner.service.ts`, in the
 * same order -- the closed set the runner is allowed to write to
 * `chz_km_orders.error_code`. The card translates each one; an identifier the
 * server adds before the cabinet ships is shown raw rather than swallowed,
 * which is why `errorCode` itself stays a plain string in the DTO: an
 * untranslated reason is bad, a card that refuses to load is worse.
 */
export const KM_ORDER_ERROR_CODES = [
  "CHZ_OMS_SETTINGS_MISSING",
  "CHZ_OMS_TOKEN_UNAVAILABLE",
  "CHZ_SIGNING_FAILED",
  "CHZ_ORDER_REJECTED_BY_SUZ",
  "CHZ_ORDER_SUBMIT_UNRECORDED",
  "CHZ_ORDER_TIMED_OUT",
  "CHZ_CODES_UNPARSEABLE",
  "CHZ_CODES_DUPLICATE",
  "CHZ_CODES_INCOMPLETE",
  "CHZ_CODES_OVERDELIVERED",
  "CHZ_JOB_RETRIES_EXHAUSTED",
] as const;
export type KmOrderErrorCode = (typeof KM_ORDER_ERROR_CODES)[number];

export function isKmOrderErrorCode(value: string): value is KmOrderErrorCode {
  return (KM_ORDER_ERROR_CODES as readonly string[]).includes(value);
}

export const KM_ISSUE_KINDS = ["export", "print"] as const;
export const KM_ISSUE_FORMATS = ["txt", "csv"] as const;
export const kmIssueKindSchema = z.enum(KM_ISSUE_KINDS);
export const kmIssueFormatSchema = z.enum(KM_ISSUE_FORMATS);
export type KmIssueKind = z.infer<typeof kmIssueKindSchema>;
export type KmIssueFormat = z.infer<typeof kmIssueFormatSchema>;

/** The largest order СУЗ accepts, and the cap a print batch stays under. */
export const KM_ORDER_MAX_QUANTITY = 150_000;
export const KM_PRINT_ISSUE_MAX_COUNT = 5_000;

/**
 * Better Auth user ids are opaque text, not UUIDs -- `chz_km_orders.created_by_user_id`
 * references `user.id` and is a `text` column.
 */
const actorSchema = z.strictObject({ id: z.string().min(1), name: z.string() });

const nonNegativeInteger = z.number().int().nonnegative();

/**
 * СУЗ's own order identifier, which is NOT an RFC 4122 UUID: its documented
 * example `11b1abc1-f1ee-11db-1a11-f11ac11111e1` carries the variant nibble
 * `1`, so `z.uuid()` rejects a perfectly real order. The whole chain agrees on
 * the lax shape -- `OmsClient` validates the value it receives with this same
 * plain hexadecimal pattern (`apps/api/.../chz-km-orders/oms.client.ts`), the
 * `uuid` column stores it without a variant check, and the integrations screen
 * checks the installation id the same way -- so the cabinet must not be the
 * one place that is stricter. It is the only identifier here with that
 * exemption: our own ids stay `z.uuid()`.
 *
 * Getting this wrong is not a cosmetic parse failure. `omsOrderId` is present
 * on every order from `submitted` onwards, so a rejection blanks the list, the
 * card AND the print page's own order query -- which would leave an
 * already-issued batch unprintable from the office.
 */
const omsOrderIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

export const kmIssueSchema = z.strictObject({
  id: z.uuid(),
  kind: kmIssueKindSchema,
  format: kmIssueFormatSchema.nullable(),
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  count: z.number().int().positive(),
  createdBy: actorSchema,
  createdAt: z.iso.datetime(),
});
export type KmIssue = z.infer<typeof kmIssueSchema>;

export const kmOrderListItemSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  gtin14: z.string(),
  productGroupAlias: z.string(),
  templateId: z.number().int(),
  quantity: z.number().int().positive(),
  state: kmOrderStateSchema,
  omsOrderId: omsOrderIdSchema.nullable(),
  bufferStatus: z.string().nullable(),
  bufferExpiresAt: z.iso.datetime().nullable(),
  availableCodes: nonNegativeInteger.nullable(),
  fetchedCount: nonNegativeInteger,
  issuedCount: nonNegativeInteger,
  /** `fetchedCount - issuedCount`, computed by the server; never recomputed here. */
  availableForIssue: nonNegativeInteger,
  rejectionReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  attempts: nonNegativeInteger,
  createdBy: actorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type KmOrderListItem = z.infer<typeof kmOrderListItemSchema>;

export const kmOrderSchema = kmOrderListItemSchema.extend({
  issues: z.array(kmIssueSchema),
});
export type KmOrder = z.infer<typeof kmOrderSchema>;

export const kmOrderListSchema = z.strictObject({
  orders: z.array(kmOrderListItemSchema),
});

export const kmIssueCodesSchema = z.strictObject({
  codes: z.array(z.strictObject({ seq: z.number().int().positive(), code: z.string().min(1) })),
});
export type KmIssueCode = z.infer<typeof kmIssueCodesSchema>["codes"][number];

/**
 * `POST /chz-km-orders`'s 422 body. Parsed all-or-nothing: a `blockedBy` entry
 * this build does not recognise means the office would be shown an incomplete
 * list of reasons, which is worse than one honest "could not be placed".
 */
export const kmOrderPreflightFailureSchema = z.object({
  code: z.literal("CHZ_KM_ORDER_PREFLIGHT_FAILED"),
  blockedBy: z.array(kmOrderPreflightCodeSchema),
});

/**
 * `POST /chz-km-orders/:id/issues`'s 409 body when the office asked for more
 * codes than the order still holds. `available` is the count the server saw
 * under its own row lock at the moment it refused, which is the only number
 * the dialog may quote back -- the card's `availableForIssue` can already be
 * stale by then.
 */
export const kmIssueTooManyFailureSchema = z.object({
  code: z.literal("CHZ_KM_ISSUE_TOO_MANY"),
  available: z.number().int().nonnegative(),
});

export interface CreateKmOrderInput {
  productId: string;
  quantity: number;
  contactPerson?: string;
}

/**
 * `orderId` addresses the route; everything else is the request body, shaped
 * as the server's discriminated union so an export cannot lose its format.
 */
export type IssueKmCodesInput =
  | { orderId: string; kind: "export"; format: KmIssueFormat; count: number }
  | { orderId: string; kind: "print"; count: number };
