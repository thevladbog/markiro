import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import {
  buildChzOmsAuthPayload,
  CHZ_CHANNEL_TYPE,
  CHZ_OMS_BASE_URLS,
} from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import type { OmsAuth } from "./oms.types";

export type ChzOmsTokenResult =
  | { status: "ok"; auth: OmsAuth; obtainedAt: Date }
  | { status: "unconfigured" }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "undecryptable" }
  | { status: "settings_missing" };

@Injectable()
export class ChzOmsTokenService {
  private readonly logger = new Logger(ChzOmsTokenService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: ChzCryptoService,
  ) {}

  /**
   * СУЗ issues one client token per registered installation (`omsConnection`
   * in the channel settings). If the tenant has since repointed the channel
   * at a different installation, a token stored for the old one must not be
   * handed out: СУЗ would reject it, or worse, it could act on an
   * installation the tenant no longer intends to use. Reporting that case as
   * `missing` sends the caller down the same "ask the agent for a fresh
   * token" path as if nothing had ever been stored, rather than surfacing a
   * distinct, more alarming status that invites retrying with the same
   * stale credential.
   */
  async getActiveToken(tenantId: string): Promise<ChzOmsTokenResult> {
    if (!this.crypto.isConfigured()) return { status: "unconfigured" };

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
    const settings = parsed.success ? parsed.data : undefined;
    if (!settings?.omsId || !settings.omsConnection) return { status: "settings_missing" };

    const [row] = await this.db
      .select({
        encryptedToken: schema.chzOmsTokens.encryptedToken,
        tokenNonce: schema.chzOmsTokens.tokenNonce,
        tokenTag: schema.chzOmsTokens.tokenTag,
        sourceOmsConnection: schema.chzOmsTokens.sourceOmsConnection,
        obtainedAt: schema.chzOmsTokens.obtainedAt,
        expiresAt: schema.chzOmsTokens.expiresAt,
      })
      .from(schema.chzOmsTokens)
      .where(eq(schema.chzOmsTokens.tenantId, tenantId));
    if (!row) return { status: "missing" };
    if (row.sourceOmsConnection !== settings.omsConnection) return { status: "missing" };
    if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };

    let clientToken: string;
    try {
      clientToken = this.crypto.decrypt(tenantId, {
        encryptedToken: row.encryptedToken,
        tokenNonce: row.tokenNonce,
        tokenTag: row.tokenTag,
      });
    } catch {
      // A rotated encryption key or corrupted ciphertext is an
      // operator-fixable condition, not a bug. The caller needs to be able
      // to report it rather than crash.
      this.logger.warn(`Failed to decrypt ChZ OMS token for tenant: ${tenantId}`);
      return { status: "undecryptable" };
    }

    return {
      status: "ok",
      auth: {
        baseUrl: CHZ_OMS_BASE_URLS[settings.environment],
        clientToken,
        omsId: settings.omsId,
      },
      obtainedAt: row.obtainedAt,
    };
  }

  /**
   * A presence-and-expiry check that never decrypts the ciphertext, for
   * callers -- a polled endpoint -- that have no use for the plaintext
   * client token. Mirrors `ChzTokenService.hasUsableToken`'s trade-off: it
   * does not re-check the token's installation against current settings
   * either, so a stale-installation token still reads as "usable" here.
   * That gap is acceptable because nothing here hands out the token itself;
   * the one path that does, `getActiveToken`, always re-checks provenance.
   */
  async hasUsableToken(tenantId: string): Promise<boolean> {
    if (!this.crypto.isConfigured()) return false;

    const [row] = await this.db
      .select({ expiresAt: schema.chzOmsTokens.expiresAt })
      .from(schema.chzOmsTokens)
      .where(eq(schema.chzOmsTokens.tenantId, tenantId));
    if (!row) return false;
    return row.expiresAt.getTime() > Date.now();
  }

  /**
   * Removes only the token that actually received a rejection and
   * immediately asks the active signer to replace it. Matching `obtainedAt`
   * avoids deleting a fresher token the agent may have reported while the
   * failed request was in flight. The open-task unique index makes repeated
   * rejections idempotent.
   */
  async invalidateAndRequestRefresh(tenantId: string, obtainedAt: Date): Promise<void> {
    const [deleted] = await this.db
      .delete(schema.chzOmsTokens)
      .where(
        and(
          eq(schema.chzOmsTokens.tenantId, tenantId),
          eq(schema.chzOmsTokens.obtainedAt, obtainedAt),
        ),
      )
      .returning({ tenantId: schema.chzOmsTokens.tenantId });
    if (!deleted) return;
    await this.requestRefresh(tenantId);
  }

  /**
   * Idempotent refresh intent. A no-op -- not an error -- when the tenant's
   * settings cannot produce a task payload (no active signer agent, or no
   * `omsConnection` configured yet): there is nothing useful to ask the
   * agent to do.
   */
  async requestRefresh(tenantId: string): Promise<void> {
    if (!this.crypto.isConfigured()) return;

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

    const payload = buildChzOmsAuthPayload(settings);
    if (!payload) return;

    await this.db
      .insert(schema.chzSignerTasks)
      .values({ tenantId, type: "oms_auth", payload })
      .onConflictDoNothing();
  }
}
