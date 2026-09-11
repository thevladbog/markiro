import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  categorySchemaDefinitionSchema,
  productAttributeValueSchema,
  PRODUCT_ATTRIBUTE_SOURCES,
  READINESS_DIMENSIONS,
  READINESS_STATES,
} from "@markiro/domain";
import { apiFetch } from "../../../api/client.js";
import { PRODUCTS_QUERY_KEY } from "../api.js";

const source = z.enum(PRODUCT_ATTRIBUTE_SOURCES);
const binding = z.object({
  revision: z.number().int().positive(),
  categoryId: z.string(),
  categoryName: z.string(),
  schemaVersionId: z.uuid(),
  tnVedCode: z.string().nullable(),
  okpd2Code: z.string().nullable(),
  source,
  confirmedAt: z.string(),
});
export const profileSchema = z.object({
  productId: z.string(),
  binding: binding.nullable(),
  definition: categorySchemaDefinitionSchema.nullable().optional().default(null),
  values: z.array(
    z.object({
      entryId: z.string(),
      attributeId: z.string(),
      value: productAttributeValueSchema,
      source,
      observedAt: z.string().nullable(),
      appliedAt: z.string(),
    }),
  ),
  egaisCodes: z.array(
    z.object({
      code: z.string(),
      isPrimary: z.boolean(),
      source,
      observedAt: z.string().nullable(),
      appliedAt: z.string(),
    }),
  ),
  pendingProposalCount: z.number(),
});
export type RegulatoryProfile = z.infer<typeof profileSchema>;
const reason = z.object({
  code: z.string(),
  attributeId: z.string().optional(),
  triggerAttributeId: z.string().optional(),
  schemaVersionId: z.string().optional(),
});
const readinessSchema = z.object({
  productId: z.string(),
  dimensions: z.array(
    z.object({
      dimension: z.enum(READINESS_DIMENSIONS),
      state: z.enum(READINESS_STATES),
      reasons: z.array(reason),
      recommendations: z.array(reason),
    }),
  ),
});
export type Readiness = z.infer<typeof readinessSchema>;
const optionsSchema = z.object({
  items: z.array(
    z.object({
      schemaVersionId: z.uuid(),
      categoryId: z.string(),
      categoryName: z.string(),
      selectors: z.record(z.string(), z.unknown()),
      mappingState: z.enum(["exact", "ambiguous", "unmapped"]),
    }),
  ),
});
const proposalSchema = z.object({
  proposalId: z.uuid(),
  baseRevision: z.number().int().nonnegative(),
  diff: z.object({
    version: z.literal(1),
    kind: z.enum(["category_binding", "category_change"]),
    target: z.object({
      schemaVersionId: z.uuid(),
      categoryId: z.string(),
      categoryName: z.string(),
      tnVedCode: z.string().nullable(),
      okpd2Code: z.string().nullable(),
    }),
    entries: z.array(
      z.discriminatedUnion("target", [
        z.object({
          entryId: z.uuid(),
          target: z.literal("attribute"),
          targetAttributeId: z.string(),
          targetSchemaVersionId: z.uuid(),
          disposition: z.enum(["transferable", "convertible", "inapplicable", "conflict"]),
          currentValue: productAttributeValueSchema.nullable(),
          proposedValue: productAttributeValueSchema.nullable(),
        }),
        z.object({
          entryId: z.uuid(),
          target: z.literal("egais_codes"),
          current: z.object({ codes: z.array(z.string()), primaryCode: z.string().nullable() }),
          proposed: z.object({ codes: z.array(z.string()), primaryCode: z.string().nullable() }),
        }),
      ]),
    ),
  }),
});
export type CategoryProposal = z.infer<typeof proposalSchema>;
export const regulatoryProfileKey = (id: string) => ["products", id, "regulatory-profile"] as const;
export const productReadinessKey = (id: string) => ["products", id, "readiness"] as const;
const productPath = (id: string) => `/products/${encodeURIComponent(id)}`;
export function useProductRegulatoryProfile(id: string) {
  return useQuery({
    queryKey: regulatoryProfileKey(id),
    queryFn: async ({ signal }) =>
      profileSchema.parse(
        await apiFetch<unknown>(`${productPath(id)}/regulatory-profile`, { signal }),
      ),
  });
}
export function useProductReadiness(id: string) {
  return useQuery({
    queryKey: productReadinessKey(id),
    queryFn: async ({ signal }) =>
      readinessSchema.parse(await apiFetch<unknown>(`${productPath(id)}/readiness`, { signal })),
  });
}
export function useRegulatoryCategoryOptions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["products", id, "regulatory-category-options"],
    enabled,
    queryFn: async ({ signal }) =>
      optionsSchema.parse(
        await apiFetch<unknown>(`${productPath(id)}/regulatory-category-options`, { signal }),
      ),
  });
}
const attributesBody = z
  .object({
    baseRevision: z.number().int().positive(),
    values: z
      .array(
        z
          .object({ attributeId: z.string(), value: productAttributeValueSchema.nullable() })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type AttributeUpdate = z.infer<typeof attributesBody>;
function useProfileMutation<T>(
  id: string,
  path: (body: T) => string,
  body: (input: T) => unknown,
  method = "POST",
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) =>
      profileSchema.parse(
        await apiFetch<unknown>(`${productPath(id)}/${path(input)}`, {
          method,
          body: JSON.stringify(body(input)),
        }),
      ),
    onSuccess: async (next) => {
      client.setQueryData(regulatoryProfileKey(id), next);
      await Promise.all([
        client.invalidateQueries({ queryKey: regulatoryProfileKey(id) }),
        client.invalidateQueries({ queryKey: productReadinessKey(id) }),
        client.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY }),
        client.invalidateQueries({ queryKey: ["products", id, "regulatory-category-options"] }),
      ]);
    },
  });
}
export function useUpdateRegulatoryAttributes(id: string) {
  return useProfileMutation<AttributeUpdate>(
    id,
    () => "regulatory-attributes",
    (input) => attributesBody.parse(input),
    "PATCH",
  );
}
export function useApplyCategory(id: string) {
  return useProfileMutation<{ proposalId: string; acceptedEntryIds: string[] }>(
    id,
    (input) => `regulatory-proposals/${z.uuid().parse(input.proposalId)}/apply`,
    (input) => ({ acceptedEntryIds: input.acceptedEntryIds }),
  );
}
export function useUpdateEgaisCodes(id: string) {
  return useProfileMutation<{ baseRevision: number; codes: string[]; primaryCode: string | null }>(
    id,
    () => "egais-codes",
    (input) => input,
    "PUT",
  );
}
export function useCategoryChangePreview(id: string) {
  return useMutation({
    mutationFn: async (body: {
      baseRevision: number;
      targetSchemaVersionId: string;
      tnVedCode: string | null;
      okpd2Code: string | null;
      mappingConfirmed: boolean;
    }) =>
      proposalSchema.parse(
        await apiFetch<unknown>(
          `${productPath(id)}/category-${body.baseRevision === 0 ? "binding" : "change"}-previews`,
          { method: "POST", body: JSON.stringify(body) },
        ),
      ),
  });
}

/** Fetch before discarding a conflicted draft; an old cache is not a new revision. */
export function useReloadRegulatoryProfile(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      client.fetchQuery({
        queryKey: regulatoryProfileKey(id),
        staleTime: 0,
        queryFn: ({ signal }) =>
          apiFetch<unknown>(`${productPath(id)}/regulatory-profile`, { signal }).then((value) =>
            profileSchema.parse(value),
          ),
      }),
  });
}
