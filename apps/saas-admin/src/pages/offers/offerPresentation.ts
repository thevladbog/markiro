import { ApiRequestError } from "../../api/client.js";

export function offerMoney(value: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "RUB" }).format(
    Number(value),
  );
}
export function offerDate(value: string | null, locale: string) {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value))
    : null;
}
export function registryReturnTo(value: unknown): string {
  if (typeof value !== "string" || !/^\/offers(?:\?[^#]*)?$/.test(value) || /[\\\r\n]/.test(value))
    return "/offers";
  const query = new URLSearchParams(value.split("?")[1]);
  query.delete("selected");
  return query.size ? `/offers?${query}` : "/offers";
}
export function offerErrorKey(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "offerWorkspace.errors.forbidden";
    if (error.code === "offer_preview_changed") return "offerWorkspace.errors.previewChanged";
    if (
      [
        "billing_seller_profile_required",
        "billing_buyer_profile_required",
        "billing_profile_unconfirmed",
        "billing_seller_account_required",
        "billing_seller_account_inactive",
      ].includes(error.code ?? "")
    )
      return `offerWorkspace.errors.${error.code}`;
  }
  return "offerWorkspace.errors.action";
}
