import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import {
  buildChzTrueApiAuthPayload,
  CHZ_CHANNEL_TYPE,
  CHZ_TRUE_API_BASE_URLS,
} from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import type { TrueApiAuth } from "./true-api.types";

export type ChzTokenResult =
  | { status: "ok"; auth: TrueApiAuth; obtainedAt: Date }
  | { status: "unconfigured" }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "undecryptable" };

@Injectable()
export class ChzTokenService {
  private readonly logger = new Logger(ChzTokenService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: ChzCryptoService,
  ) {}

  /**
   * The expiry is checked here rather than left to True API's 401 because a
   * refusal we can explain ("the agent has not refreshed the token") is worth
   * more to the operator than a 401 we have to guess about — and it costs no
   * request.
   */
  async getActiveToken(tenantId: string): Promise<ChzTokenResult> {
    if (!this.crypto.isConfigured()) return { status: "unconfigured" };

    const [row] = await this.db
      .select({
        encryptedToken: schema.chzApiTokens.encryptedToken,
        tokenNonce: schema.chzApiTokens.tokenNonce,
        tokenTag: schema.chzApiTokens.tokenTag,
        obtainedAt: schema.chzApiTokens.obtainedAt,
        expiresAt: schema.chzApiTokens.expiresAt,
      })
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    if (!row) return { status: "missing" };
    if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };

    const [channel] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      );
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings ?? {});
    const environment = parsed.success ? parsed.data.environment : "production";

    let token: string;
    try {
      token = this.crypto.decrypt(tenantId, {
        encryptedToken: row.encryptedToken,
        tokenNonce: row.tokenNonce,
        tokenTag: row.tokenTag,
      });
    } catch {
      // A rotated encryption key or corrupted ciphertext is an operator-fixable
      // condition, not a bug. The caller needs to be able to report it rather
      // than crash.
      this.logger.warn(`Failed to decrypt ChZ token for tenant: ${tenantId}`);
      return { status: "undecryptable" };
    }

    return {
      status: "ok",
      auth: {
        baseUrl: CHZ_TRUE_API_BASE_URLS[environment],
        token,
      },
      obtainedAt: row.obtainedAt,
    };
  }

  /**
   * Removes only the bearer that actually received a 401 and immediately asks
   * the active signer to replace it. Matching `obtainedAt` avoids deleting a
   * fresher token that the agent may have reported while the failed request
   * was in flight. The open-task unique index makes repeated 401s idempotent.
   */
  async invalidateAndRequestRefresh(tenantId: string, obtainedAt: Date): Promise<void> {
    const [deleted] = await this.db
      .delete(schema.chzApiTokens)
      .where(
        and(
          eq(schema.chzApiTokens.tenantId, tenantId),
          eq(schema.chzApiTokens.obtainedAt, obtainedAt),
        ),
      )
      .returning({ tenantId: schema.chzApiTokens.tenantId });
    if (!deleted || !this.crypto.isConfigured()) return;

    const [agent] = await this.db
      .select({ id: schema.chzSignerAgents.id })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.tenantId, tenantId),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      )
      .limit(1);
    if (!agent) return;

    const [channel] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      );
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings ?? {});
    const settings = parsed.success ? parsed.data : { environment: "production" as const };

    await this.db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: buildChzTrueApiAuthPayload(settings),
      })
      .onConflictDoNothing();
  }

  /**
   * A presence-and-expiry check that never decrypts the ciphertext. Callers
   * that only need a boolean -- `ChzExportsService.preflight()`, polled by
   * the admin UI while any run is non-terminal -- have no use for the
   * plaintext token, so materialising it on every poll would be needless
   * exposure. `getActiveToken` above stays the one path that decrypts, for
   * the runner, which genuinely has to send the token to True API.
   *
   * The trade-off: a token whose ciphertext cannot be decrypted (a rotated
   * encryption key, a corrupted row) still reads as usable here, since that
   * can only be discovered by decrypting. The runner still catches it via
   * `getActiveToken`, on its first pass over the order -- and, because
   * `undecryptable` can never self-heal, `ChzExportRunnerService.giveUpOnToken`
   * fails every queued run with `CHZ_TOKEN_UNAVAILABLE` on that same first
   * pass rather than waiting out the retry budget it grants `missing` and
   * `expired`. So the cost of this check missing an undecryptable token is
   * one preflight round-trip the operator did not need, not an order left
   * stuck in `queued` for hours.
   */
  async hasUsableToken(tenantId: string): Promise<boolean> {
    if (!this.crypto.isConfigured()) return false;

    const [row] = await this.db
      .select({ expiresAt: schema.chzApiTokens.expiresAt })
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    if (!row) return false;
    return row.expiresAt.getTime() > Date.now();
  }
}
