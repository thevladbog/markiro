export {
  assignAddonSchema,
  assignPlanSchema,
  createTenantSchema as provisionTenantSchema,
  platformTenantIdSchema as tenantReferenceSchema,
  tenantListQuerySchema,
} from "@markiro/platform-contracts";
export type {
  AssignAddonDto,
  AssignPlanDto,
  CreateTenantDto as ProvisionTenantDto,
  CreateTenantInput as ProvisionTenantInput,
  TenantListQuery as TenantListQueryDto,
} from "@markiro/platform-contracts";
