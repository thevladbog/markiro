import { type UsCapability } from "@markiro/domain";
import { ForbiddenException } from "@nestjs/common";
import {
  authorizeUsMasterData,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";

/** Tenant and user are resolved by the verified US session boundary. */
export interface UsRequestHttpContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly httpRequestId: string;
}

export async function authorizeUsRequestHttp(
  tx: UsMasterDataTransaction,
  ctx: UsRequestHttpContext,
  capabilities: readonly UsCapability[],
): Promise<void> {
  if (capabilities.length === 0) throw new ForbiddenException({ code: "insufficient_permission" });
  // authorizeUsMasterData's array means alternatives; this boundary requires all.
  for (const capability of capabilities) {
    const profile = await authorizeUsMasterData(tx, ctx.tenantId, ctx.userId, capability);
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "us_request_profile_unsupported" });
  }
}
