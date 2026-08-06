import {
  Inject,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { schema, type Auth, type Db } from "@markiro/db";
import type { AuthSetup } from "../../auth/auth.setup";
import { AUTH, DB, DB_POOL } from "../../auth/auth.module";
import { loadEnv } from "../../env";
import { hashPairingCode } from "../../pickup/device-token";
import { PairAttemptsService } from "../device-pairing/pair-attempts.service";
import {
  PAIR_CODE_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  mintPairingCode,
  pairAttemptWindowStart,
} from "../device-pairing/pairing-policy";
import { OperatorsService } from "../operators/operators.service";
import type {
  IssueStationPairingCodeResultDto,
  PairStationResultDto,
  StationPairErrorCode,
} from "./dto";

const MINT_ATTEMPTS = 5;

class StationPairingException extends UnauthorizedException {
  constructor(code: StationPairErrorCode) {
    super({ code });
  }
}

class PairClaimLostError extends Error {}

@Injectable()
export class StationPairingService {
  private readonly logger = new Logger(StationPairingService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB_POOL) private readonly pool: AuthSetup["pool"],
    private readonly operators: OperatorsService,
    private readonly pairAttempts: PairAttemptsService,
  ) {}

  async issueCode(
    tenantId: string,
    stationDeviceId: string,
    issuedByUserId: string,
  ): Promise<IssueStationPairingCodeResultDto> {
    const [station] = await this.db
      .select({ id: schema.stationDevices.id })
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, tenantId),
          eq(schema.stationDevices.id, stationDeviceId),
        ),
      );
    if (!station) throw new NotFoundException();

    await this.retireLiveCodes(tenantId, stationDeviceId);
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = mintPairingCode();
      const codeHash = hashPairingCode(code, pepper);
      const [clash] = await this.db
        .select({ id: schema.stationPairingCodes.id })
        .from(schema.stationPairingCodes)
        .where(
          and(
            eq(schema.stationPairingCodes.codeHash, codeHash),
            isNull(schema.stationPairingCodes.usedAt),
            gt(schema.stationPairingCodes.expiresAt, new Date()),
          ),
        );
      if (clash) continue;

      try {
        await this.db.insert(schema.stationPairingCodes).values({
          tenantId,
          stationDeviceId,
          codeHash,
          expiresAt,
          issuedByUserId,
        });
      } catch (error) {
        if (this.isHashCollision(error)) continue;
        if (!this.isOneLiveCodeViolation(error)) throw error;
        await this.retireLiveCodes(tenantId, stationDeviceId);
        try {
          await this.db.insert(schema.stationPairingCodes).values({
            tenantId,
            stationDeviceId,
            codeHash,
            expiresAt,
            issuedByUserId,
          });
        } catch (retryError) {
          if (this.isHashCollision(retryError)) continue;
          throw retryError;
        }
      }
      return { code, expiresAt };
    }
    throw new Error("Could not mint a unique station pairing code");
  }

  async redeem(code: string, source: string): Promise<PairStationResultDto> {
    const now = new Date();
    const windowStart = pairAttemptWindowStart(now);
    try {
      await this.pairAttempts.assertUnderPairRateLimit(source, windowStart);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw new StationPairingException("PAIR_RATE_LIMITED");
      }
      throw error;
    }

    const result = await this.attemptRedeem(code, now);
    await this.pairAttempts.refundPairAttempt(source, windowStart).catch(() => {
      this.logger.warn("station pairing refund failed after a committed redemption");
    });
    return result;
  }

  private async attemptRedeem(code: string, now: Date): Promise<PairStationResultDto> {
    const codeHash = hashPairingCode(code, loadEnv().PAIRING_CODE_PEPPER);
    const rows = await this.db
      .select()
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.codeHash, codeHash))
      .orderBy(desc(schema.stationPairingCodes.createdAt), asc(schema.stationPairingCodes.id));
    const liveRows = rows.filter(
      (row) => row.usedAt === null && row.expiresAt.getTime() > now.getTime(),
    );
    const candidate = liveRows[0] ?? rows[0];
    if (!candidate || candidate.usedAt !== null) {
      throw new StationPairingException("PAIR_INVALID");
    }
    if (candidate.attempts >= PAIR_CODE_MAX_ATTEMPTS) {
      throw new StationPairingException("PAIR_LOCKED");
    }
    if (candidate.expiresAt.getTime() <= now.getTime()) {
      await this.db
        .update(schema.stationPairingCodes)
        .set({ attempts: candidate.attempts + 1 })
        .where(
          and(
            eq(schema.stationPairingCodes.id, candidate.id),
            eq(schema.stationPairingCodes.tenantId, candidate.tenantId),
            isNull(schema.stationPairingCodes.usedAt),
          ),
        );
      throw new StationPairingException("PAIR_EXPIRED");
    }

    const [station] = await this.db
      .select({
        id: schema.stationDevices.id,
        tenantId: schema.stationDevices.tenantId,
        name: schema.stationDevices.name,
        apiKeyId: schema.stationDevices.apiKeyId,
        lineId: schema.stationDevices.lineId,
        lineName: schema.lines.name,
        organizationName: schema.organization.name,
      })
      .from(schema.stationDevices)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.stationDevices.tenantId))
      .leftJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.stationDevices.tenantId),
          eq(schema.lines.id, schema.stationDevices.lineId),
        ),
      )
      .where(
        and(
          eq(schema.stationDevices.tenantId, candidate.tenantId),
          eq(schema.stationDevices.id, candidate.stationDeviceId),
        ),
      );
    if (!station) throw new StationPairingException("PAIR_INVALID");

    // Build before the conditional claim. If an operator mirror cannot be
    // prepared, the code stays live and no candidate key exists to clean up.
    const operators = await this.operators.buildRoster(candidate.tenantId);
    const key = await this.auth.api.createApiKey({
      body: {
        configId: "station",
        organizationId: candidate.tenantId,
        userId: candidate.issuedByUserId,
        // Better Auth limits api-key display names more tightly than station
        // names. This is non-secret, stable metadata only; the durable station
        // record remains the source of its operator-provided display name.
        name: "Station device",
        metadata: { kind: "station" },
      },
    });

    try {
      // A replacement must never leave both credentials usable. This runs
      // before the durable link moves to `key.id`: if the old row cannot be
      // proven absent, the new link is not committed and the candidate is
      // compensated below.
      if (station.apiKeyId !== null) await this.deletePersistedApiKey(station.apiKeyId);

      await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(schema.stationPairingCodes)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(schema.stationPairingCodes.id, candidate.id),
              eq(schema.stationPairingCodes.tenantId, candidate.tenantId),
              isNull(schema.stationPairingCodes.usedAt),
              lt(schema.stationPairingCodes.attempts, PAIR_CODE_MAX_ATTEMPTS),
              gt(schema.stationPairingCodes.expiresAt, sql`now()`),
            ),
          )
          .returning({ id: schema.stationPairingCodes.id });
        if (!claimed) throw new PairClaimLostError();

        const [paired] = await tx
          .update(schema.stationDevices)
          .set({ apiKeyId: key.id, pairedAt: new Date(), revokedAt: null })
          .where(
            and(
              eq(schema.stationDevices.tenantId, candidate.tenantId),
              eq(schema.stationDevices.id, candidate.stationDeviceId),
              station.apiKeyId === null
                ? isNull(schema.stationDevices.apiKeyId)
                : eq(schema.stationDevices.apiKeyId, station.apiKeyId),
            ),
          )
          .returning({ id: schema.stationDevices.id });
        if (!paired) throw new PairClaimLostError();
      });
    } catch (error) {
      await this.deleteCandidateKey(key.id);
      if (error instanceof PairClaimLostError) {
        throw new StationPairingException("PAIR_INVALID");
      }
      throw error;
    }

    return {
      device: {
        id: station.id,
        name: station.name,
        tenantId: station.tenantId,
        organizationName: station.organizationName,
        line:
          station.lineId !== null && station.lineName !== null
            ? { id: station.lineId, name: station.lineName }
            : null,
      },
      credential: { apiKey: key.key, serverUrl: loadEnv().BETTER_AUTH_URL },
      operators,
    };
  }

  private async retireLiveCodes(tenantId: string, stationDeviceId: string): Promise<void> {
    await this.db
      .update(schema.stationPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.stationPairingCodes.tenantId, tenantId),
          eq(schema.stationPairingCodes.stationDeviceId, stationDeviceId),
          isNull(schema.stationPairingCodes.usedAt),
        ),
      );
  }

  private async deleteCandidateKey(keyId: string): Promise<void> {
    await this.deletePersistedApiKey(keyId);
  }

  /**
   * Better Auth's station config uses database storage, so an `apikey` row is
   * the credential itself. Prefer Drizzle for the normal path, but use the
   * already-injected pg pool as a narrow persisted fallback when that adapter
   * call fails. The fallback verifies the row is absent before returning;
   * callers therefore never suppress a cleanup failure that could leave a
   * usable credential behind.
   */
  private async deletePersistedApiKey(keyId: string): Promise<void> {
    try {
      const [deleted] = await this.db
        .delete(schema.apikey)
        .where(eq(schema.apikey.id, keyId))
        .returning({ id: schema.apikey.id });
      if (deleted) return;
    } catch {
      // The fallback below performs and verifies the same physical deletion.
    }

    try {
      await this.pool.query('DELETE FROM "apikey" WHERE "id" = $1', [keyId]);
      const remaining = await this.pool.query('SELECT 1 FROM "apikey" WHERE "id" = $1', [keyId]);
      if (remaining.rowCount === 0) return;
    } catch {
      // Do not include an api-key value, id, or database error in this public
      // failure. An unlinked key is additionally rejected by TenantGuard.
    }
    throw new InternalServerErrorException("Station credential cleanup failed");
  }

  private isOneLiveCodeViolation(error: unknown): boolean {
    return this.constraint(error) === "station_pairing_codes_one_live_uq";
  }

  private isHashCollision(error: unknown): boolean {
    return this.constraint(error) === "station_pairing_codes_code_hash_live_uq";
  }

  private constraint(error: unknown): string | undefined {
    const err = error as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const code = err.code ?? err.cause?.code;
    if (code !== "23505") return undefined;
    return err.constraint ?? err.cause?.constraint;
  }
}
