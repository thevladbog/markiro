import { officeKeys, useOfficeQuery } from "../office-query.js";

/**
 * The ЧЗ product groups (`GET /v1/office/product-groups`): a static lookup,
 * so it is not read again while it is cached (`staleTime: Infinity`). The page
 * and the product dialog share it.
 */
export function useProductGroups() {
  return useOfficeQuery(officeKeys.productGroups, (api, token) => api.listProductGroups(token), {
    staleTime: Infinity,
  });
}
