import { officeKeys, useOfficeQuery } from "./office-query.js";

/**
 * The ЧЗ product groups (`GET /v1/office/product-groups`): a static lookup,
 * so it is not read again while it is cached (`staleTime: Infinity`). The
 * catalog's pages and dialogs share it.
 */
export function useProductGroups() {
  return useOfficeQuery(officeKeys.productGroups, (api, token) => api.listProductGroups(token), {
    staleTime: Infinity,
  });
}

/**
 * The label templates without their layouts (`GET /v1/office/templates`):
 * read again whenever a page or a product dialog opens, since a template may
 * have been disabled, narrowed or deleted since.
 */
export function useTemplates() {
  return useOfficeQuery(officeKeys.templates, (api, token) => api.listTemplates(token));
}
