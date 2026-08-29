import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { CHZ_CHANNEL_TYPE, CHZ_TRUE_API_BASE_URLS } from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import type { TrueApiAuth } from "./true-api.types";

export type ChzTokenResult =
  | { status: "ok"; auth: TrueApiAuth }
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
    };
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
   * `getActiveToken` on the first pass and fails the order with
   * `CHZ_TOKEN_UNAVAILABLE` -- one pass later than a preflight check would
   * have caught it, which is an acceptable cost for never decrypting on a
   * read-only status poll.
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
