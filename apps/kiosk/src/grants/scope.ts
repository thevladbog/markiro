import { validatePickupKm } from "@markiro/domain";
import { z } from "zod";
import type { CreateOrderDto } from "../api/types.js";
import type { StoredBoxRegistryRow } from "../store/box-registry.js";
const member = z.object({ rawKm: z.string(), kmKey: z.string() }).strict();
const scopeSchema = z
  .object({
    version: z.literal(1),
    deviceSeq: z.number().int().nonnegative(),
    payloadDigest: z.string(),
    reason: z.enum(["buy", "writeoff"]),
    writeoffReasonId: z.string().nullable(),
    badgeIdentityDigest: z.string(),
    items: z.array(member.extend({ productId: z.string() }).strict()),
    boxes: z.array(
      z
        .object({
          boxId: z.string(),
          sscc: z.string(),
          productId: z.string(),
          members: z.array(member),
        })
        .strict(),
    ),
    unitCount: z.number().int().nonnegative(),
    containerCount: z.number().int().nonnegative(),
  })
  .strict();
export type PickupScope = z.infer<typeof scopeSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw Error("grant_scope_invalid");
  return result;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Exact existing server admission-content representation; absent boxes retains legacy order. */
export function orderContent(body: CreateOrderDto): string {
  const value = {
    deviceSeq: body.deviceSeq,
    badgeDigest: body.badgeDigest ?? null,
    badgeCode: body.badgeCode ?? null,
    reason: body.reason,
    writeoffReasonId: body.writeoffReasonId ?? null,
    items: body.items.map(({ rawKm }) => ({ rawKm })),
  };
  return JSON.stringify(
    Object.hasOwn(body, "boxes")
      ? {
          ...value,
          items: value.items.toSorted((a, b) => compare(a.rawKm, b.rawKm)),
          boxes: (body.boxes ?? [])
            .map(({ sscc }) => ({ sscc }))
            .toSorted((a, b) => compare(a.sscc, b.sscc)),
        }
      : value,
  );
}
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function verifyPickupScope(
  text: string,
  digest: string,
  taskId: string,
  body: CreateOrderDto,
  products: readonly { id: string; gtin14: string }[],
  rows: readonly StoredBoxRegistryRow[],
): Promise<PickupScope> {
  if ((await sha256(text)) !== digest) throw Error("grant_scope_digest");
  const root = z
    .object({ taskKind: z.literal("pickup"), taskId: z.literal(taskId), scope: scopeSchema })
    .strict()
    .parse(JSON.parse(text));
  const scope = root.scope,
    content = JSON.parse(orderContent(body)) as {
      items: { rawKm: string }[];
      boxes?: { sscc: string }[];
    };
  if (
    scope.deviceSeq !== body.deviceSeq ||
    scope.payloadDigest !== (await sha256(orderContent(body))) ||
    scope.badgeIdentityDigest !==
      (await sha256(
        canonical({ badgeDigest: body.badgeDigest ?? null, badgeCode: body.badgeCode ?? null }),
      )) ||
    scope.reason !== body.reason ||
    scope.writeoffReasonId !== (body.writeoffReasonId ?? null) ||
    scope.items.length !== content.items.length ||
    scope.boxes.length !== (content.boxes ?? []).length
  )
    throw Error("grant_scope_mismatch");
  return assertPickupScopeFacts(scope, body, products, rows);
}
/** Recheck executed inputs synchronously inside the productive transaction after signature verification. */
export function assertPickupScopeFacts(
  scope: PickupScope,
  body: CreateOrderDto,
  products: readonly { id: string; gtin14: string }[],
  rows: readonly StoredBoxRegistryRow[],
): PickupScope {
  const content = JSON.parse(orderContent(body)) as {
    items: { rawKm: string }[];
    boxes?: { sscc: string }[];
  };
  if (
    scope.deviceSeq !== body.deviceSeq ||
    scope.reason !== body.reason ||
    scope.writeoffReasonId !== (body.writeoffReasonId ?? null) ||
    scope.items.length !== content.items.length ||
    scope.boxes.length !== (content.boxes ?? []).length
  )
    throw Error("grant_scope_mismatch");
  const seen = new Set<string>();
  const validate = (raw: string, key: string, productId: string) => {
    const km = validatePickupKm(raw);
    if (
      km.status === "not_km" ||
      km.status === "incomplete" ||
      km.key !== key ||
      seen.has(key) ||
      !products.some((p) => p.id === productId && p.gtin14 === km.km.gtin14)
    )
      throw Error("grant_scope_member");
    seen.add(key);
  };
  for (const [index, item] of scope.items.entries()) {
    if (item.rawKm !== content.items[index]?.rawKm) throw Error("grant_scope_items");
    validate(item.rawKm, item.kmKey, item.productId);
  }
  for (const box of scope.boxes) {
    const row = rows.find((r) => r.sscc === box.sscc);
    if (
      !content.boxes?.some((b) => b.sscc === box.sscc) ||
      !row ||
      row.boxId !== box.boxId ||
      row.productId !== box.productId ||
      row.bottleCount !== box.members.length ||
      canonical(row.contentKeys.toSorted()) !==
        canonical(box.members.map((m) => m.kmKey).toSorted())
    )
      throw Error("grant_scope_box");
    for (const item of box.members) validate(item.rawKm, item.kmKey, box.productId);
  }
  if (scope.unitCount !== seen.size || scope.containerCount !== scope.boxes.length)
    throw Error("grant_scope_cost");
  return scope;
}
