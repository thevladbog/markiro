import { z } from "zod";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

export const P1_FEATURE_KEYS = ["chzIntegration", "inventory", "commerceMl", "handheld"] as const;
export const ENTITLEMENT_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  ...P1_FEATURE_KEYS,
] as const;
export const ENTITLEMENT_QUOTA_KEYS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;
export type EntitlementFeatureKey = (typeof ENTITLEMENT_FEATURE_KEYS)[number];
export type EntitlementQuotaKey = (typeof ENTITLEMENT_QUOTA_KEYS)[number];
export type EntitlementOperationClass =
  "new_work" | "continuation" | "stored_read" | "evidence_ingest";
// Gate IDs name existing runtime checks; implementationStage only tracks P1 adapter work.
export interface EntitlementOperationDefinition {
  readonly features: readonly EntitlementFeatureKey[];
  readonly class: EntitlementOperationClass;
  readonly capability: "operations.read" | "operations.write" | null;
  readonly authorization:
    | "cabinet"
    | "exchange_session"
    | "station_device"
    | "cabinet_or_station_device"
    | "api_key_scope";
  readonly releaseEligibility:
    | "national_catalog_operation_policy"
    | "chz_filtered_cis_report_policy"
    | "existing_operation_policy";
  readonly implementationStage: "p1a" | "p1b" | "p1c";
  readonly version: 1;
  readonly coverage: "p1a_adapter" | "p1b_adapter" | "classified" | "deferred";
}
export const ENTITLEMENT_REGISTRY_VERSION = "p1b.v1" as const;
export const ENTITLEMENT_OPERATIONS = {
  "nk.lookup.v1": {
    authorization: "cabinet",
    releaseEligibility: "national_catalog_operation_policy",
    features: ["chzIntegration"],
    class: "new_work",
    capability: "operations.read",
    implementationStage: "p1a",
    version: 1,
    coverage: "p1a_adapter",
  },
  "nk.proposal.v1": {
    authorization: "cabinet",
    releaseEligibility: "national_catalog_operation_policy",
    features: ["chzIntegration"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1a",
    version: 1,
    coverage: "p1a_adapter",
  },
  "nk.apply.v1": {
    authorization: "cabinet",
    releaseEligibility: "national_catalog_operation_policy",
    features: ["chzIntegration"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1a",
    version: 1,
    coverage: "p1a_adapter",
  },
  "nk.refresh.v1": {
    authorization: "cabinet",
    releaseEligibility: "national_catalog_operation_policy",
    features: ["chzIntegration"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1a",
    version: 1,
    coverage: "p1a_adapter",
  },
  "nk.worker.v1": {
    authorization: "cabinet",
    releaseEligibility: "national_catalog_operation_policy",
    features: ["chzIntegration"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1a",
    version: 1,
    coverage: "p1a_adapter",
  },
  "chz.export.create.v1": {
    authorization: "cabinet",
    releaseEligibility: "chz_filtered_cis_report_policy",
    features: ["inventory", "chzIntegration"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1a",
    version: 1,
    coverage: "p1a_adapter",
  },
  "chz.export.poll.v1": {
    authorization: "cabinet",
    releaseEligibility: "chz_filtered_cis_report_policy",
    features: ["inventory", "chzIntegration"],
    class: "continuation",
    capability: "operations.read",
    implementationStage: "p1a",
    version: 1,
    coverage: "classified",
  },
  "chz.export.receipt.v1": {
    authorization: "cabinet",
    releaseEligibility: "chz_filtered_cis_report_policy",
    features: ["inventory", "chzIntegration"],
    class: "stored_read",
    capability: "operations.read",
    implementationStage: "p1a",
    version: 1,
    coverage: "classified",
  },
  "inventory.file.create.v1": {
    authorization: "cabinet",
    releaseEligibility: "existing_operation_policy",
    features: ["inventory"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "inventory.task.create.v1": {
    authorization: "cabinet",
    releaseEligibility: "existing_operation_policy",
    features: ["inventory"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "inventory.task.start.v1": {
    authorization: "cabinet",
    releaseEligibility: "existing_operation_policy",
    features: ["inventory"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "commerceMl.exchange.v1": {
    authorization: "exchange_session",
    releaseEligibility: "existing_operation_policy",
    features: ["commerceMl"],
    class: "new_work",
    capability: null,
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "handheld.work.start.v1": {
    authorization: "station_device",
    releaseEligibility: "existing_operation_policy",
    features: ["handheld"],
    class: "new_work",
    capability: null,
    implementationStage: "p1c",
    version: 1,
    coverage: "deferred",
  },
  "labelEditor.template.write.v1": {
    authorization: "cabinet",
    releaseEligibility: "existing_operation_policy",
    features: ["labelEditor"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "pallets.shift.configure.v1": {
    authorization: "cabinet",
    releaseEligibility: "existing_operation_policy",
    features: ["pallets"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "pallets.shift.configure.station.v1": {
    authorization: "station_device",
    releaseEligibility: "existing_operation_policy",
    features: ["pallets"],
    class: "new_work",
    capability: null,
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "pallets.shift.start.v1": {
    authorization: "cabinet_or_station_device",
    releaseEligibility: "existing_operation_policy",
    features: ["pallets"],
    class: "new_work",
    capability: "operations.write",
    implementationStage: "p1b",
    version: 1,
    coverage: "p1b_adapter",
  },
  "publicApi.request.v1": {
    authorization: "api_key_scope",
    releaseEligibility: "existing_operation_policy",
    features: ["publicApi"],
    class: "new_work",
    capability: null,
    implementationStage: "p1b",
    version: 1,
    coverage: "deferred",
  },
} as const satisfies Record<string, EntitlementOperationDefinition>;
export type EntitlementOperationId = keyof typeof ENTITLEMENT_OPERATIONS;
export const entitlementOperationIdSchema = z.enum(
  Object.keys(ENTITLEMENT_OPERATIONS) as EntitlementOperationId[],
);
export const entitlementOperationIdsSchema = z
  .array(entitlementOperationIdSchema)
  .min(1)
  .max(Object.keys(ENTITLEMENT_OPERATIONS).length)
  .refine((ids) => new Set(ids).size === ids.length, "Operation IDs must be unique");
const positiveInteger = z.number().int().positive().max(2_147_483_647);
export const entitlementEffectSchema = z.discriminatedUnion("key", [
  z.object({ key: z.enum(ENTITLEMENT_QUOTA_KEYS), quotaIncrement: positiveInteger }).strict(),
  z.object({ key: z.enum(ENTITLEMENT_FEATURE_KEYS), featureEnabled: z.literal(true) }).strict(),
]);
export const entitlementEffectsSchema = z
  .array(entitlementEffectSchema)
  .min(1)
  .max(ENTITLEMENT_QUOTA_KEYS.length + ENTITLEMENT_FEATURE_KEYS.length)
  .refine(
    (effects) => new Set(effects.map((effect) => effect.key)).size === effects.length,
    "Effect keys must be unique",
  );
export type EntitlementEffect = z.output<typeof entitlementEffectSchema>;
const reasonSchema = z.string().trim().min(1).max(1_000);
const decisionReferenceSchema = z.string().trim().min(1).max(1_000);
const sourceCommandBaseSchema = z
  .object({
    effects: entitlementEffectsSchema,
    operationIds: entitlementOperationIdsSchema,
    startsAt: platformTimestampSchema,
    reason: reasonSchema,
    decisionReference: decisionReferenceSchema,
    requestId: platformUuidSchema,
  })
  .strict();
export const entitlementSourceCommandSchema = z
  .discriminatedUnion("kind", [
    sourceCommandBaseSchema.extend({
      kind: z.literal("temporary"),
      endsAt: platformTimestampSchema,
    }),
    sourceCommandBaseSchema.extend({
      kind: z.literal("compatibility"),
      endsAt: platformTimestampSchema.nullable(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.endsAt !== null && Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must follow start" });
    if (value.kind === "compatibility") {
      const newKeys: readonly string[] = P1_FEATURE_KEYS;
      for (const [index, effect] of value.effects.entries()) {
        if (!newKeys.includes(effect.key))
          ctx.addIssue({
            code: "custom",
            path: ["effects", index],
            message: "Compatibility grants only P1 features",
          });
      }
      const granted = new Set<string>(value.effects.map((effect) => effect.key));
      for (const operationId of value.operationIds) {
        if (!ENTITLEMENT_OPERATIONS[operationId].features.some((feature) => granted.has(feature)))
          ctx.addIssue({
            code: "custom",
            path: ["operationIds"],
            message: "Compatibility operations must involve an explicitly granted module",
          });
      }
    }
  });
export const entitlementSourcePreviewRequestSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("prepare"), command: entitlementSourceCommandSchema }).strict(),
  z
    .object({
      intent: z.literal("revoke"),
      sourceId: platformUuidSchema,
      reason: reasonSchema,
      decisionReference: decisionReferenceSchema,
      requestId: platformUuidSchema,
    })
    .strict(),
]);
export const entitlementSourceConfirmSchema = z
  .object({ previewId: platformUuidSchema, requestId: platformUuidSchema })
  .strict();
export const entitlementRevisionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .pipe(
    z
      .string()
      .refine(
        (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
        "Revision exceeds PostgreSQL bigint",
      ),
  );
export const entitlementQuotaSchema = z
  .object({
    limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    used: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    remaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict()
  .refine(
    (q) => q.remaining === (q.limit === null ? null : Math.max(0, q.limit - q.used)),
    "Remaining must match limit and usage",
  );
export const entitlementQuotasSchema = z
  .object({
    lines: entitlementQuotaSchema,
    stations: entitlementQuotaSchema,
    kiosks: entitlementQuotaSchema,
    cabinetUsers: entitlementQuotaSchema,
  })
  .strict();
export const entitlementCurrentFeaturesSchema = z
  .object({ labelEditor: z.boolean(), publicApi: z.boolean(), pallets: z.boolean() })
  .strict();
export const entitlementCandidateFeaturesSchema = z
  .object({
    labelEditor: z.boolean().nullable(),
    publicApi: z.boolean().nullable(),
    pallets: z.boolean().nullable(),
    chzIntegration: z.boolean().nullable(),
    inventory: z.boolean().nullable(),
    commerceMl: z.boolean().nullable(),
    handheld: z.boolean().nullable(),
  })
  .strict();
const sourceBaseSchema = z
  .object({
    id: platformUuidSchema,
    versionId: platformUuidSchema,
    startsAt: platformTimestampSchema.nullable(),
    endsAt: platformTimestampSchema.nullable(),
  })
  .strict();
export const entitlementProjectionEffectSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.enum(ENTITLEMENT_QUOTA_KEYS),
      quotaIncrement: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ key: z.enum(ENTITLEMENT_FEATURE_KEYS), featureEnabled: z.literal(true) }).strict(),
]);
const projectionEffectsSchema = z
  .array(entitlementProjectionEffectSchema)
  .max(ENTITLEMENT_QUOTA_KEYS.length + ENTITLEMENT_FEATURE_KEYS.length)
  .refine(
    (effects) => new Set(effects.map((effect) => effect.key)).size === effects.length,
    "Effect keys must be unique",
  );
const projectionOperationsSchema = z
  .array(entitlementOperationIdSchema)
  .max(Object.keys(ENTITLEMENT_OPERATIONS).length)
  .refine((ids) => new Set(ids).size === ids.length, "Operation IDs must be unique");
const baseQuotaSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const entitlementPlanSourcePayloadSchema = z
  .object({
    quotas: z
      .object({
        lines: baseQuotaSchema,
        stations: baseQuotaSchema,
        kiosks: baseQuotaSchema,
        cabinetUsers: baseQuotaSchema,
      })
      .strict(),
    features: entitlementCandidateFeaturesSchema,
  })
  .strict();
const preparedSourceFields = {
  prepared: z.literal(true),
  startsAt: platformTimestampSchema,
  effects: entitlementEffectsSchema,
  operationIds: entitlementOperationIdsSchema,
};
const temporarySourceSchema = sourceBaseSchema.extend({
  ...preparedSourceFields,
  kind: z.literal("temporary"),
  endsAt: platformTimestampSchema,
});
const compatibilitySourceSchema = sourceBaseSchema.extend({
  ...preparedSourceFields,
  kind: z.literal("compatibility"),
});
export const entitlementSourceSchema = z
  .discriminatedUnion("kind", [
    sourceBaseSchema.extend({
      kind: z.literal("plan"),
      prepared: z.literal(false),
      effects: z.array(entitlementEffectSchema).max(0),
      operationIds: projectionOperationsSchema,
      plan: entitlementPlanSourcePayloadSchema,
    }),
    sourceBaseSchema.extend({
      kind: z.literal("addon"),
      prepared: z.literal(false),
      effects: projectionEffectsSchema,
      operationIds: projectionOperationsSchema,
    }),
    temporarySourceSchema,
    compatibilitySourceSchema,
  ])
  .superRefine((source, ctx) => {
    if (
      source.startsAt !== null &&
      source.endsAt !== null &&
      Date.parse(source.endsAt) <= Date.parse(source.startsAt)
    )
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must follow start" });
    if (source.kind === "compatibility") {
      const keys: readonly string[] = P1_FEATURE_KEYS;
      if (source.effects.some((effect) => !keys.includes(effect.key)))
        ctx.addIssue({
          code: "custom",
          path: ["effects"],
          message: "Compatibility grants only P1 features",
        });
    }
  });
export const platformEntitlementSourceSchema = sourceBaseSchema
  .extend({
    ...preparedSourceFields,
    kind: z.enum(["temporary", "compatibility"]),
    tenantId: platformTenantIdSchema,
    subscriptionId: platformUuidSchema,
    version: z.number().int().positive(),
    reason: reasonSchema,
    decisionReference: decisionReferenceSchema,
    requestId: platformUuidSchema,
    createdByPlatformUserId: z.string().min(1).max(128),
    createdAt: platformTimestampSchema,
    revokedAt: platformTimestampSchema.nullable(),
    revokedByPlatformUserId: z.string().min(1).max(128).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const command = entitlementSourceCommandSchema.safeParse({
      kind: value.kind,
      effects: value.effects,
      operationIds: value.operationIds,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      reason: value.reason,
      decisionReference: value.decisionReference,
      requestId: value.requestId,
    });
    if (!command.success)
      for (const issue of command.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export const entitlementSubscriptionSchema = z
  .object({
    id: platformUuidSchema,
    planVersionId: platformUuidSchema,
    status: z.enum(["pending_activation", "trial", "active", "expired"]),
    startsAt: platformTimestampSchema.nullable(),
    endsAt: platformTimestampSchema.nullable(),
  })
  .strict();
export const entitlementSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    tenantId: platformTenantIdSchema,
    asOf: platformTimestampSchema,
    countedAt: platformTimestampSchema,
    revision: entitlementRevisionSchema,
    usageRevision: entitlementRevisionSchema,
    nextChangeAt: platformTimestampSchema.nullable(),
    current: z
      .object({
        access: z.enum(["managed", "unmanaged", "read_only"]),
        writeAllowed: z.boolean(),
        subscription: entitlementSubscriptionSchema.nullable(),
        quotas: entitlementQuotasSchema,
        features: entitlementCurrentFeaturesSchema,
      })
      .strict(),
    candidate: z
      .object({ quotas: entitlementQuotasSchema, features: entitlementCandidateFeaturesSchema })
      .strict(),
    sources: z.array(entitlementSourceSchema),
    readiness: z
      .object({ mode: z.literal("shadow"), reasons: z.array(z.string().min(1).max(256)) })
      .strict(),
    historical: z.object({ available: z.literal(false) }).strict(),
    connectivity: z
      .object({
        observedAt: platformTimestampSchema,
        chz: z.enum(["ready", "not_ready", "unknown"]),
        nationalCatalog: z.enum(["ready", "not_ready", "unknown"]),
      })
      .strict(),
  })
  .strict();
export const platformEntitlementSnapshotV1Schema = entitlementSnapshotV1Schema
  .extend({ sourceDetails: z.array(platformEntitlementSourceSchema) })
  .strict();
export const entitlementSourcePreviewSchema = z
  .object({
    previewId: platformUuidSchema,
    requestId: platformUuidSchema,
    intent: z.enum(["prepare", "revoke"]),
    revision: entitlementRevisionSchema,
    usageRevision: entitlementRevisionSchema,
    expiresAt: platformTimestampSchema,
    before: entitlementSnapshotV1Schema,
    after: entitlementSnapshotV1Schema,
  })
  .strict();
export type EntitlementSourceCommand = z.output<typeof entitlementSourceCommandSchema>;
export type EntitlementSourcePreviewRequest = z.output<
  typeof entitlementSourcePreviewRequestSchema
>;
export type EntitlementSourceConfirm = z.output<typeof entitlementSourceConfirmSchema>;
export type EntitlementSource = z.output<typeof entitlementSourceSchema>;
export type PlatformEntitlementSource = z.output<typeof platformEntitlementSourceSchema>;
export type EntitlementSnapshotV1 = z.output<typeof entitlementSnapshotV1Schema>;
export type PlatformEntitlementSnapshotV1 = z.output<typeof platformEntitlementSnapshotV1Schema>;
export type EntitlementSourcePreview = z.output<typeof entitlementSourcePreviewSchema>;
export type EntitlementRevision = z.output<typeof entitlementRevisionSchema>;
export type EntitlementQuota = z.output<typeof entitlementQuotaSchema>;
export type EntitlementQuotas = z.output<typeof entitlementQuotasSchema>;
export type EntitlementCurrentFeatures = z.output<typeof entitlementCurrentFeaturesSchema>;
export type EntitlementCandidateFeatures = z.output<typeof entitlementCandidateFeaturesSchema>;
export type EntitlementSubscription = z.output<typeof entitlementSubscriptionSchema>;
export type EntitlementPlanSourcePayload = z.output<typeof entitlementPlanSourcePayloadSchema>;

export const entitlementSourceConfirmationSchema = z
  .object({
    previewId: platformUuidSchema,
    requestId: platformUuidSchema,
    sourceId: platformUuidSchema,
    confirmedAt: platformTimestampSchema,
    after: entitlementSnapshotV1Schema,
  })
  .strict();
export const entitlementSourceListSchema = z
  .object({
    snapshot: entitlementSnapshotV1Schema,
    detailsVisible: z.boolean(),
    sourceDetails: z.array(platformEntitlementSourceSchema),
  })
  .strict();
export const entitlementImpactSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    observedAt: platformTimestampSchema,
    scope: z.literal("tenant_current_observation"),
    mode: z.literal("shadow"),
    reasons: z.array(z.string().min(1).max(256)),
    operations: z.array(
      z
        .object({
          operationId: entitlementOperationIdSchema,
          outcome: z.enum(["allow", "deny", "unknown"]),
          reasonCodes: z.array(z.string()),
        })
        .strict(),
    ),
    clientRepresentation: z
      .object({ commercialV3Required: z.boolean(), nativeP1Verified: z.literal(false) })
      .strict(),
  })
  .strict();
export type EntitlementSourceConfirmation = z.output<typeof entitlementSourceConfirmationSchema>;
export type EntitlementSourceList = z.output<typeof entitlementSourceListSchema>;
export type EntitlementImpact = z.output<typeof entitlementImpactSchema>;
