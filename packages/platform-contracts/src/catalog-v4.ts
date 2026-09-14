import { z } from "zod";

import {
  catalogVersionCreateV3Schema,
  catalogVersionPatchV3Schema,
  catalogVersionV3Schema,
  platformCatalogV3Contracts,
} from "./catalog-v3.js";
import { validateCatalogPatchCommercialTerms } from "./catalog-validation.js";
import { monthlyServiceTermsSchema } from "./commercial-terms.js";

const [planCreate, addonCreate, oneTimeServiceCreate] = catalogVersionCreateV3Schema.options;
const recurringServiceCreate = oneTimeServiceCreate
  .extend({
    billingMode: z.literal("recurring"),
    billingPeriod: z.literal("month"),
    service: monthlyServiceTermsSchema,
  })
  .strict();

export const catalogVersionCreateV4Schema = z.union([
  planCreate,
  addonCreate,
  oneTimeServiceCreate,
  recurringServiceCreate,
]);

export const catalogVersionPatchV4Schema = z
  .object({
    ...catalogVersionPatchV3Schema.shape,
    service: z.union([z.object({}).strict(), monthlyServiceTermsSchema]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      [value.plan, value.addon, value.service].filter((entry) => entry !== undefined).length > 1
    ) {
      context.addIssue({ code: "custom", message: "Only one entitlement effect is allowed" });
    }
  })
  .superRefine(validateCatalogPatchCommercialTerms);

const [planRead, addonRead, oneTimeServiceRead] = catalogVersionV3Schema.options;
const recurringServiceRead = z
  .object({
    ...oneTimeServiceRead.shape,
    billingMode: z.literal("recurring"),
    billingPeriod: z.literal("month"),
    service: monthlyServiceTermsSchema,
  })
  .strict();

export const catalogVersionV4Schema = z.union([
  planRead,
  addonRead,
  oneTimeServiceRead,
  recurringServiceRead,
]);
export const catalogVersionListResponseV4Schema = z
  .object({ items: z.array(catalogVersionV4Schema) })
  .strict();

export const platformCatalogV4Contracts = {
  ...platformCatalogV3Contracts,
  list: { response: catalogVersionListResponseV4Schema },
  listVersions: {
    ...platformCatalogV3Contracts.listVersions,
    response: catalogVersionListResponseV4Schema,
  },
  getVersion: { ...platformCatalogV3Contracts.getVersion, response: catalogVersionV4Schema },
  createVersion: {
    ...platformCatalogV3Contracts.createVersion,
    body: catalogVersionCreateV4Schema,
    response: catalogVersionV4Schema.refine((version) => version.status === "draft"),
  },
  updateVersion: {
    ...platformCatalogV3Contracts.updateVersion,
    body: catalogVersionPatchV4Schema,
    response: catalogVersionV4Schema.refine((version) => version.status === "draft"),
  },
  publishVersion: {
    ...platformCatalogV3Contracts.publishVersion,
    response: catalogVersionV4Schema.refine((version) => version.status === "published"),
  },
  retireVersion: {
    ...platformCatalogV3Contracts.retireVersion,
    response: catalogVersionV4Schema.refine((version) => version.status === "retired"),
  },
} as const;

export type CatalogVersionV4 = z.output<typeof catalogVersionV4Schema>;
export type CatalogVersionCreateV4 = z.output<typeof catalogVersionCreateV4Schema>;
export type CatalogVersionPatchV4 = z.output<typeof catalogVersionPatchV4Schema>;
