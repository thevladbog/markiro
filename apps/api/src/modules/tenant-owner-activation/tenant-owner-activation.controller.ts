import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  activationTokenSchema,
  completeTenantOwnerActivationSchema,
  type ActivationTokenDto,
  type CompleteTenantOwnerActivationDto,
  type TenantOwnerActivationStatusDto,
} from "./dto";
import { TenantOwnerActivationService } from "./tenant-owner-activation.service";

@Controller("tenant-owner-activation")
export class TenantOwnerActivationController {
  constructor(private readonly activation: TenantOwnerActivationService) {}

  @Post("status")
  status(
    @Body(new ZodValidationPipe(activationTokenSchema)) body: ActivationTokenDto,
  ): Promise<TenantOwnerActivationStatusDto> {
    return this.activation.getStatus(body.token);
  }

  @Post("complete")
  @HttpCode(204)
  complete(
    @Body(new ZodValidationPipe(completeTenantOwnerActivationSchema))
    body: CompleteTenantOwnerActivationDto,
  ): Promise<void> {
    return this.activation.complete(body.token, { password: body.password });
  }
}
