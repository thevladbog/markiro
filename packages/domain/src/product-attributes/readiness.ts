import { activeRequirementRules, isAttributeRequired } from "./conditions.js";
import type {
  CategorySchemaDefinition,
  ProductAttributeValues,
  ProductReadinessDimensionResult,
  ProductReadinessReason,
} from "./model.js";

export interface ProductReadinessInput {
  schemaVersionId: string;
  schema: CategorySchemaDefinition;
  values: ProductAttributeValues;
  production: {
    chzProductGroupCode: number | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
  };
  egais: {
    applicable: boolean;
    codes: string[];
    primaryCode: string | null;
  };
  schemaStale: boolean;
}

type RegulatoryDimension = "code_ordering" | "circulation";

function evaluateProduction(input: ProductReadinessInput): ProductReadinessDimensionResult {
  const reasons: ProductReadinessReason[] = [];

  if (input.production.chzProductGroupCode === null) {
    reasons.push({ code: "PRODUCTION_GROUP_REQUIRED" });
  }
  if (input.production.boxCapacity === null) {
    reasons.push({ code: "PRODUCTION_BOX_CAPACITY_REQUIRED" });
  }
  if (input.production.palletCapacity === null) {
    reasons.push({ code: "PRODUCTION_PALLET_CAPACITY_REQUIRED" });
  }

  return {
    dimension: "production",
    state: reasons.length === 0 ? "ready" : "not_ready",
    reasons,
    recommendations: [],
  };
}

function evaluateRegulatoryDimension(
  input: ProductReadinessInput,
  dimension: RegulatoryDimension,
): ProductReadinessDimensionResult {
  if (input.schemaStale) {
    return {
      dimension,
      state: "stale",
      reasons: [
        {
          code: "SCHEMA_VERSION_STALE",
          schemaVersionId: input.schemaVersionId,
        },
      ],
      recommendations: [],
    };
  }

  const reasons: ProductReadinessReason[] = [];
  const recommendations: ProductReadinessReason[] = [];
  for (const definition of input.schema.attributes) {
    if (input.values[definition.id] !== undefined) continue;
    if (isAttributeRequired(definition, input.values, dimension)) {
      const trigger = activeRequirementRules(definition, input.values, dimension, "mandatory").find(
        (rule) => rule.when !== null,
      )?.when;
      reasons.push({
        code: "ATTRIBUTE_REQUIRED",
        attributeId: definition.id,
        ...(trigger ? { triggerAttributeId: trigger.attributeId } : {}),
        schemaVersionId: input.schemaVersionId,
      });
      continue;
    }
    const recommended = activeRequirementRules(definition, input.values, dimension, "recommended");
    if (recommended.length > 0) {
      const trigger = recommended.find((rule) => rule.when !== null)?.when;
      recommendations.push({
        code: "ATTRIBUTE_RECOMMENDED",
        attributeId: definition.id,
        ...(trigger ? { triggerAttributeId: trigger.attributeId } : {}),
        schemaVersionId: input.schemaVersionId,
      });
    }
  }

  return {
    dimension,
    state: reasons.length === 0 ? "ready" : "not_ready",
    reasons,
    recommendations,
  };
}

function evaluateEgais(input: ProductReadinessInput): ProductReadinessDimensionResult {
  if (!input.egais.applicable) {
    return { dimension: "egais", state: "not_applicable", reasons: [], recommendations: [] };
  }

  const reasons: ProductReadinessReason[] = [];
  if (input.egais.codes.length === 0) {
    reasons.push({ code: "EGAIS_CODE_REQUIRED" });
  }
  if (input.egais.codes.some((code) => !/^\d{19}$/.test(code))) {
    reasons.push({ code: "EGAIS_CODE_INVALID", attributeId: "egaisCodes" });
  }
  if (input.egais.codes.length > 1 && input.egais.primaryCode === null) {
    reasons.push({ code: "EGAIS_PRIMARY_REQUIRED" });
  }
  if (
    input.egais.primaryCode !== null &&
    (!/^\d{19}$/.test(input.egais.primaryCode) ||
      !input.egais.codes.includes(input.egais.primaryCode))
  ) {
    reasons.push({ code: "EGAIS_PRIMARY_INVALID" });
  }

  return {
    dimension: "egais",
    state: reasons.length === 0 ? "ready" : "not_ready",
    reasons,
    recommendations: [],
  };
}

export function evaluateProductReadiness(
  input: ProductReadinessInput,
): ProductReadinessDimensionResult[] {
  return [
    evaluateProduction(input),
    evaluateRegulatoryDimension(input, "code_ordering"),
    evaluateRegulatoryDimension(input, "circulation"),
    evaluateEgais(input),
  ];
}
