import { randomBytes, randomUUID } from "node:crypto";
import { deriveDigestB64, formatPhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { UnauthorizedException } from "@nestjs/common";

/** Тот же бюджет и то же окно, что у привязки киоска: одна и та же угроза. */
export const CHECKAUTH_BUDGET = 10;
export const CHECKAUTH_WINDOW_MS = 15 * 60_000;

export interface ExchangeCredentials {
  login: string;
  /** Показывается один раз при выпуске; в базе только хэш. */
  secret: string;
}

export function generateExchangeCredentials(): ExchangeCredentials {
  return {
    login: `mk-1c-${randomUUID().slice(0, 8)}`,
    secret: randomBytes(24).toString("base64url"),
  };
}

export async function hashExchangeSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("base64");
  return formatPhc(PHC_ITERATIONS, salt, await deriveDigestB64(secret, salt, PHC_ITERATIONS));
}

/**
 * Delegates to `@markiro/domain`'s `verifyPhc` rather than re-deriving and
 * comparing digests here: that helper already does the comparison in
 * constant time (`constantTimeEqual`) and already answers `false` for a
 * malformed/foreign verifier (`parsePhc` returns `null`). Re-implementing
 * either bit here would either duplicate it or, worse, regress to a plain
 * `===` and reopen the timing side-channel that helper exists to close.
 */
export async function verifyExchangeSecret(secret: string, phc: string): Promise<boolean> {
  return verifyPhc(secret, phc);
}

/**
 * Счётчик неудачных `checkauth`, атомарный апсерт — форма один в один с
 * `recordPairAttempt` в `pairing.service.ts` (record-then-check upsert с
 * `RETURNING`, закрывающий ту же гонку N конкурентных вызовов). Это НЕ форма
 * `assertUnderPairRateLimit` целиком: там два уровня — бюджет на источник ПЛЮС
 * глобальный backstop (`GLOBAL_PAIR_ATTEMPT_BUDGET`, ключ `"*"`), — и
 * read-only предварительная проверка (`currentPairAttempts`), которая не даёт
 * атакующему безнаказанно раздувать таблицу попыток, перебирая значения
 * `source`, когда глобальный бюджет уже исчерпан. Ни глобальный backstop, ни
 * предварительная проверка сюда НЕ перенесены — это открытый вопрос для того,
 * кто будет подключать этот счётчик к реальному `checkauth`.
 *
 * Считаются ПОПЫТКИ, а не промахи по строке: неверный логин не совпадает ни с
 * одним каналом, поэтому счётчик, инкрементируемый только при найденной
 * строке, не сработал бы вообще — ровно эта ошибка уже была допущена в
 * привязке киоска и стоила трёх раундов правок.
 */
export async function assertUnderCheckauthLimit(
  db: Db,
  source: string,
  windowStart: Date,
): Promise<void> {
  const [row] = await db
    .insert(schema.exchangeAttempts)
    .values({ source, windowStartedAt: windowStart, failures: 1 })
    .onConflictDoUpdate({
      target: [schema.exchangeAttempts.source, schema.exchangeAttempts.windowStartedAt],
      set: { failures: sql`${schema.exchangeAttempts.failures} + 1` },
    })
    .returning({ failures: schema.exchangeAttempts.failures });

  if ((row?.failures ?? 0) > CHECKAUTH_BUDGET) {
    throw new UnauthorizedException();
  }
}

/** Успешный вход возвращает потраченную попытку — иначе рабочий обмен сам себя запрёт. */
export async function refundCheckauthAttempt(
  db: Db,
  source: string,
  windowStart: Date,
): Promise<void> {
  await db
    .update(schema.exchangeAttempts)
    .set({ failures: sql`greatest(${schema.exchangeAttempts.failures} - 1, 0)` })
    .where(
      and(
        eq(schema.exchangeAttempts.source, source),
        eq(schema.exchangeAttempts.windowStartedAt, windowStart),
      ),
    );
}
