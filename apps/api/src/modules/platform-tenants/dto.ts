export {
  assignAddonSchema,
  assignPlanSchema,
  createTenantSchema as provisionTenantSchema,
  grantCabinetAccessSchema,
  platformTenantIdSchema as tenantReferenceSchema,
  tenantListQuerySchema,
} from "@markiro/platform-contracts";
export type {
  AssignAddonDto,
  AssignPlanDto,
  CreateTenantDto as ProvisionTenantDto,
  CreateTenantInput as ProvisionTenantInput,
  GrantCabinetAccessDto,
  TenantListQuery as TenantListQueryDto,
} from "@markiro/platform-contracts";
