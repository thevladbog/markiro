/**
 * Chestny ZNAK product group «Пиво, напитки, изготавливаемые на основе пива,
 * слабоалкогольные напитки» -- the only group whose products carry an EGAIS
 * code. Every "is EGAIS relevant here" decision (readiness, label editor
 * hints) goes through this constant instead of a bare literal.
 */
export const EGAIS_PRODUCT_GROUP_CODE = 15;

export function isEgaisApplicable(chzProductGroupCode: number | null | undefined): boolean {
  return chzProductGroupCode === EGAIS_PRODUCT_GROUP_CODE;
}
