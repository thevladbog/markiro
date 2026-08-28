import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  chzSignerTaskCompleteSchema,
  chzSignerTaskFailSchema,
  type ChzSignerTask,
  type ChzSignerTaskComplete,
  type ChzSignerTaskFail,
} from "@markiro/platform-contracts";
import {
  ApiHttpErrors,
  ApiSignerAgentAuth,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { SignerAgentGuard, type RequestWithSignerAgent } from "../../tenancy/signer-agent.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { nextTaskOpenApiSchema } from "./dto";
import { SignerTasksService } from "./signer-tasks.service";

const nextTaskQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(25_000).default(25_000),
});

/**
 * Long-poll task queue for the desktop signer agent, guarded by
 * `SignerAgentGuard` (the agent's own `x-signer-token`, not a cabinet
 * session). Task 7's scheduler inserts the rows this controller serves.
 */
@ApiTags("signer-agent")
@Controller("signer-agent")
@UseGuards(SignerAgentGuard)
@ApiSignerAgentAuth()
export class SignerAgentTasksController {
  constructor(private readonly tasks: SignerTasksService) {}

  @Get("tasks/next")
  @ApiOperation({
    summary: "Long-poll the next queued signer task",
    description:
      "Blocks up to `wait` ms (default/max 25000) waiting for a pending task, then returns { task: null } if none showed up.",
  })
  @ApiOkResponse({ schema: nextTaskOpenApiSchema })
  @ApiHttpErrors(401)
  async next(
    @Req() req: RequestWithSignerAgent,
    @Query(new ZodValidationPipe(nextTaskQuerySchema)) q: { wait: number },
  ): Promise<{ task: ChzSignerTask | null }> {
    const task = await this.tasks.claimNext(req.tenantId!, req.signerAgentId!, q.wait);
    return { task };
  }

  @Post("tasks/:id/complete")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Report a signer task as completed with its True API token" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(chzSignerTaskCompleteSchema)
  @ApiResponse({ status: 204, description: "The task was recorded as completed." })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 404)
  async complete(
    @Req() req: RequestWithSignerAgent,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(chzSignerTaskCompleteSchema)) body: ChzSignerTaskComplete,
  ): Promise<void> {
    await this.tasks.complete(req.tenantId!, req.signerAgentId!, id, body);
  }

  @Post("tasks/:id/fail")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Report a signer task as failed with an error code" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(chzSignerTaskFailSchema)
  @ApiResponse({ status: 204, description: "The task was recorded as failed." })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 404)
  async fail(
    @Req() req: RequestWithSignerAgent,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(chzSignerTaskFailSchema)) body: ChzSignerTaskFail,
  ): Promise<void> {
    await this.tasks.fail(req.tenantId!, req.signerAgentId!, id, body);
  }
}
