export function sellerTaxId(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;

  const seller = snapshot as Record<string, unknown>;
  if (typeof seller.inn === "string") return seller.inn;
  return typeof seller.taxId === "string" ? seller.taxId : null;
}
