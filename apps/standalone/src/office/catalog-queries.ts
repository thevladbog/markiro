import type { LabelTemplateSummary } from "../host/protocol.js";
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

/**
 * A template with its layout for its thumbnail (`GET /v1/office/templates/{id}`),
 * kept by id and revision and never read again while cached
 * (`staleTime: Infinity`): any write gives a new revision, so the pair never
 * goes stale. Read only once `enabled` (the row is on screen).
 */
export function useTemplateLayout(
  template: Pick<LabelTemplateSummary, "id" | "rev">,
  enabled: boolean,
) {
  return useOfficeQuery(
    officeKeys.templateLayout(template.id, template.rev),
    (api, token) => api.getTemplate(token, template.id),
    { staleTime: Infinity, enabled },
  );
}

/**
 * The templates' defaults (`GET /v1/office/template-defaults`): one document,
 * read again whenever the page opens (`staleTime` 0), since a change of the
 * organization's profile moves its revision too.
 */
export function useTemplateDefaults() {
  return useOfficeQuery(officeKeys.templateDefaults, (api, token) =>
    api.getTemplateDefaults(token),
  );
}

/**
 * The A4 pallet sheets and the organization's default (`GET
 * /v1/office/pallet-sheets`): read again whenever a page or a dialog that
 * offers a sheet opens, since a sheet may have been switched off or deleted.
 */
export function usePalletSheets(options: { enabled?: boolean } = {}) {
  return useOfficeQuery(
    officeKeys.palletSheets,
    (api, token) => api.listPalletSheets(token),
    options.enabled === undefined ? {} : { enabled: options.enabled },
  );
}
