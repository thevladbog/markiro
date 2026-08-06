import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import {
  GLOBAL_PAIR_ATTEMPT_BUDGET,
  GLOBAL_PAIR_SOURCE,
  PAIR_ATTEMPT_BUDGET,
} from "./pairing-policy";
import { normalizePairSource } from "./pair-source";

@Injectable()
export class PairAttemptsService {
  private readonly logger = new Logger(PairAttemptsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async assertUnderPairRateLimit(source: string, windowStart: Date): Promise<void> {
    const globalSoFar = await this.currentPairAttempts(GLOBAL_PAIR_SOURCE, windowStart);
    if (globalSoFar > GLOBAL_PAIR_ATTEMPT_BUDGET) {
      throw new UnauthorizedException();
    }

    if (source) {
      const normalizedSource = normalizePairSource(source);
      const sourceAttempts = await this.recordPairAttempt(normalizedSource, windowStart);
      if (sourceAttempts > PAIR_ATTEMPT_BUDGET) {
        if (sourceAttempts === PAIR_ATTEMPT_BUDGET + 1) {
          this.logger.warn(
            `device pairing per-source budget exceeded for source ${normalizedSource}: ${sourceAttempts} attempts in window`,
          );
        }
        throw new UnauthorizedException();
      }
    }

    const globalAttempts = await this.recordPairAttempt(GLOBAL_PAIR_SOURCE, windowStart);
    if (globalAttempts > GLOBAL_PAIR_ATTEMPT_BUDGET) {
      if (globalAttempts === GLOBAL_PAIR_ATTEMPT_BUDGET + 1) {
        this.logger.warn(
          `device pairing global budget exceeded: ${globalAttempts} attempts in window`,
        );
      }
      throw new UnauthorizedException();
    }
  }

  async refundPairAttempt(source: string, windowStart: Date): Promise<void> {
    if (source) {
      await this.decrementPairAttempt(normalizePairSource(source), windowStart);
    }
    await this.decrementPairAttempt(GLOBAL_PAIR_SOURCE, windowStart);
  }

  private async decrementPairAttempt(source: string, windowStart: Date): Promise<void> {
    await this.db
      .update(schema.kioskPairAttempts)
      .set({ failures: sql`GREATEST(${schema.kioskPairAttempts.failures} - 1, 0)` })
      .where(
        and(
          eq(schema.kioskPairAttempts.source, source),
          eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
        ),
      );
  }

  private async currentPairAttempts(source: string, windowStart: Date): Promise<number> {
    const [row] = await this.db
      .select({ failures: schema.kioskPairAttempts.failures })
      .from(schema.kioskPairAttempts)
      .where(
        and(
          eq(schema.kioskPairAttempts.source, source),
          eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
        ),
      );
    return row?.failures ?? 0;
  }

  private async recordPairAttempt(source: string, windowStart: Date): Promise<number> {
    const [row] = await this.db
      .insert(schema.kioskPairAttempts)
      .values({ source, windowStartedAt: windowStart, failures: 1 })
      .onConflictDoUpdate({
        target: [schema.kioskPairAttempts.source, schema.kioskPairAttempts.windowStartedAt],
        set: { failures: sql`${schema.kioskPairAttempts.failures} + 1` },
      })
      .returning({ failures: schema.kioskPairAttempts.failures });
    if (!row) throw new Error("Device pairing attempt counter did not return its updated row");
    return row.failures;
  }
}
