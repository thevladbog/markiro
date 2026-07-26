import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { OperatorMirrorRecord } from "@markiro/db";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { OperatorsService } from "./operators.service";

/**
 * Station-facing roster. Deliberately `TenantGuard`-only (no
 * `SessionOnlyGuard`): the device calls this with its own api-key during
 * initialization, right after enrollment and BEFORE any operator can sign in —
 * that is what makes a freshly installed station usable at all. It returns
 * PBKDF2 verifiers, never plaintext PINs or badge codes.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard)
export class StationOperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Get("operators")
  async listRoster(@Req() req: RequestWithTenant): Promise<{ items: OperatorMirrorRecord[] }> {
    return { items: await this.operatorsService.buildRoster(req.tenantId!) };
  }
}
