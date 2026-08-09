import { Body, Controller, Post } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../zod.pipe";
import { PlatformActivationService } from "./platform-activation.service";

const completeActivationSchema = z.object({
  token: z.string().min(16).max(512),
  password: z.string().min(8).max(128),
});
type CompleteActivationInput = z.infer<typeof completeActivationSchema>;

@Controller("platform/activation")
export class PlatformActivationController {
  constructor(private readonly activation: PlatformActivationService) {}

  @Post("complete")
  complete(@Body(new ZodValidationPipe(completeActivationSchema)) body: CompleteActivationInput) {
    return this.activation.complete(body.token, { password: body.password });
  }
}
