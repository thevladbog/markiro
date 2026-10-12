import {
  usTraceRequestScopeV1Schema,
  type UsTraceRequestScopeV1,
} from "@markiro/platform-contracts";

export const requestScopeKeys = [
  "productId",
  "productText",
  "tlc",
  "tlcs",
  "tlcFrom",
  "tlcTo",
  "lotId",
  "locationIds",
  "sourceReferenceValue",
  "documentNumber",
  "eventDateFrom",
  "eventDateTo",
] as const satisfies readonly (keyof UsTraceRequestScopeV1)[];

export type RequestScopeFields = Record<keyof UsTraceRequestScopeV1, string>;

export function scopeToFields(scope: UsTraceRequestScopeV1 | null): RequestScopeFields {
  return {
    productId: scope?.productId ?? "",
    productText: scope?.productText ?? "",
    tlc: scope?.tlc ?? "",
    tlcs: scope?.tlcs?.join("\n") ?? "",
    tlcFrom: scope?.tlcFrom ?? "",
    tlcTo: scope?.tlcTo ?? "",
    lotId: scope?.lotId ?? "",
    locationIds: scope?.locationIds?.join("\n") ?? "",
    sourceReferenceValue: scope?.sourceReferenceValue ?? "",
    documentNumber: scope?.documentNumber ?? "",
    eventDateFrom: scope?.eventDateFrom ?? "",
    eventDateTo: scope?.eventDateTo ?? "",
  };
}

export function parseRequestScope(
  fields: RequestScopeFields,
): ReturnType<typeof usTraceRequestScopeV1Schema.safeParse> {
  const scope: Record<string, string | string[]> = {};
  for (const key of requestScopeKeys) {
    const value = fields[key];
    if (value === "") continue;
    scope[key] = key === "tlcs" || key === "locationIds" ? value.split("\n") : value;
  }
  return usTraceRequestScopeV1Schema.safeParse(scope);
}
