import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  bulkEmployeePickupLimitsSchema,
  bulkEmployeePickupPolicyResponseOpenApiSchema,
  bulkEmployeePickupWriteoffSchema,
  createEmployeeSchema,
  employeeOpenApiSchema,
  employeePickupPolicySchema,
  issueBadgeSchema,
  listEmployeesOpenApiSchema,
  listEmployeesQuerySchema,
  listLinkableMembersOpenApiSchema,
  updateEmployeeSchema,
  type BulkEmployeePickupLimitsDto,
  type BulkEmployeePickupPolicyResponseDto,
  type BulkEmployeePickupWriteoffDto,
  type CreateEmployeeDto,
  type EmployeeDto,
  type IssueBadgeDto,
  type ListEmployeesQueryDto,
  type ListEmployeesResponseDto,
  type ListLinkableMembersResponseDto,
  type UpdateEmployeeDto,
  type UpdateEmployeePickupPolicyDto,
} from "./dto";
import { EmployeesService } from "./employees.service";

@ApiTags("employees")
@Controller("employees")
// Station never calls this module, and `EmployeeDto` carries plaintext badge
// codes — exactly what shipping only PBKDF2 hashes to devices (see the
// station roster mirror) is meant to prevent. Cabinet authorization keeps a
// station api-key out even though TenantGuard accepts it for tenant
// resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@ApiCabinetAuth()
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List employees" })
  @ApiZodQuery(listEmployeesQuerySchema)
  @ApiResponse({ status: 200, schema: listEmployeesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async listEmployees(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listEmployeesQuerySchema)) query: ListEmployeesQueryDto,
  ): Promise<ListEmployeesResponseDto> {
    return this.employeesService.listEmployees(req.tenantId!, query);
  }

  // OPERATIONS_WRITE (not MEMBERS_MANAGE): this list only feeds the
  // create-employee picker, so the write capability that gates `POST /employees`
  // is the right bar for seeing which members can still be linked.
  @Get("linkable-members")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "List members linkable to a new employee",
    description: "Cabinet members without a linked employee, for the create-employee picker.",
  })
  @ApiResponse({ status: 200, schema: listLinkableMembersOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async listLinkableMembers(
    @Req() req: RequestWithTenant,
  ): Promise<ListLinkableMembersResponseDto> {
    return this.employeesService.listLinkableMembers(req.tenantId!);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Create an employee" })
  @ApiZodBody(createEmployeeSchema)
  @ApiResponse({ status: 201, schema: employeeOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async createEmployee(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.createEmployee(req.tenantId!, req.userId!, body);
  }

  @Patch("pickup-policy/limits")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Bulk update employee pickup limits" })
  @ApiZodBody(bulkEmployeePickupLimitsSchema)
  @ApiResponse({ status: 200, schema: bulkEmployeePickupPolicyResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async bulkUpdatePickupLimits(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(bulkEmployeePickupLimitsSchema))
    body: BulkEmployeePickupLimitsDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.employeesService.bulkUpdatePickupLimits(req.tenantId!, req.userId!, body);
  }

  @Patch("pickup-policy/writeoff-permission")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Bulk update employee write-off permission" })
  @ApiZodBody(bulkEmployeePickupWriteoffSchema)
  @ApiResponse({ status: 200, schema: bulkEmployeePickupPolicyResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async bulkUpdatePickupWriteoff(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(bulkEmployeePickupWriteoffSchema))
    body: BulkEmployeePickupWriteoffDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.employeesService.bulkUpdatePickupWriteoff(req.tenantId!, req.userId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Update an employee" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateEmployeeSchema)
  @ApiResponse({ status: 200, schema: employeeOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async updateEmployee(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.updateEmployee(req.tenantId!, id, body);
  }

  @Patch(":id/pickup-policy")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Update an employee's pickup policy" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(employeePickupPolicySchema)
  @ApiResponse({ status: 200, schema: employeeOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async updatePickupPolicy(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(employeePickupPolicySchema)) body: UpdateEmployeePickupPolicyDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.updatePickupPolicy(req.tenantId!, req.userId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Archive an employee" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The employee is archived." })
  @ApiHttpErrors(401, 403, 404)
  async archiveEmployee(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.employeesService.archiveEmployee(req.tenantId!, id);
  }

  @Post(":id/badges")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Issue a badge to an employee" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(issueBadgeSchema)
  @ApiResponse({ status: 201, schema: employeeOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async issueBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(issueBadgeSchema)) body: IssueBadgeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.issueBadge(req.tenantId!, id, body);
  }

  @Delete(":id/badges/:badgeId")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Revoke an employee badge" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "badgeId", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The badge is revoked." })
  @ApiHttpErrors(401, 403, 404)
  async revokeBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("badgeId") badgeId: string,
  ): Promise<void> {
    return this.employeesService.revokeBadge(req.tenantId!, id, badgeId);
  }
}
