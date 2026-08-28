import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodValidationError, validationErrorSchema } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  activationTokenSchema,
  activationUnavailableOpenApiSchema,
  completeActivationErrorOpenApiSchema,
  completeTenantOwnerActivationSchema,
  tenantOwnerActivationStatusOpenApiSchema,
  type ActivationTokenDto,
  type CompleteTenantOwnerActivationDto,
  type TenantOwnerActivationStatusDto,
} from "./dto";
import { TenantOwnerActivationService } from "./tenant-owner-activation.service";

@ApiTags("tenant-owner-activation")
@Controller("tenant-owner-activation")
export class TenantOwnerActivationController {
  constructor(private readonly activation: TenantOwnerActivationService) {}

  @Post("status")
  @ApiOperation({
    summary: "Check activation token status",
    description:
      "Public: the activation token from the invitation link is the sole credential. Reports " +
      "whether the invited owner already has a password credential, so the activation form " +
      "knows whether to ask for one.",
  })
  @ApiZodBody(activationTokenSchema)
  @ApiResponse({ status: 201, schema: tenantOwnerActivationStatusOpenApiSchema })
  @ApiZodValidationError()
  @ApiResponse({
    status: 404,
    schema: activationUnavailableOpenApiSchema,
    description: "Unknown or expired activation token.",
  })
  status(
    @Body(new ZodValidationPipe(activationTokenSchema)) body: ActivationTokenDto,
  ): Promise<TenantOwnerActivationStatusDto> {
    return this.activation.getStatus(body.token);
  }

  @Post("complete")
  @HttpCode(204)
  @ApiOperation({
    summary: "Complete tenant owner activation",
    description:
      "Public: the activation token is the sole credential. Sets the owner's password when no " +
      "credential exists yet (`password` is then required and must be omitted otherwise), " +
      "verifies the email, activates the pending demo subscription, and consumes the token.",
  })
  @ApiZodBody(completeTenantOwnerActivationSchema)
  @ApiResponse({ status: 204, description: "Activation completed; the token is consumed." })
  @ApiResponse({
    status: 400,
    description:
      "Request validation failed, or the password rules were violated " +
      "(`password_required`, `existing_credential`).",
    schema: { oneOf: [validationErrorSchema, completeActivationErrorOpenApiSchema] },
  })
  @ApiResponse({
    status: 404,
    schema: activationUnavailableOpenApiSchema,
    description: "Unknown or expired activation token.",
  })
  complete(
    @Body(new ZodValidationPipe(completeTenantOwnerActivationSchema))
    body: CompleteTenantOwnerActivationDto,
  ): Promise<void> {
    return this.activation.complete(body.token, { password: body.password });
  }
}
